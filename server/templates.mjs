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
  };
}

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
          // Material library code, copied at the versions the work uses (see server/materials.mjs).
          paths: { "@materials/*": ["./.materials/*"] },
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
- \`projects/<名称>/AGENTS.md\` 是这个作品自己的需求和约定，内容在下面「本作品的需求与约定」一节。
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
- \`work_context\`：作品现状：文件、素材、图层与音轨、未保存的修改、最近一次检查结果。
- \`work_check\`：类型与结构检查，并在浏览器里实际加载，报告运行错误（位置是作品源码的 文件:行:列）。加 \`frames: true\` 同时返回开头、1/4、1/2、3/4、结尾的分镜图，不用再调 storyboard。
- \`preview_frames\` / \`storyboard\`：渲染指定时间的画面给你看。改完画面后务必用它确认效果。
- \`preview_audio\`：分析一段声音的响度，确认声音存在且不过载。
- \`layers_edit\`、\`audio_place\`/\`audio_edit\`：图层和混音的原子修改（格式见 frame_guide layers / audio）。
- \`speech_synthesize\`：整段旁白用 \`lines\` + \`place\` + \`subtitles: true\` 一次生成配音、排上音轨并写字幕；\`subtitles_edit\` 改字幕，\`work_update\` 改时长和镜头标记。
- \`assets_list\`、\`asset_import\`：作品自己的素材（public/）。素材库是作品共用的素材：\`materials_list\` 查看，\`materials_link\` 关联或取消关联（用户要求时），\`materials_use\` 锁定版本后用 \`materials/<库>/<文件>\` 地址，\`material_write\` / \`material_edit\` 往素材库里放、改文件。素材库里的代码用 \`import … from "@materials/<库>/<路径>"\` 直接导入（见 frame_guide assets）；\`.materials/\` 是 FRAME 生成的副本，不要改。
- \`version_save\`、\`export_video\` 等：版本和导出。
- \`work_delete\`：用户要删除作品时用。只做标记，由用户在首页作品列表中确认删除或保留；你不能直接删除作品。

## 上下文
- 这份说明在会话开始时生成，下面两节是当时的「本作品的需求与约定」和关联的「经验库」，不需要再去读取。
- 之后每条用户消息末尾的 [FRAME] 段落给出当前情况和变化：用户正在看的时间点、选中的时间轴对象（用户说“这个”“这里”多半指它）、编辑器里打开的文件、上一轮之后用户或其他对话改动过的文件、经验库的变化，以及作品和 GitHub 的同步情况。没提到的就是没变，不要重复读取。
- [FRAME] 说 GitHub 上有更新的版本或有冲突时，不要修改作品文件，请用户先在工作台顶部的提示中处理。
- 被提到改动过的文件，修改前先读取最新内容，不要用记忆中的旧内容覆盖用户的修改。

## 经验库
关联的经验库是同类作品共用的制作经验、用户偏好和避坑记录，一个作品可以关联多个。
- 动手前对照它们，照着做；和用户这次的要求冲突时以用户为准，并把经验库改成新的结论。
- 关联了多个经验库时，读写文档用工具的 \`library\` 参数指定是哪个；新经验写进内容最相关的那个。
- 用户要求时用 \`experience_link\` 关联、取消关联或新建经验库；没有合适的经验库可以建议用户新建，不要擅自关联或取消。
- 目录里与当前任务相关的文档用 \`experience_read\` 阅读全文；这次会话读过且没有变化的不用重读。
- 用户纠正你、明确表达喜好、确认某种做法好，或你解决了一个费劲的问题时，当场整理进经验库（\`experience_edit\` / \`experience_write\`）：按主题合并到已有文档，不重复，过时的说法直接改掉。新文档第一行写「# 标题」，下一行一句话说明讲什么（会出现在目录里）。只和这个作品有关的写进作品的 AGENTS.md。
- 用户要求“整理经验”时，回顾本次对话和作品改动，把可复用的做法写清楚“什么时候用、怎么做、要避免什么”。格式见 \`frame_guide experience\`。
- 经验库的修改是未保存状态。用户认可（或要求提交）后用 \`experience_commit\` 保存版本，用户要求时加 \`push: true\` 推送到 GitHub。

## 工作方式
1. 对照下面的需求与约定、经验库和 [FRAME] 里的最新情况；需要作品现状时用 work_context。
2. 修改源码。保存后预览自动更新。
3. 运行 work_check；有错误先修复。
4. 看画面确认（work_check 的 frames: true，或 preview_frames 看指定时刻），符合要求后再结束。
5. 简短告诉用户做了什么、在哪个时间点可以看到。版本由用户手动保存，除非用户要求，不要调用 version_save。

随机效果用固定种子；不要在模块导入时播放声音或访问网络；dispose 时释放自己创建的资源。
`;
}
