import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, ensureDirs } from "../server/config.mjs";
import { Settings } from "../server/settings.mjs";
import { GitHub } from "../server/github.mjs";
import { Repos } from "../server/repos.mjs";
import { Works } from "../server/works.mjs";
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
  return { repos, works: new Works({ config, settings, repos, events }) };
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

describe("recycle bin and local space", () => {
  const branches = async (pattern) => (await git(remote, ["branch", "--list", pattern])).replace(/[ *]/g, "").split("\n").filter(Boolean);

  it("renames the branch here and on GitHub, and back", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "回收" });
    await a.works.push(work);
    await a.works.trash(work.id, repoA.id);
    expect(await branches("*/" + work.id)).toEqual(["trash/" + work.id]);
    expect((await a.works.list({ repo: repoA.id })).some((item) => item.id === work.id)).toBe(false);
    expect((await a.works.list({ repo: repoA.id, trash: true })).find((item) => item.id === work.id)).toMatchObject({ title: "回收", location: "both" });

    // Another device sees it in the recycle bin, not among the works.
    await b.repos.fetch(repoB.id);
    expect((await b.works.list({ repo: repoB.id })).some((item) => item.id === work.id)).toBe(false);
    expect((await b.works.list({ repo: repoB.id, trash: true })).find((item) => item.id === work.id)).toMatchObject({ location: "remote" });

    await a.works.restore(work.id, repoA.id);
    expect(await branches("*/" + work.id)).toEqual(["works/" + work.id]);
    const reopened = await a.works.open(work.id, repoA.id);
    expect((await a.works.status(reopened)).upstream).toBe("origin/works/" + work.id);
  });

  it("deletes for good here and on GitHub, with the work's backups", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "永久删除" });
    await a.works.push(work);
    const dir = a.repos.get(repoA.id).dir;
    await git(dir, ["update-ref", `refs/frame-backup/${work.id}/2026-10-06`, "refs/heads/works/" + work.id]);
    await git(dir, ["update-ref", `refs/frame-backup/pre-lfs/heads/works/${work.id}`, "refs/heads/works/" + work.id]);
    await a.works.trash(work.id, repoA.id);
    const result = await a.works.purge(work.id, repoA.id);
    expect(result.freed).toBeGreaterThanOrEqual(0);
    expect(await branches("*/" + work.id)).toEqual([]);
    expect((await git(dir, ["for-each-ref", "--format=%(refname)"])).split("\n").filter((ref) => ref.includes(work.id))).toEqual([]);
    expect((await a.works.list({ repo: repoA.id, trash: true })).some((item) => item.id === work.id)).toBe(false);
  });

  it("empties the recycle bin of a work kept only on this machine", async () => {
    const work = await a.works.create({ title: "本地回收" });
    await a.works.trash(work.id, "local");
    expect((await a.works.purgeAll("local")).purged).toBeGreaterThanOrEqual(1);
    expect((await a.works.list({ repo: "local", trash: true })).length).toBe(0);
  });

  it("keeps a synced work only on GitHub, and downloads it again when opened", async () => {
    const work = await a.works.create({ repo: repoA.id, title: "只留云端" });
    await expect(a.works.freeLocal(work.id, repoA.id)).rejects.toThrow(/GitHub 上还没有/);
    await a.works.push(work);
    fs.writeFileSync(path.join(work.dir, "draft.txt"), "unsaved");
    await expect(a.works.freeLocal(work.id, repoA.id)).rejects.toThrow(/未保存/);
    await a.works.commit(work, "本地版本");
    await expect(a.works.freeLocal(work.id, repoA.id)).rejects.toThrow(/还没同步/);
    expect((await a.works.list({ repo: repoA.id })).find((item) => item.id === work.id)).toMatchObject({ location: "both", synced: false });
    await a.works.push(work);
    expect((await a.works.list({ repo: repoA.id })).find((item) => item.id === work.id)).toMatchObject({ synced: true });

    await a.works.freeLocal(work.id, repoA.id);
    expect(fs.existsSync(work.root)).toBe(false);
    expect((await a.works.list({ repo: repoA.id })).find((item) => item.id === work.id)).toMatchObject({ location: "remote", checkedOut: false });
    const again = await a.works.open(work.id, repoA.id);
    expect(fs.readFileSync(path.join(again.dir, "draft.txt"), "utf8")).toBe("unsaved");
  });

  it("removes LFS files only the deleted branches used", async () => {
    const dir = a.repos.get(repoA.id).dir;
    const oid = (char) => char.repeat(64);
    const pointer = (char) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid(char)}\nsize 3\n`;
    const store = (char) => path.join(dir, "lfs", "objects", char + char, char + char, oid(char));
    const kept = await a.works.create({ repo: repoA.id, title: "保留的媒体" });
    const gone = await a.works.create({ repo: repoA.id, title: "删除的媒体" });
    fs.writeFileSync(path.join(kept.dir, "public", "a.png"), pointer("a"));
    fs.writeFileSync(path.join(gone.dir, "public", "b.png"), pointer("b"));
    await a.works.commit(kept, "媒体");
    await a.works.commit(gone, "媒体");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const char of ["a", "b", "c"]) {
      fs.mkdirSync(path.dirname(store(char)), { recursive: true });
      fs.writeFileSync(store(char), "xyz");
      fs.utimesSync(store(char), old, old);
    }
    fs.mkdirSync(path.dirname(store("d")), { recursive: true });
    fs.writeFileSync(store("d"), "new"); // written just now: may belong to a commit in progress

    await a.works.trash(gone.id, repoA.id);
    await a.works.purge(gone.id, repoA.id);
    expect(["a", "b", "c", "d"].map((char) => fs.existsSync(store(char)))).toEqual([true, false, false, true]);
  });
});
