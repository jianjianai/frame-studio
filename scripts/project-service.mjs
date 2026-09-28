import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Workspace, fail, MAX_FILE, sha256 } from "./mcp/workspace.mjs";
import { inputManifest } from "./production-input.mjs";

/** Shared editing domain: CLI and MCP use identical operations and conflict rules. */
export class ProjectService extends Workspace {
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
      if (this.fingerprint(id) !== fingerprint) fail('VERSION_CONFLICT', 'Input changed while taking checkpoint; retry.');
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
      fs.writeFileSync(
        this.file(id, ".history/checkpoints/" + checkpoint + ".json", true),
        JSON.stringify(record),
        { flag: "wx" },
      );
      return { ...record, files: Object.keys(files), bytes };
    } finally {
      release();
    }
  }
  history(id) {
    const directory = this.file(id, ".history/checkpoints", true);
    if (!fs.existsSync(directory))
      return { checkpoints: [], fingerprint: this.fingerprint(id) };
    const checkpoints = fs
      .readdirSync(directory)
      .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
      .map((name) => {
        const record = JSON.parse(
          fs.readFileSync(
            this.file(id, ".history/checkpoints/" + name, true),
            "utf8",
          ),
        );
        return {
          checkpoint: record.checkpoint,
          label: record.label,
          time: record.time,
          fingerprint: record.fingerprint,
          files: Object.keys(record.files).length,
        };
      })
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
