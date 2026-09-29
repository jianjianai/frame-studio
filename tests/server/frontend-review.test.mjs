import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  versionTree,
  compareVersion,
  snapshotVersion,
} from "../../server/version-review.mjs";
import { speechOperations } from "../../server/speech.mjs";

function gitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-version-review-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const dir = path.join(root, "projects/test-film");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.ts"),
    'export default {id:"test-film"};\n',
  );
  const binary = Buffer.from([0, 255, 0, 10, 13, 125, 88]);
  fs.writeFileSync(path.join(dir, "public/audio.bin"), binary);
  git("add", "--", "projects");
  git("commit", "-m", "Initial scene");
  const version = git("rev-parse", "HEAD");
  const repos = {
    project: async () => ({ repo: { root }, dir }),
    git: async (_root, args) => git(...args),
  };
  return {
    root,
    git,
    dir,
    version,
    repos,
    binary,
    work: { repo: randomUUID(), project: "test-film" },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
test("historical review copies immutable binary blobs without changing worktree, index or HEAD", async () => {
  const f = gitFixture();
  try {
    fs.writeFileSync(
      path.join(f.dir, "project.ts"),
      'export default {id:"test-film",duration:8};\n',
    );
    fs.writeFileSync(path.join(f.dir, "new.txt"), "untracked input");
    const before = f.git("status", "--porcelain"),
      head = f.git("rev-parse", "HEAD");
    const comparison = await compareVersion(f.repos, f.work, f.version);
    assert.equal(comparison.comparison, "selected-to-current");
    assert(
      comparison.changes.some(
        (item) => item.path === "project.ts" && item.status === "M",
      ),
    );
    assert(
      comparison.changes.some(
        (item) => item.path === "new.txt" && item.status === "A",
      ),
    );
    const destination = path.join(f.root, "snapshot");
    await snapshotVersion(f.repos, f.work, f.version, destination);
    assert.deepEqual(
      fs.readFileSync(path.join(destination, "public/audio.bin")),
      f.binary,
    );
    assert.equal(
      fs.readFileSync(path.join(destination, "project.ts"), "utf8"),
      'export default {id:"test-film"};\n',
    );
    assert.equal(f.git("status", "--porcelain", "--", "projects"), before);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    await assert.rejects(
      snapshotVersion(f.repos, f.work, f.version, destination),
      /已存在/,
    );
  } finally {
    f.close();
  }
});
test("historical review rejects invalid revision and foreign commits", async () => {
  const f = gitFixture();
  try {
    await assert.rejects(versionTree(f.repos, f.work, "HEAD~1"), /当前作品/);
    f.git("checkout", "-b", "unmerged");
    fs.writeFileSync(path.join(f.dir, "other.txt"), "foreign");
    f.git("add", "--", "projects");
    f.git("commit", "-m", "foreign");
    const foreign = f.git("rev-parse", "HEAD");
    f.git("checkout", "main");
    await assert.rejects(versionTree(f.repos, f.work, foreign), /不属于/);
  } finally {
    f.close();
  }
});
test("historical review refuses symlink tree entries even when the host does not support symlinks", async () => {
  const f = gitFixture();
  try {
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: f.root,
      input: "../../outside\n",
      encoding: "utf8",
    }).trim();
    f.git(
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${oid},projects/test-film/unsafe`,
    );
    f.git("commit", "-m", "link fixture");
    await assert.rejects(
      versionTree(f.repos, f.work, f.git("rev-parse", "HEAD")),
      /链接/,
    );
  } finally {
    f.close();
  }
});
function auditionFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-adopt-review-"));
  const registry = new Map(),
    settings = new Map(),
    registered = [];
  let attachments = 0;
  const id = randomUUID(),
    asset = { id: randomUUID(), deleted: false, name: "旁白.wav" };
  const relative = "projects/speech-test/exports/preview.wav",
    file = path.join(data, "runs", id, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from("RIFFexact-audition-wave-bytes");
  fs.writeFileSync(file, bytes);
  const task = {
    id,
    state: "succeeded",
    kind: "speech-test",
    expires: new Date(Date.now() + 86400000).toISOString(),
    result: {
      speech: {
        mime: "audio/wav",
        name: "Fixture",
        license: "Fixture original",
      },
      artifacts: [{ path: relative }],
    },
  };
  const db = {
    lock: async (_key, fn) => fn(),
    one: async () => task,
    all: async () => [],
    setting: async (key, value) => {
      if (value !== undefined) settings.set(key, value);
      return settings.get(key);
    },
    pool: { query: async () => ({ rows: [] }) },
  };
  const assets = {
    get: async () => asset,
    register: async (file, options) => {
      registered.push({ bytes: fs.readFileSync(file), options });
      return asset;
    },
    attach: async () => {
      attachments++;
    },
  };
  speechOperations({
    add: (name, _description, _shape, fn) => registry.set(name, fn),
    db,
    data,
    secrets: { decrypt: (x) => x, encrypt: (x) => x },
    assets,
  });
  return {
    data,
    task,
    bytes,
    registered,
    asset,
    adopt: registry.get("speech_adopt"),
    args: {
      task: id,
      repo: randomUUID(),
      project: "test-film",
      name: "已确认旁白",
    },
    close: () => fs.rmSync(data, { recursive: true, force: true }),
  };
}
test("adoption preserves exact audition bytes and repeated submission does not synthesize/register twice", async () => {
  const f = auditionFixture();
  try {
    const first = await f.adopt(f.args),
      second = await f.adopt(f.args);
    assert.equal(first.resynthesized, false);
    assert.equal(first.asset.id, second.asset.id);
    assert.equal(f.registered.length, 1);
    assert.deepEqual(f.registered[0].bytes, f.bytes);
    assert.match(f.registered[0].options.license, /Fixture original/);
  } finally {
    f.close();
  }
});
test("expired, cleaned and legacy auditions cannot be adopted as current results", async () => {
  const f = auditionFixture();
  try {
    f.task.expires = new Date(0).toISOString();
    await assert.rejects(f.adopt(f.args), /过期/);
    f.task.expires = new Date(Date.now() + 86400000).toISOString();
    f.task.cleaned = new Date().toISOString();
    await assert.rejects(f.adopt(f.args), /过期/);
    f.task.cleaned = null;
    delete f.task.result.speech;
    await assert.rejects(f.adopt(f.args), /旧版本/);
    assert.equal(f.registered.length, 0);
  } finally {
    f.close();
  }
});
