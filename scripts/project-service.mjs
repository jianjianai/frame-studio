import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Workspace, fail, MAX_FILE, sha256 } from "./mcp/workspace.mjs";
import { inputManifest, fileSignature } from "./production-input.mjs";
import { checkProjects } from "./check-projects.mjs";

/** Shared editing domain: CLI and MCP use identical operations and conflict rules. */
export class ProjectService extends Workspace {
  constructor(root, options = {}) {
    super(root, options);
    this.checkOptions = options.checkOptions;
  }
  check(id) {
    if (!this.checkOptions) return super.check(id);
    this.project(id);
    this.assertTree(id);
    return checkProjects(this.root, {
      ...this.checkOptions,
      ids: [id],
      strict: true,
    });
  }
  fingerprint(id) {
    this.project(id);
    return inputManifest(this.root, id).fingerprint;
  }
  search(
    id,
    { query, directory = "", limit = 100, caseSensitive = false } = {},
  ) {
    if (typeof query !== "string" || !query.length || query.length > 1000)
      fail("INVALID_QUERY", "Use 1..1000 characters of literal text.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      fail("INVALID_LIMIT", "Limit must be 1..500.");
    const matches = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    for (const file of this.listFiles(id, { directory, limit: 10000 }).files) {
      if (
        !file.editable ||
        file.bytes > MAX_FILE ||
        file.path.startsWith("records/")
      )
        continue;
      const value = this.textFile(id, file.path);
      for (const [index, line] of value.text.split("\n").entries()) {
        if ((caseSensitive ? line : line.toLowerCase()).includes(needle)) {
          if (matches.length === limit) return { matches, truncated: true };
          matches.push({
            path: file.path,
            line: index + 1,
            text: line.slice(0, 1500),
            sha256: value.sha256,
          });
        }
      }
    }
    return { matches, truncated: false };
  }
  patch(id, changes, options = {}) {
    return this.edit(
      id,
      changes.map((change) => {
        const file = this.textFile(id, change.path);
        if (file.sha256 !== change.expectedSha256)
          fail(
            "VERSION_CONFLICT",
            "Read the current file before patching: " + change.path,
          );
        let content = file.text;
        for (const replacement of change.replacements) {
          if (!replacement.find || typeof replacement.replace !== "string")
            fail(
              "INVALID_PATCH",
              "Each replacement needs nonempty find and a replace string.",
            );
          const count = content.split(replacement.find).length - 1;
          if (count !== (replacement.count ?? 1))
            fail("PATCH_AMBIGUOUS", "Unexpected match count", {
              path: change.path,
              expected: replacement.count ?? 1,
              actual: count,
            });
          content = content.split(replacement.find).join(replacement.replace);
        }
        return {
          path: change.path,
          expectedSha256: change.expectedSha256,
          content,
        };
      }),
      options,
    );
  }
  checkpoint(id, label = "checkpoint") {
    this.writable();
    const release = this.lock(id, "checkpoint");
    try {
      const fingerprint = this.fingerprint(id);
      const files = {};
      let bytes = 0;
      for (const file of this.listFiles(id, { limit: 10000 }).files) {
        if (!file.editable || file.path.startsWith("records/")) continue;
        const value = this.textFile(id, file.path);
        bytes += value.bytes.length;
        if (Object.keys(files).length >= 400 || bytes > 32 * MAX_FILE)
          fail("TOO_LARGE", "Checkpoint limit: 400 text files / 32 MiB.");
        files[file.path] = { content: value.text, sha256: value.sha256 };
      }
      const checkpoint = randomUUID();
      if (this.fingerprint(id) !== fingerprint)
        fail(
          "VERSION_CONFLICT",
          "Input changed while taking checkpoint; retry.",
        );
      const record = {
        schemaVersion: 1,
        checkpoint,
        label,
        time: new Date().toISOString(),
        fingerprint,
        files,
      };
      const directory = this.file(id, ".history/checkpoints", true);
      fs.mkdirSync(directory, { recursive: true });
      const target = this.file(
        id,
        ".history/checkpoints/" + checkpoint + ".json",
        true,
      );
      const temporary = this.file(
        id,
        ".history/checkpoints/" + checkpoint + ".tmp",
        true,
      );
      try {
        fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx" });
        if (fs.existsSync(target))
          throw Object.assign(new Error("Checkpoint already exists"), {
            code: "EEXIST",
          });
        // The generated UUID is exclusively owned by this operation. Publish a
        // complete body so concurrent history readers never parse partial JSON.
        fs.renameSync(temporary, target);
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      this.writeCheckpointMetadata(id, checkpoint, record);
      return { ...record, files: Object.keys(files), bytes };
    } finally {
      release();
    }
  }
  writeCheckpointMetadata(id, checkpoint, record, expectedSignature) {
    const file = this.file(
      id,
      ".history/checkpoints/" + checkpoint + ".json",
      true,
    );
    const signature = fileSignature(fs.lstatSync(file, { bigint: true }));
    if (expectedSignature && signature !== expectedSignature)
      fail(
        "VERSION_CONFLICT",
        "Checkpoint changed while reading history; retry.",
      );
    const metadata = {
      schemaVersion: 1,
      signature,
      summary: {
        checkpoint: record.checkpoint,
        label: record.label,
        time: record.time,
        fingerprint: record.fingerprint,
        files: Object.keys(record.files).length,
      },
    };
    const directory = this.file(id, ".history/checkpoint-metadata", true);
    const target = this.file(
      id,
      ".history/checkpoint-metadata/" + checkpoint + ".json",
      true,
    );
    const temporary = this.file(
      id,
      ".history/checkpoint-metadata/" +
        checkpoint +
        "-" +
        randomUUID() +
        ".tmp",
      true,
    );
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx" });
      fs.renameSync(temporary, target);
    } catch (error) {
      // This is a rebuildable read cache, including in read-only mounted workspaces.
      // Cache write failure must not turn a saved checkpoint into a failed edit.
      if (!["EACCES", "EROFS", "ENOSPC", "EDQUOT"].includes(error.code))
        throw error;
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return metadata.summary;
  }
  checkpointMetadata(id, name) {
    const checkpoint = name.slice(0, -5);
    const file = this.file(id, ".history/checkpoints/" + name, true);
    const signature = fileSignature(fs.lstatSync(file, { bigint: true }));
    const target = this.file(id, ".history/checkpoint-metadata/" + name, true);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isFile() && stat.size <= 8192) {
        const metadata = JSON.parse(fs.readFileSync(target, "utf8"));
        const summary = metadata.summary;
        if (
          metadata.schemaVersion === 1 &&
          metadata.signature === signature &&
          /^[a-f0-9-]{36}$/.test(summary?.checkpoint ?? "") &&
          typeof summary.label === "string" &&
          typeof summary.time === "string" &&
          /^[a-f0-9]{64}$/.test(summary.fingerprint) &&
          Number.isInteger(summary.files) &&
          summary.files >= 0 &&
          summary.files <= 400 &&
          fileSignature(fs.lstatSync(file, { bigint: true })) === signature
        )
          return summary;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (fileSignature(fs.lstatSync(file, { bigint: true })) !== signature)
      fail(
        "VERSION_CONFLICT",
        "Checkpoint changed while reading history; retry.",
      );
    return this.writeCheckpointMetadata(id, checkpoint, record, signature);
  }
  history(id) {
    const directory = this.file(id, ".history/checkpoints", true);
    if (!fs.existsSync(directory))
      return { checkpoints: [], fingerprint: this.fingerprint(id) };
    const checkpoints = fs
      .readdirSync(directory)
      .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
      .map((name) => this.checkpointMetadata(id, name))
      .sort((a, b) => b.time.localeCompare(a.time));
    return { checkpoints, fingerprint: this.fingerprint(id) };
  }
  restore(id, checkpoint, expectedFingerprint, dryRun = true) {
    this.writable();
    if (!/^[\da-f-]{36}$/.test(checkpoint))
      fail("INVALID_CHECKPOINT", "Use a checkpoint id from history.");
    if (this.fingerprint(id) !== expectedFingerprint)
      fail("VERSION_CONFLICT", "Input changed; inspect history and retry.");
    const record = JSON.parse(
      fs.readFileSync(
        this.file(id, ".history/checkpoints/" + checkpoint + ".json", true),
        "utf8",
      ),
    );
    const names = new Set([
      ...Object.keys(record.files),
      ...this.listFiles(id, { limit: 10000 })
        .files.filter(
          (file) => file.editable && !file.path.startsWith("records/"),
        )
        .map((file) => file.path),
    ]);
    const changes = [];
    for (const name of names) {
      const before = this.textFile(id, name, { missing: true });
      const after = record.files[name];
      if (after && sha256(Buffer.from(after.content, "utf8")) !== after.sha256)
        fail("CORRUPT_CHECKPOINT", "Checkpoint content hash mismatch");
      if ((before?.sha256 ?? null) !== (after?.sha256 ?? null))
        changes.push({
          path: name,
          expectedSha256: before?.sha256 ?? null,
          content: after?.content ?? null,
        });
    }
    if (!changes.length)
      return { applied: false, changes: [], fingerprint: expectedFingerprint };
    return this.edit(id, changes, { dryRun, restoring: true });
  }
  edit(id, changes, options = {}) {
    // Validate the proposal before preserving a version; failed dry runs create no history.
    super.edit(id, changes, { ...options, dryRun: true });
    if (options.dryRun) return super.edit(id, changes, options);
    const checkpoint = this.checkpoint(id, "Before edit");
    return {
      ...super.edit(id, changes, options),
      checkpoint: checkpoint.checkpoint,
      fingerprint: this.fingerprint(id),
    };
  }
}
