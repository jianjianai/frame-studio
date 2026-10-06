import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  clip,
  quote,
  describeDocument,
  experienceDelta,
  filesNotice,
  libraryBrief,
  noteSeen,
  readLibrary,
  rebaseSeen,
  referencedExperience,
  selectionText,
  snapshotFiles,
} from "../server/ai/context.mjs";
import { confirmsChanges } from "../server/ai/manager.mjs";

const library = { id: "知识类视频", title: "知识类视频" };
function makeLibrary(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-library-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
const current = (root) => ({ library, documents: readLibrary(root) });

describe("session brief and per-message context", () => {
  it("describes documents by their heading and first line", () => {
    expect(describeDocument("开场.md", "# 开场\n\n- 前 2 秒抛出问题\n- 第二条")).toEqual({ title: "开场", summary: "前 2 秒抛出问题" });
    expect(describeDocument("x/无标题.md", "```js\n# not a heading\n```\n正文")).toEqual({ title: "无标题", summary: "正文" });
  });

  it("clips by bytes and quotes documents verbatim", () => {
    expect(clip("中文字符", 7)).toEqual({ text: "中文", cut: true });
    const doc = "# 标题\n\n```js\nconst a = 1;\n```\n";
    expect(quote(doc)).toBe("````markdown\n# 标题\n\n```js\nconst a = 1;\n```\n````");
  });

  it("puts a small library into the brief in full, README first", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n用户偏好：暖色", "开场.md": "# 开场\n\n前 2 秒抛出问题" });
    const brief = libraryBrief(library, readLibrary(root));
    expect(brief.full).toBe(true);
    expect(brief.text.indexOf("### README.md")).toBeLessThan(brief.text.indexOf("### 开场.md"));
    // Byte-identical to the file, so the AI can copy text into an exact-match edit.
    expect(brief.text).toContain("```markdown\n# 开场\n\n前 2 秒抛出问题\n```");
    expect(Object.values(brief.seen.docs).every((entry) => entry.level === "content")).toBe(true);
  });

  it("gives a large library as README plus an index", () => {
    const big = "一段很长的经验。".repeat(600); // 14 KB, over the 12 KB inline budget
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n偏好", "长文.md": `# 长文\n\n讲转场节奏\n\n${big}` });
    const brief = libraryBrief(library, readLibrary(root));
    expect(brief.full).toBe(false);
    expect(brief.text).toContain("`长文.md` 长文：讲转场节奏");
    expect(brief.text).not.toContain(big.slice(0, 50));
    expect(brief.seen.docs["README.md"].level).toBe("content");
    expect(brief.seen.docs["长文.md"].level).toBe("index");
  });

  it("says nothing when nothing changed, and only what others changed otherwise", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n偏好：暖色", "开场.md": "# 开场\n\n前 2 秒抛出问题" });
    const { seen } = libraryBrief(library, readLibrary(root));
    expect(experienceDelta(seen, current(root)).text).toBe("");

    fs.writeFileSync(path.join(root, "开场.md"), "# 开场\n\n前 1 秒抛出问题");
    fs.writeFileSync(path.join(root, "配色.md"), "# 配色\n\n深蓝渐变");
    let delta = experienceDelta(seen, current(root));
    expect(delta.text).toContain("### 开场.md（已更新，最新内容）");
    expect(delta.text).toContain("前 1 秒抛出问题");
    expect(delta.text).toContain("### 配色.md（新增，最新内容）");
    expect(experienceDelta(delta.seen, current(root)).text).toBe("");

    fs.rmSync(path.join(root, "配色.md"));
    delta = experienceDelta(delta.seen, current(root));
    expect(delta.text).toContain("`配色.md` 已删除");
  });

  it("does not report what the AI read or wrote itself", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频", "开场.md": "# 开场\n\n前 2 秒" });
    let { seen } = libraryBrief(library, readLibrary(root));
    fs.writeFileSync(path.join(root, "开场.md"), "# 开场\n\n前 1 秒");
    const written = readLibrary(root).find((doc) => doc.path === "开场.md");
    seen = noteSeen(seen, library.id, "开场.md", written.hash);
    expect(experienceDelta(seen, current(root)).text).toBe("");
    seen = noteSeen(seen, "别的库", "开场.md", "x");
    expect(experienceDelta(seen, current(root)).text).toBe("");
  });

  it("reports a stale large document the AI had read, without repeating its content", () => {
    const big = "很长的内容。".repeat(1500);
    const root = makeLibrary({ "README.md": "# 知识类视频", "长文.md": `# 长文\n\n${big}` });
    let { seen } = libraryBrief(library, readLibrary(root));
    const doc = readLibrary(root).find((item) => item.path === "长文.md");
    seen = noteSeen(seen, library.id, "长文.md", doc.hash, "content");
    fs.writeFileSync(path.join(root, "长文.md"), `# 长文\n\n${big}改`);
    const delta = experienceDelta(seen, current(root));
    expect(delta.text).toContain("`长文.md` 已修改，你之前读到的内容已过时");
    expect(delta.text.length).toBeLessThan(500);
  });

  it("introduces a newly linked library and forgets an unlinked one", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n偏好" });
    const linked = experienceDelta(null, current(root));
    expect(linked.text).toContain("作品现在关联经验库「知识类视频」");
    expect(linked.text).toContain("偏好");
    const switched = experienceDelta({ library: "音乐视频", title: "音乐视频", docs: {} }, current(root));
    expect(switched.text).toContain("替换了「音乐视频」");
    expect(experienceDelta(linked.seen, null)).toEqual({ text: "作品已不再关联经验库「知识类视频」，之前读到的那些经验不再适用于这个作品。", seen: null });
    expect(experienceDelta(null, null)).toEqual({ text: "", seen: null });
  });

  it("gives a referenced document the AI only knows by title", () => {
    const big = "一段很长的经验。".repeat(600);
    const root = makeLibrary({ "README.md": "# 知识类视频", "开场.md": "# 开场\n\n前 2 秒", "长文.md": `# 长文\n\n${big}` });
    const { seen } = libraryBrief(library, readLibrary(root));
    expect(seen.docs["开场.md"].level).toBe("index");
    const referenced = referencedExperience(seen, current(root), ["开场.md", "长文.md", "README.md", "不存在.md"]);
    expect(referenced.text).toBe("### 开场.md（用户引用的经验库文档）\n\n```markdown\n# 开场\n\n前 2 秒\n```");
    expect(referenced.seen.docs["开场.md"].level).toBe("content");
    expect(referencedExperience(referenced.seen, current(root), ["开场.md"]).text).toBe("");
  });

  it("keeps what a resumed conversation already read", () => {
    const baseline = { library: "a", title: "A", docs: { "README.md": { hash: "r2", level: "content" }, "x.md": { hash: "x2", level: "index" } } };
    const previous = { library: "a", title: "A", docs: { "x.md": { hash: "x1", level: "content" } } };
    expect(rebaseSeen(previous, baseline).docs["x.md"]).toEqual({ hash: "x1", level: "content" });
    expect(rebaseSeen({ ...previous, library: "b" }, baseline)).toBe(baseline);
    expect(rebaseSeen(previous, null)).toBeNull();
  });

  it("notices files changed between turns", () => {
    const dir = makeLibrary({ "visual.json": "{}", "scene.ts": "x" });
    const before = snapshotFiles(dir);
    expect(filesNotice(before, snapshotFiles(dir))).toBe("");
    fs.writeFileSync(path.join(dir, "visual.json"), '{"changed":true}');
    fs.writeFileSync(path.join(dir, "new.ts"), "y");
    fs.rmSync(path.join(dir, "scene.ts"));
    const notice = filesNotice(before, snapshotFiles(dir));
    expect(notice).toContain("修改 visual.json；新增 new.ts；删除 scene.ts");
    expect(notice).toContain("先读取最新内容");
    expect(filesNotice(null, snapshotFiles(dir))).toBe("");
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}.ts`, "1"]));
    expect(filesNotice({}, many)).toContain(`等 20 个文件`);
    expect(LIMITS.changedFiles).toBe(12);
  });

  it("knows which agent modes confirm changes", () => {
    const meta = (mode, extra = []) => ({ configOptions: [{ id: "mode", currentValue: mode }, ...extra], modes: { currentModeId: "agent" } });
    expect(["default", "plan", "read-only"].map((mode) => confirmsChanges(meta(mode)))).toEqual([true, true, true]);
    expect(["acceptEdits", "auto", "bypassPermissions", "workspace-write", "agent", "agent-full-access"].some((mode) => confirmsChanges(meta(mode)))).toBe(false);
    expect(confirmsChanges(meta("workspace-write", [{ id: "collaboration_mode", currentValue: "plan" }]))).toBe(true);
    expect(confirmsChanges({ modes: { currentModeId: "default" } })).toBe(true);
    expect(confirmsChanges({})).toBe(false);
  });

  it("describes the selected timeline object", () => {
    const meta = {
      visual: { clips: [{ id: "title", name: "标题", start: 0, duration: 4 }] },
      audioDocument: { tracks: [{ id: "t1", name: "配音" }], clips: [{ id: "c1", track: "t1", start: 1, duration: 2 }] },
      subtitles: [{ start: 1, end: 3, text: "你好" }],
      beats: [{ at: 2, title: "开场" }],
    };
    expect(selectionText({ kind: "layer", id: "title" }, meta)).toBe("图层 title「标题」（0:00.00–0:04.00）");
    expect(selectionText({ kind: "audio", id: "c1" }, meta)).toBe("音频片段 c1（音轨「配音」，0:01.00–0:03.00）");
    expect(selectionText({ kind: "track", id: "t1" }, meta)).toBe("音轨「配音」（t1）");
    expect(selectionText({ kind: "subtitle", id: "sub:0", index: 0 }, meta)).toBe("字幕「你好」（0:01.00–0:03.00）");
    expect(selectionText({ kind: "beat", id: "beat:0", index: 0 }, meta)).toBe("镜头标记「开场」（0:02.00）");
    expect(selectionText({ kind: "layer", id: "gone" }, meta)).toBe("");
  });
});
