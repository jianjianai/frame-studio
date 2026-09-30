import fs from "node:fs";
import { authoringState } from "./authoring-state.mjs";
import { referenceCatalog, readAuthoringReference } from "./authoring-reference.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { commandCatalog, describeFilmCommand } from "./film-command-catalog.mjs";
import { adapters } from "../src/engine/adapters.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { readProject, validProjectId } from "./project-metadata.mjs";
import { projectPath } from "./project-paths.mjs";

export const commandHelp = `FRAME · 视频制作工具
  pnpm film platform help                   远程平台 CLI（作品 UUID），任务等待/上传/下载
  pnpm film describe <command> [action] --json  精确参数、请求结构和默认值
  pnpm film reference [name] --json             参考文档目录或正文
  pnpm film list [--json]                     列出项目
  pnpm film inspect <id> [--json]             元数据、素材、音轨和时间标记
  pnpm film context <id> [--json]             AI 接手上下文与修改边界（只读）
  pnpm film new <id> "标题" [--renderer composition|canvas|pixi|three|babylon|remotion]
    [--duration 24] [--fps 30] [--audio silent|generated] [--width 1080 --height 1920]
  pnpm film audio engines --json
  pnpm film audio <id> [edit --input request.json] --json
  pnpm film audio <id> export --format wav|flac|mp3|ogg|m4a [--stems] [--start 0 --end 10]
  pnpm film audio-media <id> probe|inspect|transcode --src films/<id>/file --out public/compatible.wav
  pnpm film composition engines --json
  pnpm film composition <id> [get|edit --input request.json] --json
  pnpm film media <id> probe|transcode --src films/<id>/file [--out public/compatible.webm]
  pnpm film check <id> [--strict] [--json]     结构与接口检查（只读）
  pnpm film scope <id> [--base <commit>] [--json]  分类报告 Git 修改范围（只读）
  pnpm film operation <id> [--recover <lock-id>] [--json]  查询操作或恢复已退出实例的遗留锁
  pnpm film storyboard <id> [--times "0,2,5"] [--width 480] [--force]
  pnpm film frame <id> --frame 150 | --time 5 [--width 1280] [--force]
  pnpm film render <id> [--start 0 --end 3] [--width 1920 --fps 30] [--force]
  pnpm film poster <id>                       更新本项目封面
  pnpm film import <id> <file> --license "来源与许可"
  pnpm film asset <id> upload <file> --license "来源与许可" [--resume <upload-id>] [--remote] [--json]
  pnpm film asset <id> fetch <https-url> --filename <name> --license "来源与许可" [--remote] [--json]
  pnpm film asset <id> status|complete|abort --id <upload-id> [--remote] [--json]
  pnpm film asset <id> prune|capabilities [--json]  清理本人过期缓存或查询传输限制
  pnpm film doctor                          环境检查（只读）
  pnpm film mcp [--project <id>] [--read-only]  启动 AI 编辑 MCP 服务
  pnpm film mcp-remote init|check|serve|revoke [--env-file .env]  OAuth/Bearer 远程接入
  pnpm film dev|typecheck|test|build|validate <id> [--json]  单项目运行与验证
  pnpm film search <id> --query "文字" [--directory music] [--json]
  pnpm film read <id> --path scene.ts [--line 1 --lines 100] [--json]
  pnpm film edit|patch <id> --input changes.json [--dry-run] [--json]
  pnpm film checkpoint <id> [--label "修改前"] [--json]
  pnpm film history <id> [--json]
  pnpm film restore <id> --checkpoint <uuid> --expected <fingerprint> [--apply]
  pnpm film review <id> --start 0 --end 6 [--width 640 --fps 24] [--json]
  pnpm film compare <id> --a <review-id> --b <review-id> [--json]
  pnpm film verify <id> --file projects/<id>/exports/film.mp4 [--json]
  pnpm film export <id> [--width 1920 --fps 30] [--start 0 --end 6]
    [--segment-seconds 10] [--resume <render-id>] [--json]  预检、分段恢复、成片验收
  pnpm film playback <id> [--start 0 --duration 2] [--json]  播放/暂停/冷跳/倍速检查
  pnpm film test-e2e <id> [--json]            单项目浏览器测试
  pnpm film review-note <id> --review <uuid> --input note.json [--json]
  pnpm film narrate <id> --input production/narration.json [--json]
  pnpm film speech <id> init --provider edge|openai|azure|custom [--voice <voice>] [--json]
  pnpm film speech <id> status|voices [--provider <name> --locale zh-CN] [--json]
  pnpm film speech <id> say --text "语音试听" [--provider <name> --speaker <role> --voice <voice>] [--json]
  pnpm film workspace <id> [--json]          建立可编辑的独立工作副本与 Git 基线
  pnpm film job <id> start --kind export --input options.json [--json]
  pnpm film job <id> status|cancel --id <job-id> [--json]
  pnpm film job <id> wait --id <job-id> [--deadline-seconds 20] [--json]
局部补丁与旁白 JSON 示例见 docs/AI-PRODUCTION.md；--input - 从 stdin 读取 JSON。
输出默认在 projects/<id>/exports/；--out 只能指定本项目内路径。
--force 明确覆盖已有输出。new 拒绝覆盖；poster 明确更新封面。
机器读取使用 pnpm --silent film ... --json；错误退出码非零。
`;

