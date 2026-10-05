import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, ensureDirs } from "../server/config.mjs";
import { Settings } from "../server/settings.mjs";
import { GitHub } from "../server/github.mjs";
import { Repos } from "../server/repos.mjs";
import { Works } from "../server/works.mjs";
import { Library } from "../server/library.mjs";
import { Events } from "../server/util.mjs";
import { git } from "../server/git.mjs";

process.env.FRAME_ALLOW_FILE_REMOTES = "1";

async function studio() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sync-"));
  const config = loadConfig({ FRAME_HOME: home });
  ensureDirs(config);
  const events = new Events();
  const settings = new Settings(home, events);
  const repos = new Repos({ config, settings, github: new GitHub(settings), events });
  await repos.ensureLocal();
  return { repos, works: new Works({ config, settings, repos, events }), library: new Library({ repos, events }) };
}

let remote, a, b, repoA, repoB;
beforeAll(async () => {
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")) + "/works.git";
  await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
  a = await studio();
  b = await studio();
  repoA = await a.repos.clone({ url: "file://" + remote });
  repoB = await b.repos.clone({ url: "file://" + remote });
});

describe("content repository sync", () => {
  it("seeds an empty remote and pushes a new work", async () => {
    expect((await git(remote, ["branch", "--list", "main"])).trim()).toContain("main");
    const work = await a.works.create({ repo: repoA.id, title: "同步作品" });
    await a.works.push(work);
    expect((await git(remote, ["branch", "--list", "works/*"])).trim()).toContain("works/" + work.id);
    await b.repos.fetch(repoB.id);
    const seen = (await b.works.list({ repo: repoB.id })).find((item) => item.id === work.id);
    expect(seen).toMatchObject({ title: "同步作品", location: "remote", checkedOut: false });
  });

  it("round-trips changes between two studios with fast-forward pulls", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "往返" });
    await a.works.push(work);
    await b.repos.fetch(repoB.id);
    const copy = await b.works.open(work.id, repoB.id);
    fs.writeFileSync(path.join(copy.dir, "notes.md"), "from b");
    await b.works.commit(copy, "b 的修改");
    await b.works.push(copy);
    await a.works.pull(work);
    expect(fs.readFileSync(path.join(work.dir, "notes.md"), "utf8")).toBe("from b");
    expect((await a.works.status(work)).behind).toBe(0);
  });

  it("refuses to pull over unsaved changes and reports divergence", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "冲突" });
    await a.works.push(work);
    await b.repos.fetch(repoB.id);
    const copy = await b.works.open(work.id, repoB.id);
    fs.writeFileSync(path.join(copy.dir, "x.txt"), "b");
    await b.works.commit(copy, "b");
    await b.works.push(copy);
    fs.writeFileSync(path.join(work.dir, "x.txt"), "a");
    await expect(a.works.pull(work)).rejects.toThrow(/未保存/);
    await a.works.commit(work, "a");
    await expect(a.works.pull(work)).rejects.toThrow(/都有新的修改/);
  });

  it("shares the materials library through its own branch", async () => {
    const file = path.join(os.tmpdir(), `material-${Date.now()}.txt`);
    fs.writeFileSync(file, "shared material");
    const item = await a.library.add(repoA.id, file, { name: "note.txt", license: "CC0" });
    await a.library.push(repoA.id);
    await b.library.pull(repoB.id);
    const items = await b.library.list(repoB.id);
    expect(items.find((entry) => entry.id === item.id)).toMatchObject({ name: "note.txt", license: "CC0" });
  });
});

describe("materials library divergence", () => {
  it("merges libraries that were started independently", async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")) + "/lib.git";
    await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
    const x = await studio();
    const y = await studio();
    const rx = await x.repos.clone({ url: "file://" + remote });
    const ry = await y.repos.clone({ url: "file://" + remote });
    const one = path.join(os.tmpdir(), `one-${Date.now()}.txt`);
    const two = path.join(os.tmpdir(), `two-${Date.now()}.txt`);
    fs.writeFileSync(one, "one");
    fs.writeFileSync(two, "two");
    await x.library.add(rx.id, one, { name: "one.txt" });
    await y.library.add(ry.id, two, { name: "two.txt" });
    await x.library.push(rx.id);
    await y.library.pull(ry.id);
    await y.library.push(ry.id);
    await x.library.pull(rx.id);
    expect((await x.library.list(rx.id)).map((item) => item.name).sort()).toEqual(["one.txt", "two.txt"]);
    expect((await y.library.list(ry.id)).map((item) => item.name).sort()).toEqual(["one.txt", "two.txt"]);
  });
});

describe("diverged works", () => {
  it("merges non-conflicting changes or adopts the remote with a backup", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "分叉" });
    await a.works.push(work);
    await b.repos.fetch(repoB.id);
    const copy = await b.works.open(work.id, repoB.id);
    fs.writeFileSync(path.join(copy.dir, "b.txt"), "b");
    await b.works.commit(copy, "b");
    await b.works.push(copy);
    fs.writeFileSync(path.join(work.dir, "a.txt"), "a");
    await a.works.commit(work, "a");
    await expect(a.works.pull(work)).rejects.toThrow(/合并/);
    await a.works.resolve(work, "merge");
    expect(fs.existsSync(path.join(work.dir, "a.txt")) && fs.existsSync(path.join(work.dir, "b.txt"))).toBe(true);

    fs.writeFileSync(path.join(copy.dir, "b.txt"), "b2");
    await b.works.commit(copy, "b2");
    await b.works.push(copy);
    fs.writeFileSync(path.join(work.dir, "b.txt"), "a2");
    await a.works.commit(work, "a2");
    await a.repos.fetch(repoA.id);
    await expect(a.works.resolve(work, "merge")).rejects.toThrow(/同一处/);
    await a.works.resolve(work, "remote");
    expect(fs.readFileSync(path.join(work.dir, "b.txt"), "utf8")).toBe("b2");
    expect((await git(work.root, ["for-each-ref", "refs/frame-backup"])).trim()).not.toBe("");
  });
});
