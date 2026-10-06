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

let works, repos, home;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-works-"));
  const config = loadConfig({ FRAME_HOME: home });
  ensureDirs(config);
  const events = new Events();
  const settings = new Settings(home, events);
  repos = new Repos({ config, settings, github: new GitHub(settings), events });
  await repos.ensureLocal();
  works = new Works({ config, settings, repos, events });
});

describe("works as git branches", () => {
  it("creates a work on its own orphan branch with a clean first commit", async () => {
    const work = await works.create({ title: "第一部", duration: 5 });
    expect(work.branch).toBe("works/" + work.id);
    const files = (await git(work.root, ["ls-files"])).trim().split("\n");
    expect(files).toContain(`projects/${work.slug}/project.ts`);
    expect(files.some((file) => /^(src|node_modules|docs|AGENTS\.md|CLAUDE\.md|tsconfig\.json)$/.test(file))).toBe(false);
    expect(fs.lstatSync(path.join(work.root, "src")).isSymbolicLink()).toBe(true);
    const list = await works.list();
    expect(list.find((item) => item.id === work.id)).toMatchObject({ title: "第一部", duration: 5, checkedOut: true });
  });

  it("stores the media of new works in Git LFS", async () => {
    const work = await works.create({ title: "LFS" });
    expect((await git(work.root, ["ls-files"])).split("\n")).toContain(".gitattributes");
    const media = ["a.mp3", "b.PNG", "c.mov", "d.woff2", "e.sf2"].map((name) => `projects/${work.slug}/public/${name}`);
    const attributes = await git(work.root, ["check-attr", "filter", "--", ...media, `projects/${work.slug}/scene.ts`]);
    expect(attributes.trim().split("\n").map((line) => line.split(": ").pop())).toEqual(["lfs", "lfs", "lfs", "lfs", "lfs", "unspecified"]);
  });
  it("keeps histories independent and supports revert", async () => {
    const a = await works.create({ title: "A" });
    const b = await works.create({ title: "B" });
    fs.writeFileSync(path.join(a.dir, "note.txt"), "one");
    const first = await works.commit(a, "add note");
    fs.writeFileSync(path.join(a.dir, "note.txt"), "two");
    await works.commit(a, "change note");
    expect((await works.history(a)).map((item) => item.message)).toEqual(["change note", "add note", "创建作品：A"]);
    expect(await works.history(b)).toHaveLength(1);
    await works.revert(a, first);
    expect(fs.readFileSync(path.join(a.dir, "note.txt"), "utf8")).toBe("one");
    expect((await works.history(a))[0].message).toMatch(/^恢复到版本/);
  });

  it("reports nothing to commit and updates project fields", async () => {
    const work = await works.create({ title: "C" });
    expect(await works.commit(work, "noop")).toBeNull();
    await works.update(work, { title: "C2", duration: 8 });
    expect(works.meta(work).meta).toMatchObject({ title: "C2", duration: 8 });
    expect((await works.status(work)).files.map((file) => file.path)).toEqual([`projects/${work.slug}/project.ts`]);
  });

  it("moves works to the trash and back", async () => {
    const work = await works.create({ title: "D" });
    await works.trash(work.id);
    expect((await works.list()).some((item) => item.id === work.id)).toBe(false);
    expect((await works.list({ repo: "local", trash: true })).some((item) => item.id === work.id)).toBe(true);
    await works.restore(work.id, "local");
    const reopened = await works.open(work.id);
    expect(works.meta(reopened).meta.title).toBe("D");
  });

  it("refuses ids that could escape the works folder", async () => {
    await expect(works.open("../etc")).rejects.toThrow();
  });
});