export function inspectProject(root, id, { detail = true } = {}) {
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
  const { visual, audioDocument, ...compactMetadata } = meta;
  if (audioDocument) { delete compactMetadata.audioTracks; delete compactMetadata.audio; }
  return {
    schemaVersion: 1,
    id,
    folder,
    metadata: detail ? meta : compactMetadata,
    detail,
    ...authoringState(entry),
    adapters,
    ...(detail ? { visual: visual ?? null, audioDocument: audioDocument ?? null } : {}),

    assets: JSON.parse(read("public/assets.json") ?? "[]"),
    writeBoundary: `projects/${id}/`,
    outputDirectory: projectPath(root, id, "exports"),
    recordDirectory: projectPath(root, id, "records"),
    speech: {
      configPath: "production/speech.json",
      configured: fs.existsSync(
        projectPath(root, id, "production/speech.json"),
      ),
      reference: "speech",
      statusTool: "frame_speech_status",
    },
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
      validate: `pnpm film validate ${id} --json`,
      browserTests: `pnpm film test-e2e ${id} --json`,
      playback: `pnpm film playback ${id} --json`,
      review: `pnpm film review ${id} --start 0 --end ${Math.min(meta.duration, 6)} --json`,
      export: `pnpm film export ${id} --json`,
      history: `pnpm film history ${id} --json`,
      speech: `pnpm film speech ${id} status --json`,
    },
  };
}

