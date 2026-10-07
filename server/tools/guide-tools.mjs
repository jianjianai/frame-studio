import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appRoot } from "../config.mjs";
import { problem } from "../util.mjs";

const guideDir = path.join(appRoot, "docs", "guide");

/** Guides are plain Markdown in docs/guide/<topic>.md; the first heading is the title. */
export function guideTopics() {
  if (!fs.existsSync(guideDir)) return [];
  return fs
    .readdirSync(guideDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(guideDir, name), "utf8");
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? name;
      const summary =
        text
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#"))
          ?.trim() ?? "";
      return { topic: name.replace(/\.md$/, ""), title, summary };
    });
}

export function registerGuideTools(registry) {
  registry.add({
    name: "frame_guide",
    title: "制作指南",
    description:
      "FRAME 作品的接口说明和可复制示例：场景协议、图层合成、Canvas/Pixi/Three/Babylon/Lottie/Remotion 接入、音频与混音、素材、字幕、配音、导出。不传 topic 返回目录与总览；一次查几个主题用 topics。写代码前查对应主题，不要猜接口。",
    readOnly: true,
    input: {
      topic: z.string().optional().describe("主题名，例如 scene、layers、three、audio"),
      topics: z.array(z.string()).max(8).optional().describe("一次读几个主题"),
    },
    async run({ topic, topics: wanted }) {
      const topics = guideTopics();
      const read = (name) => {
        const file = path.join(guideDir, `${name}.md`);
        if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) throw problem(404, `没有主题 ${name}。可用主题：${topics.map((item) => item.topic).join("、")}`);
        return fs.readFileSync(file, "utf8");
      };
      if (wanted?.length) return { data: { topics: wanted }, text: wanted.map((name) => read(name)).join("\n\n---\n\n") };
      const name = topic || "overview";
      const text = read(name);
      const index = topic ? "" : "\n\n## 全部主题\n" + topics.map((item) => `- \`${item.topic}\`：${item.title} — ${item.summary}`).join("\n");
      return { data: { topic: name, topics: topics.map((item) => item.topic) }, text: text + index };
    },
  });
}
