import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  quote,
  describeDocument,
  experienceKnown,
  experienceDelta,
  filesNotice,
  libraryOverview,
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
const now = (root) => [{ library, documents: readLibrary(root) }];
const known = (root) => experienceKnown(now(root));

describe("session brief and per-message context", () => {
  it("describes documents by their heading and first line", () => {
    expect(describeDocument("开场.md", "# 开场\n\n- 前 2 秒抛出问题\n- 第二条")).toEqual({ title: "开场", summary: "前 2 秒抛出问题" });
    expect(describeDocument("x/无标题.md", "```js\n# not a heading\n```\n正文")).toEqual({ title: "无标题", summary: "正文" });
  });

  it("quotes documents verbatim", () => {
    const doc = "# 标题\n\n```js\nconst a = 1;\n```\n";
    expect(quote(doc)).toBe("````markdown\n# 标题\n\n```js\nconst a = 1;\n```\n````");
  });

  it("knows every document of a linked library by name when a session starts, none read", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n用户偏好：暖色", "开场.md": "# 开场\n\n前 2 秒抛出问题" });
    const seen = known(root);
    expect(Object.keys(seen[library.id].docs)).toEqual(["README.md", "开场.md"]);
    expect(Object.values(seen[library.id].docs).every((entry) => entry.level === "index")).toBe(true);
  });

  it("shows a library's README in full and every document by title, however the AI organized it", () => {
    const long = "一个作品的完整经过和数据。".repeat(800);
    const root = makeLibrary({
      "README.md": "# 知识类视频\n\n偏好：暖色",
      "开场.md": "# 开场\n\n前 2 秒抛出问题",
      "例子/开场.md": `# 开场的例子\n\n三部作品的对比\n\n${long}`,
    });
    const text = libraryOverview(library, readLibrary(root));
    // Byte-identical to the file, so the AI can copy text into an exact-match edit.
    expect(text).toContain("### README.md\n\n```markdown\n# 知识类视频\n\n偏好：暖色\n```");
    expect(text).toContain("### 文档\n\n- `开场.md` 开场：前 2 秒抛出问题");
    expect(text).toContain("- `例子/开场.md` 开场的例子：三部作品的对比");
    expect(text).not.toContain(long.slice(0, 40));
  });

  it("says nothing when nothing changed, and only what others changed otherwise", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n偏好：暖色", "开场.md": "# 开场\n\n前 2 秒抛出问题" });
    const seen = known(root);
    expect(experienceDelta(seen, now(root)).text).toBe("");

    fs.writeFileSync(path.join(root, "开场.md"), "# 开场\n\n前 1 秒抛出问题");
    fs.writeFileSync(path.join(root, "配色.md"), "# 配色\n\n深蓝渐变");
    let delta = experienceDelta(seen, now(root));
    // By name only: the AI reads what it needs.
    expect(delta.text).toBe("经验库「知识类视频」有变化（来自用户或其他对话，不是你改的）：\n- `开场.md` 已修改\n- 新增 `配色.md` 配色：深蓝渐变（约 10 字）");
    expect(experienceDelta(delta.seen, now(root)).text).toBe("");

    fs.rmSync(path.join(root, "配色.md"));
    delta = experienceDelta(delta.seen, now(root));
    expect(delta.text).toContain("`配色.md` 已删除");
  });

  it("does not report what the AI read or wrote itself", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频", "开场.md": "# 开场\n\n前 2 秒" });
    let seen = known(root);
    fs.writeFileSync(path.join(root, "开场.md"), "# 开场\n\n前 1 秒");
    const written = readLibrary(root).find((doc) => doc.path === "开场.md");
    seen = noteSeen(seen, library.id, "开场.md", written.hash);
    expect(experienceDelta(seen, now(root)).text).toBe("");
    expect(noteSeen(seen, "别的库", "开场.md", "x")).toBe(seen);
  });

  it("tells the AI when a document it had read changed, without repeating its content", () => {
    const big = "很长的内容。".repeat(1500);
    const root = makeLibrary({ "README.md": "# 知识类视频", "长文.md": `# 长文\n\n${big}` });
    let seen = known(root);
    const doc = readLibrary(root).find((item) => item.path === "长文.md");
    seen = noteSeen(seen, library.id, "长文.md", doc.hash, "content");
    fs.writeFileSync(path.join(root, "长文.md"), `# 长文\n\n${big}改`);
    const delta = experienceDelta(seen, now(root));
    expect(delta.text).toContain("`长文.md` 已修改，你之前读到的内容已过时");
    expect(delta.text.length).toBeLessThan(500);
  });

  it("introduces a newly linked library and forgets an unlinked one", () => {
    const root = makeLibrary({ "README.md": "# 知识类视频\n\n偏好" });
    const linked = experienceDelta({}, now(root));
    expect(linked.text).toBe("作品现在关联了经验库「知识类视频」（id 知识类视频），需要时用 experience_read 读。");
    expect(linked.seen[library.id].docs["README.md"].level).toBe("index");
    const second = makeLibrary({ "README.md": "# 通用\n\n规范" });
    const both = experienceDelta(linked.seen, [...now(root), { library: { id: "通用", title: "通用" }, documents: readLibrary(second) }]);
    expect(both.text).toBe("作品现在关联了经验库「通用」（id 通用），需要时用 experience_read 读。"); // the first library is known already
    expect(experienceDelta(linked.seen, [])).toEqual({ text: "作品不再关联经验库「知识类视频」，之前读到的那些经验不再适用于这个作品。", seen: {} });
    expect(experienceDelta({}, [])).toEqual({ text: "", seen: {} });
  });

  it("gives a referenced document the AI only knows by title", () => {
    const big = "一段很长的经验。".repeat(600);
    const root = makeLibrary({ "README.md": "# 知识类视频", "开场.md": "# 开场\n\n前 2 秒", "长文.md": `# 长文\n\n${big}` });
    const seen = known(root);
    expect(seen[library.id].docs["开场.md"].level).toBe("index");
    const refs = ["开场.md", "长文.md", "README.md", "不存在.md"].map((file) => ({ library: library.id, path: file }));
    const referenced = referencedExperience(seen, now(root), refs);
    // Small ones the AI has not read come along (the README too: a session starts knowing names only).
    expect(referenced.text).toBe(
      "### 开场.md（用户引用的经验库「知识类视频」文档）\n\n```markdown\n# 开场\n\n前 2 秒\n```\n\n### README.md（用户引用的经验库「知识类视频」文档）\n\n```markdown\n# 知识类视频\n```",
    );
    expect(referenced.seen[library.id].docs["开场.md"].level).toBe("content");
    expect(referencedExperience(referenced.seen, now(root), [{ path: "开场.md" }]).text).toBe("");
  });

  it("keeps what a resumed conversation already read", () => {
    const baseline = { a: { title: "A", docs: { "README.md": { hash: "r2", level: "content" }, "x.md": { hash: "x2", level: "index" } } } };
    const previous = { a: { title: "A", docs: { "x.md": { hash: "x1", level: "content" } } }, gone: { title: "旧", docs: {} } };
    const rebased = rebaseSeen(previous, baseline);
    expect(rebased.a.docs["x.md"]).toEqual({ hash: "x1", level: "content" });
    expect(Object.keys(rebased)).toEqual(["a"]);
    expect(rebaseSeen(previous, {})).toEqual({});
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

describe("session brief", () => {
  it("tells the agent to answer in the user's language, and little else", async () => {
    const { platformInstructions } = await import("../server/templates.mjs");
    const brief = platformInstructions();
    // Claude answered a Chinese request in English.
    expect(brief).toContain("和用户交流用用户的语言（默认简体中文）");
    expect(brief).toContain("一篇文档太长、不好读也不好找时，按主题拆成几篇");
    // Basic rules only: the rest is in frame_guide and the tools' own descriptions.
    expect(Buffer.byteLength(brief)).toBeLessThan(4000);
  });
});