export function runFilm(args, root = process.cwd()) {
  const [command = "help", ...rest] = args;
  if (["help", "describe", "--help", "-h"].includes(command) || (command !== "platform" && (rest.includes("--help") || rest.includes("-h")))) {
    const isRoot = ["help", "describe", "--help", "-h"].includes(command);
    const positional = rest.filter(arg => !["--json", "--help", "-h"].includes(arg));
    const target = isRoot ? positional[0] : command;
    const action = isRoot ? positional[1] : (positional[0] === "engines" ? "engines" : positional[1]);
    if (isRoot && positional.length > 2) throw new Error("Use film describe <command> [action] --json");
    const descriptor = target ? describeFilmCommand(target, action) : { schemaVersion: 1, help: commandHelp, commands: commandCatalog(), guide: "docs/AI-PRODUCTION.md" };
    console.log(rest.includes("--json") || command === "describe" ? JSON.stringify(descriptor) :
      target ? descriptor.usage + "\n" + descriptor.description + "\n" +
        Object.entries(descriptor.options).map(([name, option]) => "--" + name + "  " + option.description).join("\n") : commandHelp);
    return 0;
  }

  if (command === "platform") {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("platform-cli.mjs", import.meta.url)),
      ...rest,
    ];
    void import("./platform-cli.mjs").catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    return 0;
  }
  if (command === "mcp-remote") {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("mcp-remote.mjs", import.meta.url)),
      ...rest,
    ];
    void import("./mcp-remote.mjs").catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    return 0;
  }
  if (command === "mcp") {
    // Run in this process so disconnects and signals reach the owned job manager.
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("mcp.mjs", import.meta.url)),
      ...rest,
    ];
    void import("./mcp.mjs").catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    return 0;
  }
  if (command === "reference") {
    const names = rest.filter(arg => arg !== "--json");
    if (names.length > 1) throw new Error("Use film reference [name] --json");
    console.log(JSON.stringify(names.length ? readAuthoringReference(root, names[0]) : { schemaVersion: 1, references: referenceCatalog() }));
    return 0;
  }
  if (["list", "inspect", "context"].includes(command)) {
    const json = rest.includes("--json");
    const positional = rest.filter((arg) => arg !== "--json" && !(command !== "list" && arg === "--detail"));
    if (
      (command === "list" && positional.length) ||
      (command !== "list" && positional.length !== 1)
    )
      throw new Error("Unexpected arguments; run pnpm film help");
    if (command === "list") {
      const projects = [],
        errors = [];
      const directory = path.join(root, "projects");
      for (const entry of fs.existsSync(directory)
        ? fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
        : []) {
        if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
        try {
          const { meta } = readProject(
            projectPath(root, entry.name, "project.ts"),
          );
          projects.push({
            id: entry.name,
            title: meta.title,
            renderer: meta.renderer,
            duration: meta.duration,
            fps: meta.fps,
            status: meta.status,
            folder: `projects/${entry.name}/`,
          });
        } catch (error) {
          errors.push({ id: entry.name, error: error.message });
        }
      }
      console.log(
        json
          ? JSON.stringify({ schemaVersion: 1, projects, errors }, null, 2)
          : projects
              .map(
                (p) =>
                  `${p.id}\t${p.title}\t${p.duration}s / ${p.fps}fps\t${p.folder}`,
              )
              .concat(errors.map((p) => `${p.id}\tERROR: ${p.error}`))
              .join("\n"),
      );
    } else {
      const report = inspectProject(root, positional[0], { detail: command === "inspect" || rest.includes("--detail") });
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
    composition: ["visual-cli.mjs", ...rest],
    audio: ["audio-cli.mjs", ...rest],
    "audio-media": ["audio-media-cli.mjs", ...rest],
    media: ["media-cli.mjs", ...rest],
    speech: ["speech-cli.mjs", ...rest],
    asset: ["asset-cli.mjs", ...rest],
    operation: ["project-operation.mjs", ...rest],
    job: ["job-cli.mjs", ...rest],
    workspace: ["production-cli.mjs", "workspace", ...rest],
    playback: ["production-cli.mjs", "playback", ...rest],
    export: ["production-cli.mjs", "export", ...rest],
    narrate: ["production-cli.mjs", "narrate", ...rest],
    "test-e2e": ["production-cli.mjs", "test-e2e", ...rest],
    ...Object.fromEntries(
      [
        "dev",
        "typecheck",
        "test",
        "build",
        "validate",
        "search",
        "read",
        "edit",
        "patch",
        "checkpoint",
        "history",
        "restore",
        "review",
        "compare",
        "verify",
        "review-note",
      ].map((name) => [name, ["production-cli.mjs", name, ...rest]]),
    ),
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
  const cleanRest = rest.filter((value) => value !== "--json");
  if (
    command === "doctor" ? cleanRest.length > 0 : !validProjectId(cleanRest[0])
  )
    throw new Error("Expected a project id; run pnpm film help");
  if (command === "poster" && cleanRest.length !== 1)
    throw new Error("Use pnpm film poster <id>");
  const [script, ...forwarded] = route;
  const capture =
    rest.includes("--json") &&
    [
      "frame",
      "render",
      "storyboard",
      "poster",
      "import",
      "doctor",
      "new",
    ].includes(command);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL(script, import.meta.url)),
      ...forwarded.filter((value) => !capture || value !== "--json"),
    ],
    {
      cwd: root,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (capture) {
    const log = (result.stdout ?? "").trim();
    const output =
      /Verified output: (.+)|Exported frame at .+? -> (.+)|Storyboard: (.+)/.exec(
        log,
      );
    const file = command === "new" && result.status === 0
      ? projectPath(root, cleanRest[0])
      : output?.slice(1).find(Boolean)?.trim();
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command,
        status: result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        output: file ?? null,
        ...(command === "new" && result.status === 0 ? {
          project: cleanRest[0],
          context: inspectProject(root, cleanRest[0]),
          nextAction: "pnpm --silent film context " + cleanRest[0] + " --json",
        } : {}),
        ...(result.status !== 0 ? { error: errorRecovery(Object.assign(new Error((result.stderr || log).trim()), { code: "COMMAND_FAILED" })) } : {}),
        log,
        diagnostics: result.stderr ?? "",
      }),
    );
  }
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
      console.log(JSON.stringify({ schemaVersion: 1, status: "failed", error: errorRecovery(error) }));
    else console.error(error.message);
    process.exitCode = 1;
  }
}
