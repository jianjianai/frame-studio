import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validProjectId } from "./project-metadata.mjs";

const [id, title, ...rest] = process.argv.slice(2);
const renderer = rest.length ? rest[1] : "pixi";
if (
  !validProjectId(id) ||
  typeof title !== "string" ||
  !title.trim() ||
  (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--renderer")) ||
  !["canvas", "pixi", "three"].includes(renderer)
) {
  console.error(
    'Usage: pnpm animation:new my-film "我的动画" [--renderer pixi|three|canvas]',
  );
  process.exit(1);
}
const root = process.cwd();
const project = path.join(root, "src/projects", id);
const production = path.join(root, "production", id);
const assets = path.join(root, "public/films", id);
const test = path.join(root, "tests/e2e", id + ".spec.ts");
const destinations = [project, production, assets, test];
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
const cache = path.join(root, ".cache");
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
  for (const name of ["scene", "production", "assets"])
    await fs.mkdir(path.join(stage, name), { recursive: true });
  const meta = {
    id,
    title: title.trim(),
    subtitle: "新的故事，从这里开始。",
    description: `新建工程；文件和脚本说明见 production/${id}/README.md。`,
    renderer,
    duration: 24,
    fps: 30,
    accent: "#c5d7b1",
    poster: `films/${id}/poster.svg`,
    tags: ["制作中"],
    status: "draft",
    beats: [{ at: 0, title: "第一个镜头", detail: "用动作讲清发生了什么。" }],
    subtitles: [],
    credits: ["工程资源索引：production/" + id + "/README.md"],
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
  await fs.writeFile(path.join(stage, "scene/scene.ts"), sceneTemplate);
  await fs.writeFile(
    path.join(stage, "production/README.md"),
    recordTemplate
      .replaceAll("{{PROJECT_ID}}", id)
      .replaceAll("{{PROJECT_TITLE}}", title.trim().replace(/[\r\n]/g, " ")),
  );
  await fs.writeFile(path.join(stage, "assets/poster.svg"), poster);
  await fs.writeFile(
    path.join(stage, "test.ts"),
    testTemplate.replaceAll("__ID__", id),
  );
  await fs.writeFile(
    path.join(stage, "scene/project.ts"),
    "import type { AnimationProject } from '../../engine/types';\nconst project: AnimationProject = { ..." +
      JSON.stringify(meta, null, 2) +
      ", load: () => import('./scene') };\nexport default project;\n",
  );
  // Publish everything required by the scene before exposing the registry entry to import.meta.glob.
  for (const [from, to] of [
    ["assets", assets],
    ["production", production],
  ]) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await absent(to);
    await fs.rename(path.join(stage, from), to);
    published.push(to);
  }
  await fs.mkdir(path.dirname(test), { recursive: true });
  await fs.copyFile(path.join(stage, "test.ts"), test, constants.COPYFILE_EXCL);
  published.push(test);
  await fs.mkdir(path.dirname(project), { recursive: true });
  await absent(project);
  await fs.rename(path.join(stage, "scene"), project);
  published.push(project);
  console.log(
    `Created ${project}\nProject resource, engineering README and reverse-seek test are ready.\nNext: pnpm project:check ${id}\nEngineering index: production/${id}/README.md. No shared gallery or asset catalog was rewritten.`,
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
