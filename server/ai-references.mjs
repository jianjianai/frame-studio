import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  confinedAsync,
  exists,
  fileSha256,
  treeHash,
} from "./project-files.mjs";
import { versionTree } from "./version-review.mjs";
import { liveReviewSnapshotPath } from "./live-review-snapshot.mjs";
import { problem } from "./security.mjs";

const excluded = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".history",
  "exports",
]);
const sourceFile = (relative) =>
  !relative.startsWith("public/") &&
  /\.(?:tsx?|jsx?|[cm]js|json|css|scss|sass|html|md|txt|py|glsl|wgsl|vert|frag|toml|ya?ml)$/i.test(
    relative,
  );
const safeFile = (relative) =>
  !relative
    .split("/")
    .some(
      (part) =>
        excluded.has(part) || part === ".env" || part.startsWith(".env."),
    );
const SHA = /^[a-f0-9]{64}$/;
const pending = new Map();
const maxCode = 16 * 1024 * 1024;
async function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw problem(413, "Frozen reference manifest is too large");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyExisting(folder, identity) {
  const manifestFile = await confinedAsync(folder, "manifest.json");
  if ((await fs.stat(manifestFile)).size > 8 * 1024 * 1024)
    throw problem(413, "Frozen reference manifest is too large");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  for (const key of ["workId", "threadId", "messageId", "intentHash"])
    if (manifest[key] !== identity[key])
      throw problem(
        409,
        "Frozen reference folder belongs to a different message intent",
      );
  for (const entry of manifest.files) {
    if (!SHA.test(entry.sha256 || ""))
      throw problem(409, "Frozen reference manifest is invalid");
    if (
      entry.copied &&
      (await fileSha256(
        await confinedAsync(folder, "source/" + entry.path),
      )) !== entry.sha256
    )
      throw problem(409, "Frozen reference source was modified");
  }
  return manifest;
}
async function readGitBlob(
  root,
  oid,
  { copy = false, maximum = maxCode } = {},
) {
  const child = spawn("git", ["cat-file", "blob", oid], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let error = "",
    size = 0;
  const digest = createHash("sha256"),
    chunks = [],
    prefix = [];
  let prefixSize = 0;
  child.stderr.on("data", (value) => {
    error = (error + value).slice(-2000);
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Cannot read frozen Git reference")),
    );
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  try {
    await Promise.all([
      exit,
      (async () => {
        for await (const chunk of child.stdout) {
          size += chunk.length;
          digest.update(chunk);
          if (copy) {
            if (size > maximum) {
              child.kill("SIGKILL");
              throw problem(413, "Frozen reference code exceeds 16 MiB");
            }
            chunks.push(chunk);
          }
          if (prefixSize < 1024) {
            const slice = chunk.subarray(0, 1024 - prefixSize);
            prefix.push(slice);
            prefixSize += slice.length;
          }
        }
      })(),
    ]);
    const text = size < 1024 ? Buffer.concat(prefix).toString("utf8") : "";
    const lfs =
      /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n$/.exec(
        text,
      );
    if (lfs && copy)
      throw problem(409, "Frozen reference code is an unresolved LFS pointer");
    return {
      sha256: lfs?.[1] || digest.digest("hex"),
      bytes: lfs?.[2] || String(size),
      ...(copy ? { code: Buffer.concat(chunks) } : {}),
    };
  } catch (failure) {
    child.kill("SIGKILL");
    await exit.catch(() => {});
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function exportReference({
  data,
  work,
  threadId,
  messageId,
  intentHash,
  reference,
  repos,
  materials = [],
}) {
  z.uuid().parse(work.id);
  z.uuid().parse(messageId);
  z.string().min(1).max(256).parse(threadId);
  z.string().regex(SHA).parse(intentHash);
  z.string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64)
    .parse(work.project);
  const parent = await confinedAsync(
    data,
    "ai/" + work.id + "/references/messages",
  );
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const folder = await confinedAsync(
    data,
    "ai/" + work.id + "/references/messages/" + messageId,
  );
  const identity = { workId: work.id, threadId, messageId, intentHash };
  if (await exists(folder))
    return { folder, manifest: await verifyExisting(folder, identity) };
  const stage = await confinedAsync(
    data,
    "ai/" +
      work.id +
      "/references/messages/." +
      messageId +
      "-" +
      randomUUID(),
  );
  await fs.mkdir(path.join(stage, "source"), { recursive: true, mode: 0o700 });
  const files = [];
  let codeBytes = 0;
  try {
    if (reference?.mode === "live") {
      const expected = liveReviewSnapshotPath(reference, work.project);
      if (reference.snapshotPath !== expected)
        throw problem(400, "Invalid frozen reference source");
      const source = await confinedAsync(data, expected);
      if (
        (await treeHash(source, { includeIgnored: true })) !==
        reference.fingerprint
      )
        throw problem(409, "Frozen live source changed");
      const walk = async (relative = "") => {
        const directory = relative
          ? await confinedAsync(source, relative)
          : source;
        for (const name of (await fs.readdir(directory)).sort()) {
          const rel = relative ? relative + "/" + name : name;
          if (!safeFile(rel)) continue;
          const file = await confinedAsync(source, rel),
            stat = await fs.lstat(file);
          if (stat.isDirectory()) {
            await walk(rel);
            continue;
          }
          const sha256 = await fileSha256(file),
            copied = sourceFile(rel);
          files.push({ path: rel, sha256, bytes: String(stat.size), copied });
          if (files.length > 20000)
            throw problem(413, "Frozen reference contains too many files");
          if (copied) {
            codeBytes += stat.size;
            if (codeBytes > maxCode)
              throw problem(413, "Frozen reference code exceeds 16 MiB");
            const target = await confinedAsync(stage, "source/" + rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(file, target);
            await fs.chmod(target, 0o600);
            if ((await fileSha256(target)) !== sha256)
              throw problem(409, "Source changed during reference export");
          }
        }
      };
      await walk();
      if (
        (await treeHash(source, { includeIgnored: true })) !==
        reference.fingerprint
      )
        throw problem(409, "Frozen live source changed");
    } else if (reference?.status === "versioned" && reference.sourceCommit) {
      const tree = await versionTree(
        repos,
        { repo: work.repo, project: work.project },
        reference.sourceCommit,
      );
      for (const entry of tree.entries.filter((entry) =>
        safeFile(entry.path),
      )) {
        const copied = sourceFile(entry.path);
        const blob = await readGitBlob(tree.root, entry.oid, {
          copy: copied,
          maximum: maxCode - codeBytes,
        });
        files.push({
          path: entry.path,
          sha256: blob.sha256,
          bytes: blob.bytes,
          copied,
        });
        if (copied) {
          codeBytes += blob.code.length;
          const target = await confinedAsync(stage, "source/" + entry.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, blob.code, { mode: 0o600, flag: "wx" });
        }
      }
    }
    const manifest = {
      version: 1,
      ...identity,
      project: work.project,
      reviewReference: reference
        ? Object.fromEntries(
            [
              "status",
              "mode",
              "sourceRevision",
              "compiledRevision",
              "sourceCommit",
              "liveSessionId",
              "fingerprint",
              "shotId",
            ]
              .filter((key) => reference[key] !== undefined)
              .map((key) => [key, reference[key]]),
          )
        : { status: "unversioned" },
      files,
      materials,
    };
    await writeJson(path.join(stage, "manifest.json"), manifest);
    try {
      await fs.rename(stage, folder);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      return { folder, manifest: await verifyExisting(folder, identity) };
    }
    return { folder, manifest };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

/** Code and a media manifest are readable in the sandbox; full media stays in the retained snapshot. */
export async function exportAiReference(options) {
  const key =
    path.resolve(options.data) +
    ":" +
    options.work.id +
    ":" +
    options.messageId;
  const previous = pending.get(key) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => exportReference(options));
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
