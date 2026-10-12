import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";

process.env.FRAME_ALLOW_FILE_REMOTES = "1";

let app, call;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-unlink-"));
  app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
  const base = await app.listen();
  call = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
});
afterAll(() => app.close());

/** A bare repository standing in for GitHub, linked to the studio. */
async function linked(name) {
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")), name + ".git");
  await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
  const repo = (await call("/api/repos", { method: "POST", body: { url: "file://" + remote } })).body;
  return { remote, repo };
}

describe("取消链接作品库", () => {
  it("lists what only this machine has, saves and pushes it, then removes everything local", async () => {
    const { services } = app;
    const { remote, repo } = await linked("works");
    const pushed = await services.works.create({ repo: repo.id, title: "已同步" });
    await services.works.setPublished(pushed, true); // read-only on disk: removal must still work
    const edited = await services.works.create({ repo: repo.id, title: "有修改" });
    services.remoteSync.forget(repo.id); // the test pushes itself
    await services.remoteSync.pushNow(pushed);
    fs.writeFileSync(path.join(edited.dir, "notes.md"), "只在本机");
    const video = path.join(services.config.dirs.exports, repo.id, pushed.id, "成片.mp4");
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(video, "mp4");
    const cover = path.join(services.config.dirs.cache, "covers", repo.id, pushed.id + ".webp");
    fs.mkdirSync(path.dirname(cover), { recursive: true });
    fs.writeFileSync(cover, "webp");

    const report = (await call(`/api/repos/${repo.id}/unlink`)).body;
    expect(report).toMatchObject({ id: repo.id, error: "", busy: [], works: 2, exports: { count: 1, bytes: 3 } });
    // Publishing started the material library branch here; the published work itself is on GitHub.
    expect(report.pending).toEqual([
      expect.objectContaining({ kind: "library", branch: "frame/materials", title: "素材库", unsaved: 0, ahead: 1 }),
      expect.objectContaining({ kind: "work", work: edited.id, title: "有修改", unsaved: 1, ahead: 1, behind: 0 }),
    ]);

    const refused = await call(`/api/repos/${repo.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.report.pending).toHaveLength(2);

    const synced = (await call(`/api/repos/${repo.id}/unlink/sync`, { method: "POST" })).body;
    expect(synced.failed).toEqual([]);
    expect(synced.pending).toEqual([]);
    expect((await git(remote, ["log", "-1", "--format=%s", `works/${edited.id}`])).trim()).toBe("取消链接前自动保存");
    expect((await git(remote, ["branch", "--list", "frame/materials"])).trim()).toContain("frame/materials");

    const removed = await call(`/api/repos/${repo.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.body.freed).toBeGreaterThan(0);
    expect(services.settings.get("repos").map((item) => item.id)).not.toContain(repo.id);
    expect(services.settings.get("recent").filter((item) => item.repo === repo.id)).toEqual([]);
    const { clone, works: checkouts, shared, exports } = services.repos.places(repo.id);
    for (const dir of [clone, checkouts, ...shared, exports, path.dirname(cover)]) expect(fs.existsSync(dir)).toBe(false);

    // GitHub keeps everything: linking it again brings the works back.
    const again = (await call("/api/repos", { method: "POST", body: { url: "file://" + remote } })).body;
    expect(again.id).toBe(repo.id);
    const works = (await call(`/api/works?repo=${again.id}`)).body;
    expect(works.map((work) => work.title).sort()).toEqual(["已同步", "有修改"].sort());
    expect(works.every((work) => !work.checkedOut)).toBe(true);
  });

  it("waits for running work and removes local-only versions only when told to", async () => {
    const { services } = app;
    const { remote, repo } = await linked("drafts");
    const work = await services.works.create({ repo: repo.id, title: "草稿" });
    services.remoteSync.forget(repo.id);
    const task = services.tasks.start(
      { kind: "export", title: "导出 草稿", work: work.id, repo: repo.id },
      ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const busy = await call(`/api/repos/${repo.id}?discard=1`, { method: "DELETE" });
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toContain("导出 草稿");
    services.tasks.cancel(task.id);
    await task.done;

    expect((await call(`/api/repos/${repo.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(`/api/repos/${repo.id}?discard=1`, { method: "DELETE" })).status).toBe(200);
    expect((await git(remote, ["branch", "--list", "works/*"])).trim()).toBe("");
  });

  it("keeps the local repository", async () => {
    expect((await call("/api/repos/local/unlink")).status).toBe(400);
    expect((await call("/api/repos/local", { method: "DELETE" })).status).toBe(400);
  });
});
