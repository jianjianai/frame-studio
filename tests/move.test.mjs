import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";
import { emptyReview, formatReview } from "../server/review-data.mjs";
import { snapshotFiles } from "../server/ai/context.mjs";

process.env.FRAME_ALLOW_FILE_REMOTES = "1";

let app, call, agentHome, previousAgentHome;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-move-"));
  agentHome = path.join(home, "agent-home");
  previousAgentHome = process.env.FRAME_AGENT_HOME;
  process.env.FRAME_AGENT_HOME = agentHome;
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
afterAll(async () => {
  await app.close();
  if (previousAgentHome === undefined) delete process.env.FRAME_AGENT_HOME;
  else process.env.FRAME_AGENT_HOME = previousAgentHome;
});

/** A bare repository standing in for GitHub, linked to the studio. */
async function linked(name) {
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")), name + ".git");
  await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
  const repo = (await call("/api/repos", { method: "POST", body: { url: "file://" + remote } })).body;
  return { remote, repo };
}
const oid = (char) => char.repeat(64);
const pointer = (char) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid(char)}\nsize 3\n`;
const lfsFile = (dir, char) => path.join(dir, "lfs", "objects", char + char, char + char, oid(char));
const sanitized = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");

describe("迁移作品到其他作品库", () => {
  it("moves a local work with its history, media, libraries, review, videos, cover and conversations", async () => {
    const { services } = app;
    const { works, materials, experience, reviews, repos } = services;
    const { remote, repo } = await linked("works");
    const local = repos.get("local");
    const target = repos.get(repo.id);

    // A material library: one file the work locks now, one it locked at an older version.
    await materials.create("local", "品牌");
    await materials.change("local", ["品牌"], (dir) => {
      fs.writeFileSync(path.join(dir, "品牌", "README.md"), "# 品牌\n");
      fs.writeFileSync(path.join(dir, "品牌", "logo.svg"), "<svg>logo</svg>");
      fs.writeFileSync(path.join(dir, "品牌", "old.svg"), "<svg>old</svg>");
    });
    await materials.commit("local", ["品牌"], "素材");
    await experience.create("local", "短片经验");

    const work = await works.create({ title: "迁移的作品" });
    fs.writeFileSync(path.join(work.dir, "scene.ts"), fs.readFileSync(path.join(work.dir, "scene.ts"), "utf8") + '\n// assetUrl("materials/品牌/logo.svg")\n// assetUrl("materials/品牌/old.svg")\n');
    await works.update(work, { experiences: ["短片经验"] });
    // A medium stored in Git LFS.
    fs.mkdirSync(path.join(work.dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(work.dir, "public", "clip.mp4"), pointer("a"));
    fs.mkdirSync(path.dirname(lfsFile(local.dir, "a")), { recursive: true });
    fs.writeFileSync(lfsFile(local.dir, "a"), "mp4");
    await works.commit(work, "第二个版本");
    await materials.change("local", ["品牌"], (dir) => fs.writeFileSync(path.join(dir, "品牌", "old.svg"), "<svg>new</svg>"));
    await materials.commit("local", ["品牌"], "更新素材");
    const history = (await git(local.dir, ["rev-list", "--count", `works/${work.id}`])).trim();

    // Kept outside the branch: a review, an exported video, the cover, a conversation (Claude keeps its own copy by folder).
    const reviewDir = await reviews.dir("local", work.id);
    fs.writeFileSync(path.join(reviewDir, "review.json"), formatReview({ ...emptyReview(work.id), title: "迁移的作品" }));
    await git(reviewDir, ["add", "-A"]);
    await git(reviewDir, ["commit", "-q", "-m", "复盘"]);
    const video = path.join(services.config.dirs.exports, "local", work.id, "成片.mp4");
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(video, "mp4");
    const cover = (repoId) => path.join(services.config.dirs.cache, "covers", repoId, work.id + ".webp");
    fs.mkdirSync(path.dirname(cover("local")), { recursive: true });
    fs.writeFileSync(cover("local"), "webp");
    const session = { id: "s-move", work: work.id, repo: "local", agent: "claude", acpSessionId: "acp-move", title: "对话", createdAt: "", updatedAt: "", status: "idle", queue: [] };
    // What the AI saw: scene.ts has changed since, project.ts has not.
    services.ai.sessions.set(session.id, { meta: session, process: null, attached: false, files: { ...snapshotFiles(work.dir), "scene.ts": "stale" } });
    const claudeFolder = (root) => path.join(agentHome, ".claude", "projects", sanitized(root));
    fs.mkdirSync(claudeFolder(work.root), { recursive: true });
    fs.writeFileSync(path.join(claudeFolder(work.root), "acp-move.jsonl"), "{}\n");
    services.settings.update("recent", (list) => [{ repo: "local", id: work.id, openedAt: new Date().toISOString() }, ...list]);
    // Not saved yet: goes along as a version.
    fs.writeFileSync(path.join(work.dir, "notes.md"), "迁移前的修改");

    const report = (await call(`/api/works/local/${work.id}/move?to=${repo.id}`)).body;
    expect(report).toMatchObject({
      id: work.id,
      title: "迁移的作品",
      from: { id: "local" },
      to: { id: repo.id, remote: "file://" + remote },
      unsaved: 1,
      blocked: [],
      error: "",
      review: true,
      exports: { count: 1 },
      sessions: 1,
      materials: { copy: [{ id: "品牌", title: "品牌" }], shared: [], changed: ["品牌/old.svg"], missing: [] },
      experiences: { copy: [{ id: "短片经验", title: "短片经验" }], shared: [] },
    });

    const moved = await call(`/api/works/local/${work.id}/move`, { method: "POST", body: { to: repo.id } });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ id: work.id, repo: repo.id, relocked: ["品牌/old.svg"], problems: [] });

    // Gone from the local repository…
    expect(await works.taken("local", work.id)).toBe("");
    expect(fs.existsSync(work.root)).toBe(false);
    // …there with every version, the unsaved change saved first, the locks moved to the versions it has.
    const log = (await git(target.dir, ["log", "--format=%s", `works/${work.id}`])).trim().split("\n");
    expect(log.slice(0, 2)).toEqual(["迁移后改用这个作品库里的素材版本", "迁移前自动保存"]);
    expect(log.length).toBe(Number(history) + 2);
    const there = works.describe(repo.id, work.id);
    expect(fs.readFileSync(path.join(there.dir, "notes.md"), "utf8")).toBe("迁移前的修改");
    expect(fs.readFileSync(lfsFile(target.dir, "a"), "utf8")).toBe("mp4");
    const head = await materials.headMap(repo.id);
    expect(JSON.parse(fs.readFileSync(path.join(there.dir, "materials.lock.json"), "utf8"))).toEqual({
      "品牌/logo.svg": head.get("品牌/logo.svg"),
      "品牌/old.svg": head.get("品牌/old.svg"),
    });
    expect((await call(`/files/${repo.id}/${work.id}/materials/${encodeURIComponent("品牌")}/old.svg`)).status).toBe(200);
    expect(fs.existsSync(path.join(await experience.dir(repo.id), "短片经验", "README.md"))).toBe(true);
    expect(experience.link(there).libraries.map((library) => library.id)).toEqual(["短片经验"]);

    // What is kept outside the branch followed it.
    expect(await reviews.has(repo.id, work.id)).toBe(true);
    expect(await reviews.has("local", work.id)).toBe(false);
    expect(fs.readFileSync(path.join(services.config.dirs.exports, repo.id, work.id, "成片.mp4"), "utf8")).toBe("mp4");
    expect(fs.existsSync(path.dirname(video))).toBe(false);
    expect(fs.readFileSync(cover(repo.id), "utf8")).toBe("webp");
    expect(fs.existsSync(cover("local"))).toBe(false);
    expect(services.settings.get("recent")[0]).toMatchObject({ repo: repo.id, id: work.id });
    const conversation = services.ai.get("s-move");
    expect(conversation.meta.repo).toBe(repo.id);
    expect(conversation.files["scene.ts"]).toBe("stale"); // changed since the AI saw it: still reported
    expect(conversation.files["project.ts"]).toBe(snapshotFiles(there.dir)["project.ts"]); // a fresh checkout is no change
    expect(fs.existsSync(path.join(claudeFolder(there.root), "acp-move.jsonl"))).toBe(true);
    expect(fs.existsSync(claudeFolder(work.root))).toBe(false);

    const listed = (await call("/api/works")).body.filter((item) => item.id === work.id);
    expect(listed).toEqual([expect.objectContaining({ repo: repo.id, title: "迁移的作品" })]);
    // Pushed to GitHub like any saved version.
    await services.remoteSync.pushNow(there);
    expect((await git(remote, ["rev-parse", `works/${work.id}`])).trim()).toBe((await git(target.dir, ["rev-parse", `works/${work.id}`])).trim());
  });

  it("refuses what cannot move", async () => {
    const { services } = app;
    const { repo } = await linked("other");
    const work = await services.works.create({ title: "留下" });
    expect((await call(`/api/works/local/${work.id}/move?to=local`)).status).toBe(400);
    expect((await call(`/api/works/local/${work.id}/move?to=`)).status).toBe(400);
    // Works of a repository on GitHub stay where they are.
    const remoteWork = await services.works.create({ repo: repo.id, title: "云端" });
    services.remoteSync.forget(repo.id);
    expect((await call(`/api/works/${repo.id}/${remoteWork.id}/move?to=local`)).status).toBe(400);
    // The id is taken there (here: by a work in its recycle bin).
    await git(services.repos.get(repo.id).dir, ["branch", `trash/${work.id}`, `works/${remoteWork.id}`]);
    const report = (await call(`/api/works/local/${work.id}/move?to=${repo.id}`)).body;
    expect(report.blocked).toEqual([`「${report.to.name}」里已经有 id 为 ${work.id} 的回收站里的作品`]);
    expect((await call(`/api/works/local/${work.id}/move`, { method: "POST", body: { to: repo.id } })).status).toBe(409);
    expect(await services.works.taken("local", work.id)).toBe("作品");
  });
});
