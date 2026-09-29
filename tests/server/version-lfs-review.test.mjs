import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { snapshotVersion } from "../../server/version-review.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-history-lfs-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@local");
  git("config", "core.autocrlf", "false");
  const dir = path.join(root, "projects/test-film");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  const bytes = Buffer.from([0, 255, 254, 13, 10, 0, 88, 52]),
    oid = createHash("sha256").update(bytes).digest("hex");
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
  fs.writeFileSync(
    path.join(dir, "project.ts"),
    'export default {id:"test-film"};',
  );
  fs.writeFileSync(path.join(dir, "public/voice.wav"), pointer);
  git("add", "--", "projects");
  git("commit", "-m", "LFS media");
  const version = git("rev-parse", "HEAD");
  const object = path.join(
    root,
    ".git/lfs/objects",
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid,
  );
  const save = () => {
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(object, bytes);
  };
  const calls = [];
  const repos = {
    project: async () => ({ repo: { root }, dir }),
    git: async (_root, args, auth) => {
      calls.push({ args, auth });
      if (args.includes("fetch")) {
        save();
        return "";
      }
      return git(...args);
    },
  };
  return {
    root,
    dir,
    bytes,
    object,
    version,
    pointer,
    repos,
    calls,
    save,
    git,
    work: { repo: randomUUID(), project: "test-film" },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
for (const cached of [true, false])
  test(`historical preview materializes verified LFS audio (${cached ? "cached" : "scoped fetch"}) without touching current work`, async () => {
    const f = fixture();
    try {
      if (cached) f.save();
      const dest = path.join(f.root, "snapshot");
      await snapshotVersion(f.repos, f.work, f.version, dest);
      assert.deepEqual(
        fs.readFileSync(path.join(dest, "public/voice.wav")),
        f.bytes,
      );
      assert.equal(
        fs.readFileSync(path.join(f.dir, "public/voice.wav"), "utf8"),
        f.pointer,
      );
      assert.equal(f.git("rev-parse", "HEAD"), f.version);
      const fetches = f.calls.filter((c) => c.args.includes("fetch"));
      assert.equal(fetches.length, cached ? 0 : 1);
      if (!cached) {
        assert(fetches[0].args.includes("--include=projects/test-film/**"));
        assert(fetches[0].args.includes(f.version));
        assert.equal(fetches[0].auth, true);
      }
    } finally {
      f.close();
    }
  });
test("historical LFS pointer cannot silently publish a corrupt media blob", async () => {
  const f = fixture();
  try {
    f.save();
    fs.writeFileSync(f.object, Buffer.alloc(f.bytes.length, 4));
    await assert.rejects(
      snapshotVersion(
        f.repos,
        f.work,
        f.version,
        path.join(f.root, "snapshot"),
      ),
      /内容校验失败/,
    );
    assert.equal(f.git("rev-parse", "HEAD"), f.version);
  } finally {
    f.close();
  }
});
