import { ENGINE_PROTOCOL_VERSION } from "../src/engine/protocol.mjs";

/** Files of a new work branch: a playable blank composition with one editable title layer. */
/**
 * Media go to Git LFS: GitHub refuses ordinary files over 100 MB, and binary history
 * would make every clone of the content repository slower. Written on every new work
 * and materials branch. Patterns match both cases (".PNG" from cameras).
 */
const LFS_EXTENSIONS = [
  ["音频", "wav mp3 m4a aac flac ogg oga opus weba"],
  ["视频", "mp4 m4v mov webm mkv avi"],
  ["图片", "png jpg jpeg webp gif avif bmp tif tiff psd"],
  ["字体", "ttf otf woff woff2"],
  ["三维与贴图", "glb fbx usdz hdr exr ktx2"],
  ["音色库与其他二进制", "sf2 sf3 bin zip onnx"],
];
const anyCase = (ext) => [...ext].map((char) => (/[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char)).join("");
export const GIT_ATTRIBUTES =
  "# 媒体素材用 Git LFS 存储（GitHub 不接受超过 100 MB 的普通文件）\n" +
  LFS_EXTENSIONS.map(
    ([group, list]) =>
      `# ${group}\n` +
      list
        .split(" ")
        .map((ext) => `*.${anyCase(ext)} filter=lfs diff=lfs merge=lfs -text\n`)
        .join(""),
  ).join("");

export function createWorkFiles({ slug, title, width, height, duration, fps, description }) {
  const base = `projects/${slug}/`;
  const meta = {
    id: slug,
    title,
    subtitle: "",
    description,
    renderer: "composition",
    engineProtocol: ENGINE_PROTOCOL_VERSION,
    composition: { width, height },
    duration,
    fps,
    accent: "#7aa2f7",
    poster: `films/${slug}/poster.svg`,
    tags: [],
    status: "draft",
    beats: [],
    subtitles: [],
    credits: [],
  };
  const project = `import type { AnimationProject } from "../../src/engine/types";

const project: AnimationProject = {
${Object.entries(meta)
  .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
  .join("\n")}
  load: () => import("./scene"),
  loadVisual: () => import("./visual.json"),
};
export default project;
`;
  const visual = {
    schemaVersion: 1,
    background: "#101418",
    clips: [
      {
        id: "title",
        name: "标题",
        source: { kind: "scene", module: "title", engine: "canvas" },
        start: 0,
        duration,
        fadeIn: Math.min(1, duration / 4),
        fadeOut: Math.min(1, duration / 4),
      },
    ],
  };
  return {
    "README.md": `# ${title}\n\nFRAME 作品。使用 FRAME Studio 打开、预览和导出。\n`,
    ".gitignore": "exports/\n.cache/\nnode_modules/\n",
    ".gitattributes": GIT_ATTRIBUTES,
    [base + "project.ts"]: project,
    [base + "visual.json"]: JSON.stringify(visual, null, 2) + "\n",
    [base + "scene.ts"]: `import type { SceneOptions } from "../../src/engine/types";
import { createCompositionScene } from "../../src/engine/compositor";
import visual from "./visual.json";

// visual.json 排列图层；"scene" 图层的 module 名称在这里注册。
export function createScene(options: SceneOptions) {
  return createCompositionScene(options, visual, {
    title: () => import("./scenes/title"),
  });
}
`,
    [base + "scenes/title.ts"]: `import type { Scene, SceneOptions } from "../../../src/engine/types";
import project from "../project";

// 示例图层：按绝对时间绘制，可任意跳转。可以替换或删除。
export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    canvas,
    render(time) {
      ctx.clearRect(0, 0, width, height);
      const rise = Math.min(1, time / 1.2);
      const eased = 1 - Math.pow(1 - rise, 3);
      ctx.fillStyle = "#e8edf2";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = \`600 \${Math.round(height * 0.09)}px system-ui, sans-serif\`;
      ctx.globalAlpha = eased;
      ctx.fillText(project.title, width / 2, height / 2 + (1 - eased) * height * 0.04);
      ctx.globalAlpha = 1;
    },
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}
`,
    [base + "AGENTS.md"]: `# ${title}

在这里记录这个作品自己的需求、风格约定和制作说明（AI 每次进入作品都会读取）。

## 需求
${description || "（尚未填写）"}
`,
    [base + "public/poster.svg"]:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#101418"/><text x="50%" y="50%" fill="#e8edf2" font-family="system-ui,sans-serif" font-size="${Math.round(height * 0.08)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(title)}</text></svg>\n`,
  };
}

const escapeXml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/** TypeScript config generated at the worktree root so agents can type-check a work. */
export function workTsconfig() {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          allowJs: true,
          types: ["vite/client"],
        },
        include: ["projects", "src/*.d.ts"],
        // Tests (often with their own runners such as Playwright) are not part of what the preview loads.
        exclude: ["projects/*/exports", "projects/*/.cache", "projects/*/tests", "projects/**/*.test.*", "projects/**/*.spec.*"],
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Instructions for Claude Code / Codex, written to the worktree root (not committed).
 * Keep this short: details come from the frame_guide tool and docs/.
 */
export function platformInstructions() {
  return `# FRAME 作品工作区

你在 FRAME Studio 里为用户制作一个视频作品。用户在旁边的播放器里实时看到你保存的每一次修改。

## 位置
- 作品文件全部在 \`projects/<名称>/\`（只有一个），只修改这里。
- \`src/\`、\`node_modules/\`、\`docs/\` 是指向 FRAME 引擎的只读链接：可以阅读，不要修改。
- \`projects/<名称>/AGENTS.md\` 是这个作品自己的需求和约定，开始前先读，确认的新需求写回这里。
- 不要读取或参考上级目录中的其他作品；需要接口示例时用 \`frame_guide\`。

## 作品结构
- \`project.ts\`：静态元数据（标题、尺寸 composition、时长 duration、fps、字幕、音轨、加载入口）。只能写字面量。
- \`scene.ts\`：导出 \`createScene(options) -> Scene\`；\`render(time)\` 按绝对时间绘制，必须支持任意跳转，不能有自己的动画时钟。
- \`visual.json\`：图层时间轴（图片/视频/颜色/scene 模块），人工也会在界面上编辑它。
- \`audio.json\`：多轨音频；\`audio.ts\` 可以写代码生成的声音。
- \`public/\`：素材，代码里用 \`assetUrl("films/<名称>/文件")\` 引用。
- 引擎导入：\`scene.ts\` 写 \`"../../src/engine/..."\`，\`scenes/*.ts\` 写 \`"../../../src/engine/..."\`。

## 工具（MCP 服务器 frame）
- \`frame_guide\`：接口说明与示例。不确定写法时先查，不要猜。
- \`work_context\`：作品现状、素材、用户当前播放位置和选中的内容。
- \`work_check\`：类型与结构检查，并在浏览器里实际加载，报告运行错误（位置是作品源码的 文件:行:列）。
- \`preview_frames\` / \`storyboard\`：渲染指定时间的画面给你看。改完画面后务必用它确认效果。
- \`preview_audio\`：分析一段声音的响度，确认声音存在且不过载。
- \`layers_edit\`、\`audio_place\`/\`audio_edit\`：图层和混音的原子修改（格式见 frame_guide layers / audio）。
- \`speech_synthesize\`：整段旁白用 \`lines\` + \`place\` + \`subtitles: true\` 一次生成配音、排上音轨并写字幕；\`subtitles_edit\` 改字幕，\`work_update\` 改时长和镜头标记。
- \`assets_list\`、\`asset_import\`、\`version_save\`、\`export_video\` 等：素材、版本和导出。

## 工作方式
1. 读用户需求和作品 AGENTS.md，必要时用 work_context 看用户正在看的位置。
2. 修改源码。保存后预览自动更新。
3. 运行 work_check；有错误先修复。
4. 用 preview_frames 或 storyboard 看关键时间点的画面，确认符合要求后再结束。
5. 简短告诉用户做了什么、在哪个时间点可以看到。版本由用户手动保存，除非用户要求，不要调用 version_save。

随机效果用固定种子；不要在模块导入时播放声音或访问网络；dispose 时释放自己创建的资源。
`;
}
