import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectPath } from "../../../scripts/project-paths.mjs";
import { filmSources } from "./sources.mjs";

const id = process.argv[2];
if (process.argv.length !== 3)
  throw new Error(
    "Usage: node tests/fixtures/toolchain-film/create.mjs <new-project-id>",
  );
const root = process.cwd(),
  folder = projectPath(root, id);
if (fs.existsSync(folder))
  throw new Error(
    "Fixture creation never overwrites an existing project. Choose a new ID.",
  );
const result = spawnSync(
  process.execPath,
  [
    "scripts/film.mjs",
    "new",
    id,
    "一束光的旅程 · 工具链验收",
    "--renderer",
    "canvas",
    "--duration",
    "24",
    "--fps",
    "30",
    "--audio",
    "generated",
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.error || result.status !== 0)
  throw new Error(result.error?.message ?? result.stderr ?? "Scaffold failed");
for (const [name, content] of Object.entries(filmSources(id)))
  fs.writeFileSync(path.join(folder, name), content);
console.log(
  JSON.stringify({
    project: id,
    directory: folder,
    duration: 24,
    fps: 30,
    generatedTracks: 2,
    next: `pnpm film validate ${id}`,
  }),
);
