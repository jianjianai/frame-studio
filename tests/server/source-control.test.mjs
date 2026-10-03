import test from "node:test";
import { Repositories } from "../../server/repositories.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  SourceControl,
  parseSourceStatus,
} from "../../server/source-control.mjs";

function fixture(t, { unborn = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-scm-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  const gitAt = (dir, ...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => gitAt(cwd, ...args);
  git("init", "-b", "works/test-film");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const prefix = "projects/test-film/",
    work = {
      id: randomUUID(),
      repo: randomUUID(),
      project: "test-film",
      branch: "works/test-film",
    };
  const write = (file, content) => {
    const target = path.join(cwd, prefix, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("project.ts", 'export default {id:"test-film"};\n');
  write("scene.ts", "const value = 1;\nconst stable = true;\n");
  write("audio.ts", "const tone = 440;\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Work\n");
  if (!unborn) {
    git("add", "--", "projects/test-film", "README.md");
    git("commit", "-m", "Initial work");
  }
  let busy = null,
    fetchError = null,
    changed = 0;
  const locks = [],
    commands = [],
    repo = { root: cwd, url: "", branch: work.branch };
  const repos = {
    project: async () => ({ repo, dir: path.join(cwd, prefix) }),
    writable: async () => {
      if (busy) throw Object.assign(Error("busy"), { statusCode: 409 });
    },
    revisions: {
      invalidate: async () => {
        changed++;
      },
    },
    onChange: async () => {
      changed++;
    },
    git: async (_root, args) => {
      commands.push(args);
      return git(...args);
    },
    status: async (_id, { fetch = false, prune = false } = {}) => {
      if (fetch) {
        if (fetchError) return { error: fetchError };
        git(
          "fetch",
          ...(prune ? ["--prune"] : []),
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
        );
        work.sync_state = { checked: new Date().toISOString() };
      }
      return { error: null };
    },
  };
  const db = {
    lock: async (key, fn) => {
      locks.push(key);
      return fn();
    },
    one: async (sql) => sql.includes("FROM tasks") ? busy : null,
  };
  const scm = new SourceControl({
    db,
    repos,
    works: { get: async () => work },
  });
  const status = () => scm.status(work.id);
  const change = async (action, files = [], extra = {}) =>
    scm.change({
      id: work.id,
      action,
      paths: files.map((file) => prefix + file),
      expectedRevision: (await status()).revision,
      ...extra,
    });
  const remote = () => {
    const bare = path.join(root, "remote.git");
    fs.mkdirSync(bare);
    gitAt(bare, "init", "--bare");
    git("remote", "add", "origin", bare);
    repo.url = bare;
    return bare;
  };
  const other = () => {
    const dir = path.join(root, "other");
    gitAt(root, "clone", "-b", work.branch, repo.url, dir);
    gitAt(dir, "config", "user.name", "Other");
    gitAt(dir, "config", "user.email", "other@example.invalid");
    return dir;
  };
  const sync = async (action) =>
    scm.sync({
      id: work.id,
      action,
      expectedRevision: (await status()).revision,
    });
  return {
    root,
    cwd,
    git,
    gitAt,
    work,
    repo,
    prefix,
    write,
    status,
    change,
    scm,
    locks,
    commands,
    remote,
    other,
    sync,
    busy: (value) => {
      busy = value;
    },
    fetchError: (value) => {
      fetchError = value;
    },
    changed: () => changed,
  };
}

test("SCM porcelain v2 preserves spaces, unicode, renames and unmerged states", () => {
  const rows = parseSourceStatus(
    "? projects/test-film/中文 name.txt\0" +
      "2 R. N... 100644 100644 100644 abc def R100 projects/test-film/new name\0projects/test-film/old name\0" +
      "u UU N... 100644 100644 100644 100644 a b c projects/test-film/conflict\0",
  );
  assert.equal(rows[0].path, "projects/test-film/中文 name.txt");
  assert.equal(rows[1].originalPath, "projects/test-film/old name");
  assert.equal(rows[2].conflict, true);
});
test("SCM reads accurate staged and unstaged text, preserving whitespace and source", async (t) => {
  const f = fixture(t);
  f.write("scene.ts", "const value = 2;\nconst stable = true;\n");
  await f.change("stage", ["scene.ts"]);
  f.write("scene.ts", "const value = 3;\nconst stable = true;\n  ");
  const before = f.git("status", "--porcelain");
  const status = await f.status();
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 1);
  const staged = await f.scm.diff({
    id: f.work.id,
    path: f.prefix + "scene.ts",
    area: "staged",
  });
  const working = await f.scm.diff({
    id: f.work.id,
    path: f.prefix + "scene.ts",
  });
  assert.match(staged.patch, /-const value = 1;\n\+const value = 2;/);
  assert.match(working.patch, /-const value = 2;\n\+const value = 3;/);
  assert.match(working.patch, /\+  \n/);
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(f.commands.length, 1, "reads must not run write commands");
});
test("SCM commit includes only staged files and unstage never overwrites working changes", async (t) => {
  const f = fixture(t);
  f.write("scene.ts", "staged\n");
  f.write("audio.ts", "uncommitted\n");
  await f.change("stage", ["scene.ts"]);
  f.write("scene.ts", "later edit\n");
  await f.change("commit", [], { message: "Selected source" });
  assert.equal(f.git("show", "HEAD:" + f.prefix + "scene.ts"), "staged");
  assert.equal(
    f.git("show", "HEAD:" + f.prefix + "audio.ts"),
    "const tone = 440;",
  );
  await f.change("stage", ["scene.ts"]);
  await f.change("unstage", ["scene.ts"]);
  assert.equal(
    fs.readFileSync(path.join(f.cwd, f.prefix, "scene.ts"), "utf8"),
    "later edit\n",
  );
  assert.equal((await f.status()).staged, 0);
  assert(f.locks.every((key) => key === f.work.repo + ":test-film"));
});
test("SCM stale same-status edits and busy tasks are rejected before mutation", async (t) => {
  const f = fixture(t);
  f.write("scene.ts", "first\n");
  const old = await f.status();
  f.write("scene.ts", "second same kind\n");
  await assert.rejects(
    f.change("stage", ["scene.ts"], { expectedRevision: old.revision }),
    /已变化/,
  );
  f.busy({ id: "busy", state: "running", kind: "render" });
  assert.match((await f.status()).blocked, /只读/);
  await assert.rejects(f.change("stage", ["scene.ts"]), /busy/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});
test("SCM discard requires confirmation, targets one file, and preserves the index", async (t) => {
  const f = fixture(t);
  f.write("scene.ts", "staged\n");
  await f.change("stage", ["scene.ts"]);
  f.write("scene.ts", "newer\n");
  await assert.rejects(f.change("discard", ["scene.ts"]), /确认/);
  await f.change("discard", ["scene.ts"], { confirm: true });
  assert.equal(
    fs.readFileSync(path.join(f.cwd, f.prefix, "scene.ts"), "utf8"),
    "staged\n",
  );
  assert.equal((await f.status()).staged, 1);
  f.write("untracked.txt", "new");
  await f.change("discard", ["untracked.txt"], { confirm: true });
  assert(!fs.existsSync(path.join(f.cwd, f.prefix, "untracked.txt")));
});
test("SCM paths are literal: brackets, leading dashes, spaces and unicode", async (t) => {
  const f = fixture(t);
  f.write("[draft] 中文.txt", "  whitespace\n");
  f.write("-option.txt", "keep");
  const diff = await f.scm.diff({
    id: f.work.id,
    path: f.prefix + "[draft] 中文.txt",
  });
  assert.match(diff.patch, /\+  whitespace/);
  await f.change("stage", ["[draft] 中文.txt"]);
  assert.equal((await f.status()).staged, 1);
  await f.change("commit", [], { message: "Unicode source" });
  assert.equal(
    f.git("show", "HEAD:" + f.prefix + "[draft] 中文.txt"),
    "whitespace",
  );
  assert.equal((await f.status()).unstaged, 1);
});
test("SCM staged renames, deletions and unstage preserve both paths", async (t) => {
  const f = fixture(t);
  f.git("mv", f.prefix + "scene.ts", f.prefix + "new scene.ts");
  const entry = (await f.status()).files.find((file) => file.status === "R");
  assert.equal(entry.originalPath, f.prefix + "scene.ts");
  const diff = await f.scm.diff({
    id: f.work.id,
    path: entry.path,
    area: "staged",
  });
  assert.equal(diff.before.kind, "text");
  assert.equal(diff.after.kind, "text");
  await f.change("unstage", ["new scene.ts"]);
  assert(fs.existsSync(path.join(f.cwd, f.prefix, "new scene.ts")));
  assert(!fs.existsSync(path.join(f.cwd, f.prefix, "scene.ts")));
  await f.change("stage", ["scene.ts"]);
  await f.change("commit", [], { message: "Delete old scene" });
  assert.equal(f.git("ls-tree", "HEAD", "--", f.prefix + "scene.ts"), "");
});
test("SCM rejects cross-work paths, path traversal, ignored internals and foreign staged content", async (t) => {
  const f = fixture(t);
  f.write("scene.ts", "edit");
  for (const file of [
    "../outside",
    "projects/other/scene.ts",
    f.prefix + "../other/a",
    f.prefix + ".env",
    f.prefix + "exports/video.mp4",
  ]) {
    await assert.rejects(
      f.scm.diff({ id: f.work.id, path: file }),
      /path|当前作品/,
    );
  }
  fs.mkdirSync(path.join(f.cwd, "projects/other"));
  fs.writeFileSync(path.join(f.cwd, "projects/other/secret.txt"), "foreign");
  f.git("add", "--", "projects/other");
  await f.change("stage", ["scene.ts"]);
  const status = await f.status();
  assert.equal(status.outside, 1);
  assert(!status.files.some((entry) => entry.path.includes("other")));
  await assert.rejects(
    f.change("commit", [], { message: "Must not leak" }),
    /之外/,
  );
});
test("SCM refuses symlink/hardlink reads and historical symlink content", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "sensitive");
  fs.writeFileSync(outside, "do-not-return");
  fs.symlinkSync(outside, path.join(f.cwd, f.prefix, "link.txt"));
  fs.linkSync(outside, path.join(f.cwd, f.prefix, "hard.txt"));
  for (const file of ["link.txt", "hard.txt"]) {
    assert(
      (await f.status()).files.find((entry) => entry.path === f.prefix + file)
        .unsafe,
    );
    await assert.rejects(
      f.scm.diff({ id: f.work.id, path: f.prefix + file }),
      /链接|path|Links/,
    );
  }
  f.git("add", "--", f.prefix + "link.txt");
  f.git("commit", "-m", "Legacy symlink");
  const diff = await f.scm.diff({
    id: f.work.id,
    path: f.prefix + "link.txt",
    area: "commit",
    version: f.git("rev-parse", "HEAD"),
  });
  assert.equal(diff.after.kind, "unsupported");
  assert(!JSON.stringify(diff).includes("do-not-return"));
});
test("SCM binary, LFS and oversized files return bounded metadata", async (t) => {
  const f = fixture(t);
  f.write("binary.bin", Buffer.from([0, 255, 1]));
  f.write("large.txt", "x".repeat(220000));
  f.write(
    "pointer.wav",
    "version https://git-lfs.github.com/spec/v1\noid sha256:" +
      "a".repeat(64) +
      "\nsize 1234567\n",
  );
  for (const [file, kind] of [
    ["binary.bin", "binary"],
    ["large.txt", "large"],
    ["pointer.wav", "lfs"],
  ]) {
    const diff = await f.scm.diff({ id: f.work.id, path: f.prefix + file });
    assert.equal(diff.after.kind, kind);
    assert.equal(diff.patch, "");
    assert.equal(diff.after.text, undefined);
  }
});
test("SCM commit file history is immutable and rejects unrelated revisions", async (t) => {
  const f = fixture(t);
  const first = f.git("rev-parse", "HEAD");
  f.write("scene.ts", "committed\n");
  await f.change("stage", ["scene.ts"]);
  await f.change("commit", [], { message: "Second" });
  const version = f.git("rev-parse", "HEAD");
  f.write("scene.ts", "current\n");
  const info = await f.scm.commit(f.work.id, version);
  assert.equal(info.parent, first);
  assert.equal(info.files.length, 1);
  const diff = await f.scm.diff({
    id: f.work.id,
    path: f.prefix + "scene.ts",
    area: "commit",
    version,
  });
  assert.match(diff.patch, /\+committed/);
  assert(!diff.patch.includes("+current"));
  const root = await f.scm.commit(f.work.id, first);
  assert.equal(root.parent, null);
  assert(root.files.length >= 3);
  await assert.rejects(f.scm.commit(f.work.id, "a".repeat(40)));
});
test("SCM unborn branches can unstage and create their first commit", async (t) => {
  const f = fixture(t, { unborn: true });
  assert.equal((await f.status()).head, null);
  await f.change("stage", ["scene.ts"]);
  f.write("scene.ts", "later working edit\n");
  await f.change("unstage", ["scene.ts"]);
  assert.equal((await f.status()).staged, 0);
  assert.equal(fs.readFileSync(path.join(f.cwd, f.prefix, "scene.ts"), "utf8"), "later working edit\n");
  await f.change("stage", ["scene.ts", "project.ts"]);
  await f.change("commit", [], { message: "First" });
  assert((await f.status()).head);
});
test("SCM detached or unexpected branch cannot be mutated", async (t) => {
  const f = fixture(t);
  f.git("switch", "--detach");
  f.write("scene.ts", "edit");
  assert.match((await f.status()).blocked, /分支/);
  await assert.rejects(f.change("stage", ["scene.ts"]), /分支/);
});
test("SCM real conflict provides base/ours/theirs and blocks destructive actions", async (t) => {
  const f = fixture(t);
  f.git("switch", "-c", "side");
  f.write("scene.ts", "theirs\n");
  f.git("commit", "-am", "Theirs");
  f.git("switch", f.work.branch);
  f.write("scene.ts", "ours\n");
  f.git("commit", "-am", "Ours");
  assert.throws(() => f.git("merge", "side"));
  assert.equal((await f.status()).conflicts, 1);
  const diff = await f.scm.diff({ id: f.work.id, path: f.prefix + "scene.ts" });
  assert.equal(diff.conflict, true);
  assert.equal(diff.ours.text, "ours\n");
  assert.equal(diff.theirs.text, "theirs\n");
  await assert.rejects(
    f.change("discard", ["scene.ts"], { confirm: true }),
    /冲突/,
  );
});
test("SCM push publishes committed history, never stages or commits dirty files", async (t) => {
  const f = fixture(t);
  f.remote();
  const head = f.git("rev-parse", "HEAD");
  f.write("scene.ts", "dirty local\n");
  await f.sync("push");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(
    f.git("rev-parse", "refs/remotes/origin/" + f.work.branch),
    head,
  );
  assert.equal((await f.status()).unstaged, 1);
  assert(
    !f.commands.some(
      (args) => args.includes("commit") || args.includes("--force"),
    ),
  );
});
test("SCM fast-forward sync, dirty pull protection, divergence and fetch errors", async (t) => {
  const f = fixture(t);
  f.remote();
  await f.sync("push");
  const other = f.other();
  fs.writeFileSync(path.join(other, f.prefix, "scene.ts"), "remote\n");
  f.gitAt(other, "commit", "-am", "Remote");
  f.gitAt(other, "push", "origin", f.work.branch);
  const old = f.git("rev-parse", "HEAD");
  f.write("audio.ts", "dirty\n");
  await assert.rejects(f.sync("pull"), /本地更改/);
  assert.equal(f.git("rev-parse", "HEAD"), old);
  await f.change("discard", ["audio.ts"], { confirm: true });
  await f.sync("sync");
  assert.equal(
    fs.readFileSync(path.join(f.cwd, f.prefix, "scene.ts"), "utf8"),
    "remote\n",
  );
  assert(f.changed() >= 2);
  fs.writeFileSync(path.join(other, f.prefix, "scene.ts"), "new remote\n");
  f.gitAt(other, "commit", "-am", "New remote");
  f.gitAt(other, "push", "origin", f.work.branch);
  f.write("audio.ts", "local\n");
  await f.change("stage", ["audio.ts"]);
  await f.change("commit", [], { message: "Local" });
  await assert.rejects(f.sync("sync"), /分叉/);
  f.fetchError("offline");
  await assert.rejects(f.sync("push"), /offline/);
});

test("SCM named checkpoint requires a clean tree and never stages files", async (t) => {
  const f = fixture(t);
  const oldTree = f.git("rev-parse", "HEAD^{tree}");
  await f.change("checkpoint", [], { message: "Approved cut" });
  assert.equal(f.git("log", "-1", "--format=%s"), "Approved cut");
  assert.equal(f.git("rev-parse", "HEAD^{tree}"), oldTree);
  f.write("scene.ts", "do not include automatically");
  await assert.rejects(
    f.change("checkpoint", [], { message: "Unsafe checkpoint" }),
    /先提交/,
  );
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("SCM waits for lock acquisition but never replays a started mutation", async (t) => {
  const f = fixture(t);
  let attempts = 0,
    writes = 0;
  const original = f.scm.db.lock;
  f.scm.db.lock = async (key, fn) => {
    if (++attempts === 1)
      throw Object.assign(Error("Repository is busy"), { statusCode: 409 });
    return original(key, fn);
  };
  await f.scm.locked(f.work, async () => {
    writes++;
  });
  assert.equal(attempts, 2);
  assert.equal(writes, 1);
  await assert.rejects(
    f.scm.locked(f.work, async () => {
      writes++;
      throw Object.assign(Error("failure after write"), { statusCode: 409 });
    }),
    /failure after write/,
  );
  assert.equal(writes, 2);
  assert.equal(attempts, 3);
});
test("SCM blocks a staged symlink even after the working file becomes regular", async (t) => {
  const f = fixture(t);
  const name = path.join(f.cwd, f.prefix, "link.txt");
  fs.symlinkSync("scene.ts", name);
  f.git("add", "--", f.prefix + "link.txt");
  fs.unlinkSync(name);
  fs.writeFileSync(name, "regular now");
  assert(
    (await f.status()).files.find((entry) => entry.path.endsWith("link.txt"))
      .unsafe,
  );
  await assert.rejects(
    f.change("commit", [], { message: "Must not commit symlink" }),
    /不安全/,
  );
});
test("SCM pull preserves ignored working files and rejects an out-of-scope remote tree", async (t) => {
  const f = fixture(t);
  f.remote();
  await f.sync("push");
  const other = f.other();
  fs.writeFileSync(
    path.join(f.cwd, ".git/info/exclude"),
    "projects/test-film/ignored.txt\n",
  );
  f.write("ignored.txt", "local ignored content");
  fs.writeFileSync(path.join(other, f.prefix, "ignored.txt"), "remote content");
  f.gitAt(other, "add", "--", f.prefix + "ignored.txt");
  f.gitAt(other, "commit", "-m", "Remote ignored path");
  f.gitAt(other, "push", "origin", f.work.branch);
  const head = f.git("rev-parse", "HEAD");
  await assert.rejects(f.sync("pull"), /overwritten|untracked|merge/);
  assert.equal(
    fs.readFileSync(path.join(f.cwd, f.prefix, "ignored.txt"), "utf8"),
    "local ignored content",
  );
  assert.equal(f.git("rev-parse", "HEAD"), head);
  fs.mkdirSync(path.join(other, "projects/other"));
  fs.writeFileSync(path.join(other, "projects/other/secret.txt"), "outside");
  f.gitAt(other, "add", "--", "projects/other");
  f.gitAt(other, "commit", "-m", "Out of scope");
  f.gitAt(other, "push", "origin", f.work.branch);
  await assert.rejects(f.sync("pull"), /当前作品/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("SCM can stage further edits of an already-staged rename", async (t) => {
  const f = fixture(t);
  f.git("mv", f.prefix + "scene.ts", f.prefix + "renamed.ts");
  f.write("renamed.ts", "edited after rename");
  await f.change("stage", ["renamed.ts"]);
  await f.change("commit", [], { message: "Edited rename" });
  assert.equal(
    f.git("show", "HEAD:" + f.prefix + "renamed.ts"),
    "edited after rename",
  );
});
test("SCM respects Git binary attributes and refreshes deleted remote branches", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, ".gitattributes"), "*.ts -diff\n");
  f.git("add", ".gitattributes");
  f.git("commit", "-m", "Binary attribute");
  f.write("scene.ts", "different but text");
  const diff = await f.scm.diff({ id: f.work.id, path: f.prefix + "scene.ts" });
  assert.equal(diff.binaryDiff, true);
  f.remote();
  await f.sync("push");
  assert.equal((await f.status()).sync.remoteExists, true);
  f.git("push", "origin", "--delete", f.work.branch);
  await f.sync("fetch");
  assert.equal((await f.status()).sync.remoteExists, false);
});


test("automatic checkpoints preserve a distinct staged version until the user resolves it", async (t) => {
  const f = fixture(t);
  const head = (await f.status()).head;
  f.write("scene.ts", "staged version\n");
  await f.change("stage", ["scene.ts"]);
  f.write("scene.ts", "later working version\n");
  await assert.rejects(
    Repositories.prototype.checkpoint.call(f.scm.repos, f.work.repo, f.work.project, "Before AI"),
    /暂存/,
  );
  assert.equal((await f.status()).head, head);
  assert.equal(f.git("show", ":" + f.prefix + "scene.ts"), "staged version");
  assert.equal(fs.readFileSync(path.join(f.cwd, f.prefix, "scene.ts"), "utf8"), "later working version\n");
});
