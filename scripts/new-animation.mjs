import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const [id, title] = args;
const ri = args.indexOf("--renderer");
const renderer = ri >= 0 ? args[ri + 1] : "pixi";
if (
  !id ||
  !title ||
  !/^[a-z][a-z0-9-]*$/.test(id) ||
  !["pixi", "three", "canvas"].includes(renderer)
) {
  console.error(
    'Usage: pnpm animation:new my-film "我的动画" --renderer pixi|three|canvas',
  );
  process.exit(1);
}
const dir = path.join(process.cwd(), "src/projects", id);
try {
  await fs.access(dir);
  throw new Error("Project already exists: " + id);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const template = await fs.readFile(
  new URL("../templates/" + renderer + ".txt", import.meta.url),
  "utf8",
);
await fs.mkdir(dir, { recursive: true });
const meta = {
  id,
  title,
  subtitle: "新的故事，从这里开始。",
  description: "请先完成分镜、美术素材与短样片，再扩展完整动画。",
  renderer,
  duration: 24,
  fps: 30,
  accent: "#c5d7b1",
  poster: "art/paper-plane.svg",
  tags: ["制作中"],
  status: "draft",
  beats: [{ at: 0, title: "第一个镜头", detail: "用动作讲清发生了什么。" }],
  subtitles: [],
  credits: ["请记录素材来源和授权"],
};
await fs.writeFile(
  path.join(dir, "project.ts"),
  "import type { AnimationProject } from '../../engine/types';\nconst project: AnimationProject = { ..." +
    JSON.stringify(meta, null, 2) +
    ", load: () => import('./scene') };\nexport default project;\n",
);
await fs.writeFile(path.join(dir, "scene.ts"), template);
console.log(
  "Created " + dir + "\nThe studio discovers this project automatically.",
);
