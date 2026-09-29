import fs from "node:fs/promises";
import { projectPath } from "./project-paths.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validProjectId } from "./project-metadata.mjs";
import { ENGINE_PROTOCOL_VERSION } from "../src/engine/protocol.mjs";
import { compositionSchema } from "../src/engine/dimensions.mjs";

const [id, title, ...rest] = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < rest.length; i += 2) {
  if (
    !["--renderer", "--duration", "--fps", "--audio", "--width", "--height"].includes(rest[i]) ||
    !rest[i + 1] ||
    options.has(rest[i])
  )
    throw new Error("Unknown, duplicate or incomplete option: " + rest[i]);
  options.set(rest[i], rest[i + 1]);
}
const renderer = options.get("--renderer") ?? "pixi";
const duration = Number(options.get("--duration") ?? 24);
const fps = Number(options.get("--fps") ?? 30);
const audio = options.get("--audio") ?? "silent";
const composition = options.has("--width") || options.has("--height")
  ? compositionSchema.parse({ width: Number(options.get("--width")), height: Number(options.get("--height")) }) : undefined;
if (
  !validProjectId(id) ||
  typeof title !== "string" ||
  !title.trim() ||
  !["canvas", "pixi", "three"].includes(renderer) ||
  !Number.isFinite(duration) ||
  duration <= 0 ||
  duration > 3600 ||
  !Number.isInteger(fps) ||
  fps < 12 ||
  fps > 60 ||
  !["silent", "generated"].includes(audio)
) {
  console.error(
    'Usage: pnpm film new my-film "我的动画" [--renderer pixi|three|canvas] [--duration 24] [--fps 30] [--audio silent|generated] [--width 1080 --height 1920]',
  );
  process.exit(1);
}
const root = process.cwd();
const project = projectPath(root, id);
const destinations = [project];
async function absent(file) {
  try {
    await fs.lstat(file);
    throw new Error("Destination already exists; not overwritten: " + file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Check without creating anything first; duplicate/invalid input must not mutate existing work.
for (const destination of destinations) await absent(destination);
const cache = path.join(root, "projects", ".cache");
const lockRoot = path.join(cache, "new-project-locks"),
  lock = path.join(lockRoot, id);
await fs.mkdir(lockRoot, { recursive: true });
try {
  await fs.mkdir(lock);
} catch (error) {
  if (error.code === "EEXIST")
    throw new Error(
      "Another creation owns this id, or a crashed run left a lock: " +
        lock +
        ". Inspect it before removing it.",
    );
  throw error;
}
const stage = path.join(cache, "new-project-" + randomUUID());
const published = [];
try {
  for (const destination of destinations) await absent(destination);
  const [sceneTemplate, recordTemplate, testTemplate] = await Promise.all([
    fs.readFile(
      new URL("../templates/" + renderer + ".txt", import.meta.url),
      "utf8",
    ),
    fs.readFile(
      new URL("../templates/engineering.md", import.meta.url),
      "utf8",
    ),
    fs.readFile(
      new URL("../templates/project-e2e.txt", import.meta.url),
      "utf8",
    ),
  ]);
  for (const name of [
    "public",
    "production",
    "records",
    "scripts",
    "tests/e2e",
  ])
    await fs.mkdir(path.join(stage, name), { recursive: true });
  const meta = {
    id,
    title: title.trim(),
    subtitle: "新的故事，从这里开始。",
    description: `新建工程；文件和脚本说明见 projects/${id}/README.md。`,
    renderer,
    engineProtocol: ENGINE_PROTOCOL_VERSION,
    ...(composition ? { composition } : {}),
    duration,
    fps,
    ...(audio === "generated"
      ? {
          audioTracks: [
            { id: "melody", name: "旋律", kind: "generated", gain: 0.6 },
          ],
        }
      : {}),
    accent: "#c5d7b1",
    poster: `films/${id}/poster.svg`,
    tags: ["制作中"],
    status: "draft",
    beats: [{ at: 0, title: "第一个镜头", detail: "用动作讲清发生了什么。" }],
    subtitles: [],
    credits: ["工程资源索引：projects/" + id + "/README.md"],
  };
  const xml = (text) =>
    text.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[char],
    );
  const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#e4ead9"/><circle cx="640" cy="300" r="74" fill="#6e926f"/><text x="640" y="460" text-anchor="middle" font-family="sans-serif" font-size="44" fill="#355449">DRAFT / ${xml(id)}</text><text x="640" y="520" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#53675b">Placeholder — not a finished film poster</text></svg>`;
  await fs.writeFile(path.join(stage, "scene.ts"), sceneTemplate);
  await fs.writeFile(
    path.join(stage, "audio.ts"),
    await fs.readFile(
      new URL("../templates/audio.txt", import.meta.url),
      "utf8",
    ),
  );
  await fs.writeFile(
    path.join(stage, "README.md"),
    recordTemplate
      .replaceAll("{{PROJECT_ID}}", id)
      .replaceAll("{{PROJECT_TITLE}}", title.trim().replace(/[\r\n]/g, " ")),
  );
  await fs.writeFile(path.join(stage, "public/poster.svg"), poster);
  await fs.writeFile(
    path.join(stage, "tests/e2e/scene.spec.ts"),
    testTemplate.replaceAll("__ID__", id),
  );
  await fs.writeFile(
    path.join(stage, "project.ts"),
    "import type { AnimationProject } from '../../src/engine/types';\nconst project: AnimationProject = { ..." +
      JSON.stringify(meta, null, 2) +
      ", load: () => import('./scene')" +
      (audio === "generated" ? ", loadAudio: () => import('./audio')" : "") +
      " };\nexport default project;\n",
  );
  await fs.writeFile(
    path.join(stage, "AGENTS.md"),
    "# 修改边界\n\n仅允许修改 projects/" +
      id +
      "/ 内的文件。不得修改其他项目、公共引擎、UI、依赖或配置；需要公共能力时提出维护需求。运行 pnpm project:scope " +
      id +
      " 检查边界。\n",
  );
  await fs.writeFile(
    path.join(stage, "production/brief.md"),
    "# 制作说明\n\n## 本次任务\n记录用户要求与已确认的选择；未确认的内容标为待定。\n\n## 镜头和声音\n记录镜头时间、画面变化、音轨及资源来源。\n\n修改记录、验证报告和审查结论统一放在 [records](../records/README.md)。\n",
  );
  await fs.writeFile(
    path.join(stage, "records/README.md"),
    "# 项目过程记录\n\n本目录独立保存本视频的修改记录、验证报告和审查结论，建议按 YYYY-MM-DD-topic.md 命名。只记录实际发生的工作与检查，不把计划当作结果。\n\n工程说明见 [README](../README.md)，需求与设计见 [制作说明](../production/brief.md)。\n",
  );
  await fs.writeFile(path.join(stage, "public/assets.json"), "[]\n");
  await fs.writeFile(path.join(stage, "public/waveforms.json"), "{}\n");
  await fs.mkdir(path.dirname(project), { recursive: true });
  await absent(project);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(stage, project);
      break;
    } catch (error) {
      if (!["EPERM", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await absent(project);
    }
  }
  published.push(project);
  console.log(
    `Created ${project}\nProject resource, engineering README and reverse-seek test are ready.\nNext: pnpm film context ${id}\nCheck: pnpm film check ${id} --strict\nEngineering index: projects/${id}/README.md. No shared gallery or asset catalog was rewritten.`,
  );
} catch (error) {
  // Remove only paths this invocation successfully published; never delete a colliding destination.
  for (const file of published.reverse())
    await fs.rm(file, { recursive: true, force: true });
  throw error;
} finally {
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rmdir(lock);
}
