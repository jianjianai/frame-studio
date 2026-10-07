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
import { RemoteSync } from "../server/remote-sync.mjs";

process.env.FRAME_ALLOW_FILE_REMOTES = "1";

/** One machine: its own data folder, the shared remote, and automatic sync. */
async function machine(remote) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-autosync-"));
  const config = loadConfig({ FRAME_HOME: home });
  ensureDirs(config);
  const events = new Events();
  const settings = new Settings(home, events);
  const repos = new Repos({ config, settings, github: new GitHub(settings), events });
  await repos.ensureLocal();
  const works = new Works({ config, settings, repos, events });
  const sessions = [];
  const services = { config, events, settings, repos, works, ai: { list: () => sessions } };
  const sync = new RemoteSync(services);
  const seen = [];
  events.subscribe((event) => event.type === "remote-state" && seen.push(event.state.state));
  const repo = await repos.clone({ url: "file://" + remote });
  return { works, repos, sync, sessions, seen, repo };
}

let a, b;
beforeAll(async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "frame-autosync-remote-")) + "/works.git";
  await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
  a = await machine(remote);
  b = await machine(remote);
});

const write = (work, file, text) => fs.writeFileSync(path.join(work.dir, file), text);
const read = (work, file) => fs.readFileSync(path.join(work.dir, file), "utf8");

describe("automatic sync with GitHub", () => {
  it("pushes saved versions and brings newer ones in when the copy is opened", async () => {
    const work = await a.works.create({ repo: a.repo.id, title: "自动同步" });
    expect(await a.sync.pushNow(work)).toMatchObject({ state: "synced" });
    expect(a.seen).toContain("pushing");
    await b.repos.fetch(b.repo.id);
    const copy = await b.works.open(work.id, b.repo.id);

    write(work, "notes.md", "a 的第一版\n");
    await a.works.commit(work, "a 改了");
    await a.sync.pushNow(work);
    // B is behind: with nothing in the way, the newer version comes in by itself.
    expect(await b.sync.check(copy)).toMatchObject({ state: "synced", pulled: 1 });
    expect(read(copy, "notes.md")).toBe("a 的第一版\n");

    // An AI at work on B: nothing is brought in under it, and it says so.
    write(work, "notes.md", "a 的第二版\n");
    await a.works.commit(work, "a 又改了");
    await a.sync.pushNow(work);
    b.sessions.push({ id: "s1", status: "running" });
    expect(await b.sync.check(copy)).toMatchObject({ state: "behind", behind: 1, waiting: "ai" });
    // …except the turn that is about to start.
    expect(await b.sync.check(copy, { session: "s1" })).toMatchObject({ state: "synced", pulled: 1 });
    b.sessions.length = 0;
  });

  it("names unsaved edits in the way, and settles a conflict either way", async () => {
    const work = await a.works.create({ repo: a.repo.id, title: "冲突" });
    write(work, "notes.md", "共同的开头\n");
    await a.works.commit(work, "开头");
    await a.sync.pushNow(work);
    await b.repos.fetch(b.repo.id);
    const copy = await b.works.open(work.id, b.repo.id);

    write(work, "notes.md", "a 写的结尾\n");
    await a.works.commit(work, "a 的结尾");
    await a.sync.pushNow(work);
    write(copy, "notes.md", "b 写的结尾\n"); // unsaved on B, same file
    const behind = await b.sync.check(copy);
    expect(behind).toMatchObject({ state: "behind", behind: 1 });
    expect(behind.blocked).toEqual([`projects/${copy.slug}/notes.md`]);

    // Saving B's edit and merging meets the same line: a conflict, named.
    await expect(b.sync.settle(copy, "update")).rejects.toMatchObject({ status: 409 });
    expect(b.sync.get(copy)).toMatchObject({ state: "conflict", files: [`projects/${copy.slug}/notes.md`] });
    // Keeping B's version pushes it; A then gets it.
    expect(await b.sync.settle(copy, "local")).toMatchObject({ state: "synced" });
    expect(read(copy, "notes.md")).toBe("b 写的结尾\n");
    expect(await a.sync.check(work)).toMatchObject({ state: "synced", pulled: 2 });
    expect(read(work, "notes.md")).toBe("b 写的结尾\n");
  });

  it("finds out at push time that both sides have new versions, and merges them", async () => {
    const work = await a.works.create({ repo: a.repo.id, title: "两边都改" });
    await a.sync.pushNow(work);
    await b.repos.fetch(b.repo.id);
    const copy = await b.works.open(work.id, b.repo.id);
    write(work, "a.md", "a\n");
    await a.works.commit(work, "a");
    await a.sync.pushNow(work);
    write(copy, "b.md", "b\n");
    await b.works.commit(copy, "b");
    expect(await b.sync.pushNow(copy)).toMatchObject({ state: "diverged", ahead: 1, behind: 1 });
    expect(await b.sync.settle(copy, "merge")).toMatchObject({ state: "synced" });
    expect(read(copy, "a.md")).toBe("a\n");
    expect(await a.sync.check(work)).toMatchObject({ state: "synced" });
    expect(read(work, "b.md")).toBe("b\n");
  });

  it("pushes versions saved while offline, also of works not open, but never over newer ones", async () => {
    const work = await a.works.create({ repo: a.repo.id, title: "离线保存" });
    write(work, "offline.md", "离线时保存的\n");
    await a.works.commit(work, "离线保存");
    // Nothing pushed it (offline): the sweep does, without the work being open anywhere.
    await a.sync.sweep();
    await b.repos.fetch(b.repo.id);
    expect((await b.works.list({ repo: b.repo.id })).find((item) => item.id === work.id)).toMatchObject({ location: "remote" });
    const remoteBranch = `refs/remotes/origin/works/${work.id}`;
    const tip = (await git(a.repos.get(a.repo.id).dir, ["rev-parse", remoteBranch])).trim();
    expect(tip).toBe((await git(work.root, ["rev-parse", "HEAD"])).trim());
  });

  it("reports what it cannot do, and leaves local-only repositories alone", async () => {
    const local = await a.works.create({ title: "只在本机" });
    expect(await a.sync.check(local)).toMatchObject({ state: "local" });
    const work = await a.works.create({ repo: a.repo.id, title: "断网" });
    const info = a.repos.get(a.repo.id);
    await git(info.dir, ["remote", "set-url", "origin", "file:///nonexistent/works.git"]);
    try {
      const failed = await a.sync.pushNow(work);
      expect(failed.state).toBe("error");
      expect(failed.message).toContain("自动推送到 GitHub 失败");
    } finally {
      await git(info.dir, ["remote", "set-url", "origin", info.remote]);
    }
  });
});
