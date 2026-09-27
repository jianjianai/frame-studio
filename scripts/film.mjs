import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readProject,
  readProjectCatalog,
  validProjectId,
} from "./project-metadata.mjs";
import { projectPath } from "./project-paths.mjs";

export const commandHelp = `FRAME · 视频制作工具
  pnpm film list [--json]                     列出项目
  pnpm film inspect <id> [--json]             元数据、素材、音轨和时间标记
  pnpm film context <id> [--json]             AI 接手上下文与修改边界（只读）
  pnpm film new <id> "标题" --renderer canvas|pixi|three
    [--duration 24] [--fps 30] [--audio silent|generated]
  pnpm film check <id> [--strict] [--json]     结构与接口检查（只读）
  pnpm film scope <id> [--base <commit>]      检查 Git 修改范围（只读）
  pnpm film storyboard <id> [--times "0,2,5"] [--width 480] [--force]
  pnpm film frame <id> --frame 150 | --time 5 [--width 1280] [--force]
  pnpm film render <id> [--start 0 --end 3] [--width 1920 --fps 30] [--force]
  pnpm film poster <id>                       更新本项目封面
  pnpm film import <id> <file> --license "来源与许可"
  pnpm film doctor                          环境检查（只读）
输出默认在 projects/<id>/exports/；--out 只能指定本项目内路径。
--force 明确覆盖已有输出。new 拒绝覆盖；poster 明确更新封面。
机器读取使用 pnpm --silent film ... --json；错误退出码非零。
`;

export function inspectProject(root, id) {
  if (!validProjectId(id)) throw new Error("Invalid project id");
  const folder = projectPath(root, id);
  const metadataFile = projectPath(root, id, "project.ts");
  if (!fs.existsSync(metadataFile)) throw new Error("Unknown project: " + id);
  const entry = readProject(metadataFile);
  const read = (name) => {
    const file = projectPath(root, id, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const meta = entry.meta;
  return {
    schemaVersion: 1,
    id,
    folder,
    metadata: meta,
    entrypoints: { scene: entry.loadPath, audio: entry.audioLoadPath ?? null },
    audioTracks:
      meta.audioTracks ??
      (meta.audio ? [{ id: "main", kind: "file", src: meta.audio }] : []),
    assets: JSON.parse(read("public/assets.json") ?? "[]"),
    writeBoundary: `projects/${id}/`,
    outputDirectory: projectPath(root, id, "exports"),
    recordDirectory: projectPath(root, id, "records"),
    files: {
      instructions: read("AGENTS.md"),
      readme: read("README.md"),
      brief: read("production/brief.md"),
    },
    commands: {
      check: `pnpm film check ${id} --strict --json`,
      scope: `pnpm film scope ${id}`,
      storyboard: `pnpm film storyboard ${id}`,
      frame: `pnpm film frame ${id} --frame 0`,
      render: `pnpm film render ${id}`,
    },
  };
}

export function runFilm(args, root = process.cwd()) {
  const [command = "help", ...rest] = args;
  if (["help", "--help", "-h"].includes(command)) {
    console.log(commandHelp);
    return 0;
  }
  if (["list", "inspect", "context"].includes(command)) {
    const json = rest.includes("--json");
    const positional = rest.filter((arg) => arg !== "--json");
    if (
      (command === "list" && positional.length) ||
      (command !== "list" && positional.length !== 1)
    )
      throw new Error("Unexpected arguments; run pnpm film help");
    if (command === "list") {
      const projects = readProjectCatalog(root).map(({ directory, meta }) => ({
        id: directory,
        title: meta.title,
        renderer: meta.renderer,
        duration: meta.duration,
        fps: meta.fps,
        status: meta.status,
        folder: `projects/${directory}/`,
      }));
      console.log(
        json
          ? JSON.stringify({ schemaVersion: 1, projects }, null, 2)
          : projects
              .map(
                (p) =>
                  `${p.id}\t${p.title}\t${p.duration}s / ${p.fps}fps\t${p.folder}`,
              )
              .join("\n"),
      );
    } else {
      const report = inspectProject(root, positional[0]);
      if (command === "context") {
        report.workflow = [
          "Read AGENTS.md, docs/NEW-PROJECT-STANDARD.md, docs/AUTHORING.md and docs/AI-WORKFLOW.md",
          "Only edit the project's writeBoundary; shared changes need a workbench maintenance task",
          "Scene.render(time) and generated audio must support arbitrary absolute time; seed randomness",
          "Use context/inspect/check for facts; storyboard/frame for visual review; never equate structural checks with content acceptance",
          "Use a short render to verify timing and audio before a full export; do not repeat full renders without a reason",
          "Keep private script usage in the project README; put change logs, validation reports and reviews in recordDirectory, separate from README and production/brief.md",
        ];
      }
      console.log(
        json
          ? JSON.stringify(report, null, 2)
          : `# ${report.metadata.title} (${report.id})\n\nWrite only: ${report.writeBoundary}\nRecords: ${report.recordDirectory}\n\n${report.files.instructions ?? ""}\n${report.files.readme ?? ""}\n${report.files.brief ?? ""}\n\n${report.workflow?.map((s) => "- " + s).join("\n") ?? ""}\n\nMetadata:\n${JSON.stringify(report.metadata, null, 2)}\n\nCommands:\n${Object.values(report.commands).join("\n")}`,
      );
    }
    return 0;
  }
  const routes = {
    new: ["new-animation.mjs", ...rest],
    check: ["check-projects.mjs", ...rest],
    scope: ["project-scope.mjs", ...rest],
    frame: ["render.mjs", "--frame-mode", ...rest],
    render: ["render.mjs", ...rest],
    storyboard: ["storyboard.mjs", ...rest],
    poster: ["render.mjs", "--posters", "--project", ...rest],
    import: ["import-asset.mjs", ...rest],
    doctor: ["doctor.mjs"],
  };
  const route = routes[command];
  if (!route)
    throw new Error("Unknown command: " + command + "; run pnpm film help");
  if (command === "doctor" ? rest.length > 0 : !validProjectId(rest[0]))
    throw new Error("Expected a project id; run pnpm film help");
  if (command === "poster" && rest.length !== 1)
    throw new Error("Use pnpm film poster <id>");
  const [script, ...forwarded] = route;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), ...forwarded],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = runFilm(process.argv.slice(2));
  } catch (error) {
    if (process.argv.includes("--json"))
      console.log(JSON.stringify({ schemaVersion: 1, error: error.message }));
    else console.error(error.message);
    process.exitCode = 1;
  }
}
