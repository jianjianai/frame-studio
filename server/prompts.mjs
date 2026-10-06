import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";
import { describeIssues } from "./tools/registry.mjs";

const id = z.string().min(1).max(64);
const prompt = z.strictObject({ id, type: z.literal("prompt"), name: z.string().trim().min(1).max(80), text: z.string().min(1).max(20000) });
const folder = z.strictObject({
  id,
  type: z.literal("folder"),
  name: z.string().trim().min(1).max(60),
  get children() {
    return z.array(z.union([prompt, folder])).max(500);
  },
});
const items = z.array(z.union([prompt, folder])).max(500);

const starter = () => {
  const item = (name, text) => ({ id: randomUUID(), type: "prompt", name, text });
  return [
    {
      id: randomUUID(),
      type: "folder",
      name: "常用",
      children: [
        item("检查并修复", "检查作品，发现问题就修复。"),
        item("看看整体效果", "用 storyboard 看一下整体效果，告诉我节奏、画面和声音上最值得改进的三个地方，先不要动手改。"),
        item("更有电影感", "让现在这个画面的配色和光影更有电影感。"),
      ],
    },
    {
      id: randomUUID(),
      type: "folder",
      name: "经验",
      children: [
        item(
          "整理经验",
          "回顾我们这次的对话和作品的修改，把在同类作品里值得复用的做法、我明确表达过的偏好、踩过的坑和解决办法整理进经验库。先阅读现有内容，按主题合并到已有文档，不要重复，过时的说法直接改掉；改完简单告诉我改了哪些文档。",
        ),
      ],
    },
  ];
};

function count(list, depth = 1) {
  if (depth > 6) throw problem(400, "文件夹最多 6 层");
  return list.reduce((sum, item) => sum + 1 + (item.type === "folder" ? count(item.children, depth + 1) : 0), 0);
}

/**
 * The prompt library: the user's own prompts in folders, like bookmarks, shared by all
 * works. Kept in settings.json and saved as a whole tree (the UI edits it in place).
 */
export function promptsPlugin(services) {
  const { router, settings } = services;
  const read = () => settings.get("prompts") ?? settings.update("prompts", starter());
  router.get("/api/prompts", () => read());
  router.put("/api/prompts", async ({ req }) => {
    const parsed = items.safeParse((await readJson(req))?.items);
    if (!parsed.success) throw problem(400, "提示词格式不正确：" + describeIssues(parsed.error.issues));
    if (count(parsed.data) > 2000) throw problem(400, "提示词太多了（最多 2000 项）");
    const ids = new Set();
    const walk = (list) =>
      list.forEach((item) => {
        if (ids.has(item.id)) throw problem(400, "提示词 id 重复");
        ids.add(item.id);
        if (item.type === "folder") walk(item.children);
      });
    walk(parsed.data);
    return settings.update("prompts", parsed.data);
  });
}
