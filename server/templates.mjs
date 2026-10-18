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
  ["表格与文档", "xlsx xlsm xls pdf docx pptx"],
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
    beats: [],
    subtitles: [],
    credits: [],
  };
  const project = `import type { AnimationProject } from "@frame/engine/types";

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
      },
    ],
  };
  return {
    "README.md": `# ${title}\n\nFRAME 作品。使用 FRAME Studio 打开、预览和导出。\n`,
    ".gitignore": "exports/\n.cache/\nnode_modules/\n",
    ".gitattributes": GIT_ATTRIBUTES,
    [base + "project.ts"]: project,
    [base + "visual.json"]: JSON.stringify(visual, null, 2) + "\n",
    [base + "scene.ts"]: `import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
import visual from "./visual.json";

// visual.json 排列图层；"scene" 图层的 module 名称在这里注册。
export function createScene(options: SceneOptions) {
  return createCompositionScene(options, visual, {
    title: () => import("./scenes/title"),
  });
}
`,
    [base + "scenes/title.ts"]: `import type { Scene, SceneOptions } from "@frame/engine/types";
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
      // As large as the height allows, smaller when the title is wider than the picture (vertical works).
      let size = Math.round(height * 0.09);
      ctx.font = \`600 \${size}px system-ui, sans-serif\`;
      const wide = ctx.measureText(project.title).width;
      if (wide > width * 0.9) {
        size = Math.floor((size * width * 0.9) / wide);
        ctx.font = \`600 \${size}px system-ui, sans-serif\`;
      }
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
          // The engine from any folder, and material library code copied at the versions the work uses (see server/materials.mjs).
          paths: { "@frame/engine/*": ["./src/engine/*"], "@materials/*": ["./.materials/*"] },
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

你在 FRAME Studio 里和用户一起做一个视频作品，用户在旁边的播放器里实时看到你保存的每一次修改。和用户交流用用户的语言（默认简体中文）。

## 基本规则
- 作品文件在下面「本作品」写的 \`projects/<名称>/\` 里，只修改这里。\`src/\`、\`node_modules/\`、\`docs/\` 是 FRAME 引擎的只读链接；同一作品库的其他作品只能用工具读（works_list、work_read 等），不要直接读写上级目录。
- 平台的接口、作品结构和制作方法见 \`frame_guide\`（入门看 overview），工具各自带说明。需要什么自己读，不确定时先查，不要猜。
- 看画面用 work_check（frames: true）或 preview_frames，不要往时间轴加临时图层，也不要自己另起浏览器渲染。
- 网站要登录、或者拦着服务器不让下载（YouTube、Sketchfab、B 站……）时，用带登录状态的浏览器（browser_open 等，见 frame_guide browser）：用户电脑上的浏览器或服务器上的浏览器，登录由用户自己完成（browser_login 请用户登录），不要让用户把密码、验证码、Token 或 Cookie 发到聊天里。在登录状态的浏览器里只浏览和下载，不发帖、评论、私信、点赞、关注、购买，不改账号设置。
- 每条用户消息末尾的 [FRAME] 是当前情况和变化：播放位置、选中的对象（用户说“这个”“这里”多半指它）、打开的文件、别人改过的文件和经验库、GitHub 同步。没提到的就是没变；改别人改过的文件前先重新读。

## 需要用户同意
- 关联或取消关联经验库、素材库，新建经验库。
- 新建、修改或删除技能。\`.claude/skills/\`（Codex 是 \`.agents/skills/\`，同一个文件夹）里是这个作品库所有作品共用的技能，改动在每轮结束时自动保存为版本。作品关联为经验库的技能（id \`skill:<技能名>\`），它的文档和其他经验库一样整理，不用另问。
- 保存作品版本（version_save）。
- 删除作品：work_delete 只做标记，由用户在作品列表里确认。
- [FRAME] 说 GitHub 上有更新的版本或有冲突时，先不要改作品文件，请用户在工作台顶部处理。
- 已发布的作品不能修改；经验库、素材库照常可以整理。

## 经验
经验库是同类作品共用的制作经验和用户偏好。读什么、记什么、记在哪里、怎么组织和整理，由你判断：只和这个作品有关的记在作品的 AGENTS.md；可以复用的记进合适的关联经验库（experience_write）；没有合适的先记在作品的 经验.md，以后整理进经验库。这些文档由你来保持整洁、精练；一篇文档太长、不好读也不好找时，按主题拆成几篇。你改的经验库每轮结束时自动保存为版本。
`;
}

