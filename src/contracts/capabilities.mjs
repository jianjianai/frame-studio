import { z } from "zod";
import { adapters } from "../engine/adapters.mjs";
import {
  audioEngines,
  audioProcessors,
} from "../engine/audio-capabilities.mjs";

/**
 * @typedef {import("./capabilities.mjs").CapabilityCategory} CapabilityCategory
 * @typedef {import("./capabilities.mjs").CapabilityKind} CapabilityKind
 * @typedef {import("./capabilities.mjs").CapabilityReference} CapabilityReference
 * @typedef {import("./capabilities.mjs").AuthoringCapability} AuthoringCapability
 * @typedef {import("./capabilities.mjs").CapabilityFilters} CapabilityFilters
 * @typedef {import("./capabilities.mjs").AuthoringCapabilities} AuthoringCapabilities
 * @typedef {import("./capabilities.mjs").AuthoringCapabilitySummary} AuthoringCapabilitySummary
 * @typedef {import("./capabilities.mjs").CapabilityMixing} CapabilityMixing
 * @typedef {import("./capabilities.mjs").CapabilityDiscovery} CapabilityDiscovery
 */

/** Runtime-neutral catalog; registry flags describe interfaces, not installed/browser readiness.
 * @type {readonly CapabilityCategory[]}
 */
export const capabilityCategories = Object.freeze([
  "visual",
  "media",
  "animation",
  "audio",
]);
export const capabilityFilterShape = Object.freeze({
  category: z.enum(capabilityCategories).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  id: z.string().trim().min(1).max(100).optional(),
});
const capabilityFiltersSchema = z.strictObject(capabilityFilterShape);

const sceneRequirements = [
  "按绝对时间 render(time) 重建画面，支持倒退和重复；关闭框架独立时钟。",
  "项目负责具体场景、资源和状态，dispose 释放本实例资源。",
];
const audioRequirements = [
  "在项目 loadAudio 模块的 generators 中注册真实生成器；engine 标签不会自动生成声音。",
  "使用宿主提供的 context、destination、when、offset、duration、rate；任意片段可独立重建。",
  "初始化、prepareSegment 与 dispose 由生成器实现；不得另启独立时钟或关闭宿主上下文。",
];
/** @param {string} key @param {string} path @returns {CapabilityReference} */
const reference = (key, path) => ({ key, path });
/** @type {Record<string, Omit<AuthoringCapability, "id" | "name" | "category" | "sources">>} */
const visualDetails = {
  composition: {
    kind: "composition",
    description:
      "默认空白 visual.json 合成文档，组织片段、图层和时间映射；它不预选内容绘制框架。",
    integration: {
      entry: "createCompositionScene(options, visual, loaders)",
      module: "src/engine/compositor.ts",
      projectEntry: "scene.ts + visual.json",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: [
      "程序化子场景在项目 loaders 中注册；Canvas 图层可混用，但原生 DOM 场景必须以 Remotion 为根。",
    ],
    supports: { canvasLayer: true, rootComposition: true },
  },
  remotion: {
    kind: "renderer",
    package: "remotion",
    description:
      "React/DOM/SVG/CSS 视频根合成，使用官方 Player、Renderer 和 Web Renderer。",
    integration: {
      entry: "createRemotionScene(options, project)",
      module: "src/engine/remotion-adapter.tsx",
      projectEntry: "composition.tsx + loadRemotion",
    },
    reference: reference("remotion", "docs/REMOTION.md"),
    requirements: [
      "以 Remotion 组件为根，通过 FrameScene 嵌入 Canvas/PixiJS/Three.js/Babylon.js/Lottie/visual.json。",
      "原生 DOM 不是 CanvasImageSource，不能放入 visual.json 的 scene 图层。",
      "浏览器导出需要实际 WebCodecs/Web Renderer 支持，组件限制详见 Remotion 指南；服务端导出另用官方 Renderer。",
    ],
    supports: { canvasLayer: false, rootComposition: true },
  },
  canvas: {
    kind: "renderer",
    description: "浏览器 Canvas 2D 程序场景，项目直接实现 Scene 接口。",
    integration: {
      entry: "createScene(options) -> Scene",
      module: "src/engine/types.ts",
      projectEntry: "scene.ts",
      sourceKind: "scene",
    },
    reference: reference("authoring", "docs/AUTHORING.md"),
    requirements: sceneRequirements,
    supports: { canvasLayer: true, rootComposition: true },
  },
  pixi: {
    kind: "renderer",
    package: "pixi.js",
    description: "PixiJS Canvas 输出适配器，使用独立实例和手动更新。",
    integration: {
      entry: "createPixiScene(options, build)",
      module: "src/engine/scene-adapters.ts",
      projectEntry: "scene.ts",
      sourceKind: "scene",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: sceneRequirements,
    supports: { canvasLayer: true, rootComposition: true },
  },
  three: {
    kind: "renderer",
    package: "three",
    description:
      "Three.js 透明 WebGL 场景适配器；支持 GLB/glTF 模型、Draco/Meshopt/KTX2 压缩资源、骨骼时间定位及可选 bloom 后处理。",
    integration: {
      entry: "createThreeScene(options, build)",
      module: "src/engine/scene-adapters.ts",
      projectEntry: "scene.ts",
      sourceKind: "scene",
      helpers: [
        {
          entry: "loadGltf(url, renderer)",
          module: "src/engine/three-assets.ts",
          description:
            "加载项目 GLB/glTF；支持 Draco、Meshopt、KTX2 解码，纹理/外部缓冲也须属于本项目。",
        },
        {
          entry: "createPostPipeline(renderer, scene, camera, bloom?)",
          module: "src/engine/three-assets.ts",
          description:
            "显式创建 EffectComposer + UnrealBloomPass + OutputPass；项目自行接入合成后的渲染和释放。",
        },
        {
          entry: "setAnimationTime(mixer, seconds)",
          module: "src/engine/three-assets.ts",
          description: "从绝对时间定位 AnimationMixer 骨骼动画，支持倒退。",
        },
        {
          entry: "disposeObject(root)",
          module: "src/engine/three-assets.ts",
          description:
            "释放场景对象的几何、材质与纹理；后处理 composer 仍需项目释放。",
        },
      ],
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: [
      ...sceneRequirements,
      "createThreeScene 本身仍调用 renderer.render；bloom 后处理需在项目自定义 Scene.render 中显式调用 composer.render(0)，不能假定适配器自动接入。",
    ],
    supports: { canvasLayer: true, rootComposition: true },
  },
  babylon: {
    kind: "renderer",
    package: "@babylonjs/core",
    description:
      "Babylon.js 场景适配器，禁用独立渲染循环，宿主按绝对时间绘制。",
    integration: {
      entry: "createBabylonScene(options, build)",
      module: "src/engine/babylon-adapter.ts",
      projectEntry: "scene.ts",
      sourceKind: "scene",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: sceneRequirements,
    supports: { canvasLayer: true, rootComposition: true },
  },
  lottie: {
    kind: "asset-adapter",
    package: "lottie-web",
    description: "自包含 Lottie JSON 通过 Canvas 适配器按绝对时间定位。",
    integration: {
      entry: "createLottieScene(options, src, signal)",
      module: "src/engine/lottie-adapter.ts",
      sourceKind: "lottie",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: [
      "提供项目内自包含 Lottie JSON；不能假定任意外部资源或表达式都已受支持。",
    ],
    supports: { canvasLayer: true, rootComposition: false },
  },
  video: {
    kind: "asset-source",
    package: "mediabunny",
    description: "视频素材逐帧解码，并可把素材原声映射到共享音频时间轴。",
    integration: {
      entry: "openVideoSource(src, width, signal) / visual.json source",
      module: "src/engine/media-source.ts",
      sourceKind: "video",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: [
      "实际容器和编码支持取决于浏览器；先 probe，不兼容时转换独立副本。",
    ],
    supports: { canvasLayer: true, rootComposition: false },
  },
  image: {
    kind: "asset-source",
    description: "项目图片素材，作为合成图层或程序场景资源。",
    integration: {
      entry: "openImageSource(src, signal) / visual.json source",
      module: "src/engine/media-source.ts",
      sourceKind: "image",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: ["提供浏览器可解码的项目图片素材。"],
    supports: { canvasLayer: true, rootComposition: false },
  },
  sequence: {
    kind: "asset-source",
    description: "项目内图片数组与 fps 定义的图像序列。",
    integration: {
      entry: "visual.json source: {kind:'sequence', frames, fps}",
      module: "src/engine/compositor.ts",
      sourceKind: "sequence",
    },
    reference: reference("composition", "docs/COMPOSITION.md"),
    requirements: ["提供完整帧数组和帧率，片段时间不得超出实际图像序列。"],
    supports: { canvasLayer: true, rootComposition: false },
  },
};
const seekModes = z.enum(["absolute", "author", "decoded"]);
/** @type {AuthoringCapability[]} */
const visualItems = adapters.map((adapter) => {
  const detail = visualDetails[adapter.id];
  if (!detail)
    throw new Error(
      "Missing authoring integration for visual adapter: " + adapter.id,
    );
  const { supports, ...rest } = detail;
  return {
    id: adapter.id,
    name: adapter.name,
    category: adapter.category === "media" ? "media" : "visual",
    ...rest,
    supports: {
      template: adapter.template,
      seek: seekModes.parse(adapter.seek),
      alpha: adapter.alpha,
      offline: adapter.offline,
      ...supports,
    },
    sources: [
      ...new Set([
        "src/engine/adapters.mjs",
        detail.integration.module,
        ...(detail.integration.helpers ?? []).map((helper) => helper.module),
      ]),
    ],
  };
});
/** @type {AuthoringCapability[]} */
const animationItems = [
  {
    id: "gsap",
    name: "GSAP",
    category: "animation",
    kind: "helper-library",
    package: "gsap",
    description:
      "已安装的动画辅助库，用于属性插值和时间线；它不是独立 renderer。",
    integration: {
      entry: "import { gsap } from 'gsap'; paused timeline seek(time)",
      module: "gsap",
    },
    supports: {
      template: false,
      seek: "author",
      offline: true,
      canvasLayer: false,
    },
    requirements: [
      "由 Scene/React 场景拥有时间线，禁用独立 ticker/自动播放，按宿主绝对时间定位并在 dispose 时清理。",
    ],
    reference: reference("authoring", "docs/AUTHORING.md"),
    sources: [
      "package.json",
      "docs/NEW-PROJECT-STANDARD.md",
      "docs/AUTHORING.md",
    ],
  },
  {
    id: "flubber",
    name: "Flubber",
    category: "animation",
    kind: "helper-library",
    package: "flubber",
    description:
      "已安装的 path morph / 路径形变插值辅助库；输出需要由选定场景绘制，不是独立 renderer。",
    integration: {
      entry:
        "import { interpolate } from 'flubber'; interpolate(from, to)(progress)",
      module: "flubber",
    },
    supports: {
      template: false,
      seek: "author",
      offline: true,
      canvasLayer: false,
    },
    requirements: ["项目提供路径、插值进度和绘制逻辑，进度来自共享绝对时间。"],
    reference: reference("authoring", "docs/AUTHORING.md"),
    sources: ["package.json", "docs/AUTHORING.md"],
  },
];
/** @type {Record<string, {package?: string, description: string, integration: AuthoringCapability["integration"], requirements: string[], reference?: CapabilityReference}>} */
const audioDetails = {
  "web-audio": {
    description: "使用浏览器 Web Audio 节点实现项目生成器。",
    integration: {
      entry: "createWebAudioGenerator(create, prepare)",
      module: "src/engine/audio-adapters.ts",
    },
    requirements: ["项目提供具体合成、采样或调度函数。"],
  },
  tone: {
    package: "tone",
    description: "Tone.js 适配器使用宿主上下文，支持实时和离线项目生成器。",
    integration: {
      entry: "createToneAudio(build)",
      module: "src/engine/audio-adapters.ts",
    },
    requirements: [
      "项目提供 build 函数，并给 Tone 实例显式传入 toneContext；不使用全局 Transport、Tone.start()/setContext()。",
      "跨切点延音等乐器状态由项目重建。",
    ],
  },
  "worker-pcm": {
    description:
      "Worker 按绝对采样位置生成有界分段 PCM，可封装项目提供的 WASM DSP。",
    integration: {
      entry:
        "createWorkerPcmAudio({createWorker}); exposePcmGenerator(generate)",
      module: "src/engine/worker-pcm.ts",
    },
    requirements: [
      "项目提供 Worker 和确定性 PCM 生成函数；使用 WASM 时另提供模块与初始化代码。",
      "标签不会自动加载任意 WASM 或把顺序 DSP 自动改为可跳转生成器。",
    ],
  },
  soundfont: {
    package: "spessasynth_core",
    description:
      "SoundFont 原采样与已准备的 MIDI 乐谱，通过后台线程按需生成声音。",
    integration: {
      entry: "createSampledScoreAudio({score, foley, bank, sha256, levels})",
      module: "src/engine/soundfont-audio.ts",
    },
    requirements: [
      "项目提供 SoundFont 采样库、SHA-256、乐谱和所需的采样/音效数据及来源许可；不是凭 MIDI 文件名就自动配置。",
    ],
    reference: reference("audio", "docs/AUDIO.md"),
  },
  custom: {
    description: "项目自定义 GeneratedAudioModule，与已有生成音轨保持兼容。",
    integration: {
      entry:
        "createAudio(options) -> {dispose}; optional prepareAudio/prepareSegment",
      module: "src/engine/types.ts",
    },
    requirements: [
      "项目提供完整生成器代码；第三方代码必须适配协议，不能假定任意库天然可跳转或可离线导出。",
    ],
  },
};
/** @type {AuthoringCapability[]} */
const audioItems = audioEngines.map((engine) => {
  const detail = audioDetails[engine.id];
  if (!detail)
    throw new Error(
      "Missing authoring integration for audio engine: " + engine.id,
    );
  return {
    id: engine.id,
    name: engine.name,
    category: "audio",
    kind: "generator-adapter",
    ...detail,
    integration: {
      ...detail.integration,
      projectEntry: "loadAudio + generators + audio.json sources",
    },
    supports: {
      realtime: engine.realtime,
      offline: engine.offline,
      seek: "author",
      template: false,
    },
    requirements: [...audioRequirements, ...detail.requirements],
    reference: detail.reference ?? reference("audio-v7", "docs/AUDIO-V7.md"),
    sources: [
      "src/engine/audio-capabilities.mjs",
      "src/engine/audio-document.mjs",
      detail.integration.module,
    ],
  };
});
/** @type {Partial<Record<import("../engine/audio-capabilities.mjs").AudioProcessorId, string>>} */
const processorLimitations = {
  limiter: "压缩器与硬采样峰值保护；不是过采样真峰值母带限制器。",
  duck: "按照触发轨道片段时间避让；不是实际信号包络检测的侧链压缩。",
};
/** @type {AuthoringCapability[]} */
const processorItems = audioProcessors.map((processor) => ({
  id: "audio-processor-" + processor.id,
  name: processor.name,
  category: "audio",
  kind: "processor",
  description:
    "音轨、总线与主输出的 " +
    processor.name +
    " 处理器。" +
    (processorLimitations[processor.id] ?? ""),
  integration: {
    entry: "audio.json processors: {type:'" + processor.id + "'}",
    module: "src/engine/audio-processors.ts",
    processorType: processor.id,
  },
  supports: { realtime: true, offline: true, template: false },
  requirements: ["参数与路由遵守 audio.json schema；多个处理器可组成效果链。"],
  reference: reference("audio-v7", "docs/AUDIO-V7.md"),
  sources: [
    "src/engine/audio-capabilities.mjs",
    "src/engine/audio-document.mjs",
    "src/engine/audio-processors.ts",
  ],
}));
/** @type {AuthoringCapability} */
const fileAudio = {
  id: "audio-file",
  name: "文件音频",
  category: "audio",
  kind: "asset-source",
  package: "mediabunny",
  description:
    "文件音源、多轨混音与视频原声；常见 WAV/FLAC/MP3/Ogg/Opus/M4A/AAC 先检查实际解码能力。",
  integration: {
    entry: "audio.json sources: {kind:'file', src} / audioTracks",
    module: "src/engine/audio-source-pool.ts",
    projectEntry: "loadAudioDocument + audio.json",
    sourceKind: "file",
  },
  supports: { realtime: true, offline: true, seek: "decoded", template: false },
  requirements: [
    "提供项目内素材；浏览器不支持的编码先转换副本。",
    "混音/导出为 48 kHz 双声道；变速改变音高，不提供保调变速。",
  ],
  reference: reference("audio-v7", "docs/AUDIO-V7.md"),
  sources: [
    "src/engine/audio-document.mjs",
    "src/engine/audio-source-pool.ts",
    "docs/AUDIO-V7.md",
  ],
};
/** @type {AuthoringCapability} */
const colorSource = {
  id: "color",
  name: "纯色图层",
  category: "media",
  kind: "asset-source",
  description:
    "visual.json 的纯色/透明度图层，不需要文件素材，也不是新建 renderer。",
  integration: {
    entry: "visual.json source: {kind:'color', color:'#RRGGBB' or '#RRGGBBAA'}",
    module: "src/engine/compositor.ts",
    sourceKind: "color",
  },
  supports: {
    template: false,
    seek: "absolute",
    alpha: true,
    offline: true,
    canvasLayer: true,
    rootComposition: false,
  },
  requirements: [
    "使用合法的 6 或 8 位十六进制颜色，在 visual.json 的片段中定义位置、持续时间和变换。",
  ],
  reference: reference("composition", "docs/COMPOSITION.md"),
  sources: ["src/engine/visual-document.mjs", "src/engine/compositor.ts"],
};
/** @type {AuthoringCapability[]} */
const items = [
  ...visualItems,
  colorSource,
  ...animationItems,
  fileAudio,
  ...audioItems,
  ...processorItems,
];
/** @type {CapabilityMixing[]} */
const mixing = [
  {
    id: "canvas-composition",
    description:
      "visual.json 混合 Canvas/PixiJS/Three.js/Babylon.js 程序场景、Lottie、视频、图片、图像序列和纯色图层。",
    requirements: [
      "程序模块在项目 loaders 中注册并输出 Canvas；engine 标签不替代实际模块实现。",
      "所有图层共享绝对时间，媒体编解码和 GPU 资源依实际环境验证。",
    ],
    reference: reference("composition", "docs/COMPOSITION.md"),
  },
  {
    id: "remotion-root",
    description:
      "需要原生 React/DOM/SVG/CSS 时，Remotion 为根合成，通过 FrameScene 嵌入 Canvas 合成或程序场景。",
    requirements: [
      "原生 Remotion DOM 不能作为 visual.json 的 scene 图层；FrameScene 子场景不创建独立时钟。",
    ],
    reference: reference("remotion", "docs/REMOTION.md"),
  },
  {
    id: "audio-rack",
    description:
      "文件与 Web Audio/Tone.js/Worker PCM/WASM/SoundFont/自定义生成器可混用，audio.json 统一组织音源、轨道、片段、总线和效果。",
    requirements: [
      "每种生成器需要项目真实源代码/数据并注册到 generators；标签不表示自动接入任意第三方库。",
      "Remotion 组件音频与 Frame 音轨分别管理，正式导出统一混合一次。",
    ],
    reference: reference("audio-v7", "docs/AUDIO-V7.md"),
  },
];
/** @type {Readonly<CapabilityDiscovery>} */
const discovery = Object.freeze({
  localCLI: "pnpm --silent film capabilities --json",
  mcp: "frame_capabilities",
  agent: "node scripts/work-tool.mjs capabilities",
  reference: "capabilities",
});
const selection = Object.freeze({
  neutral: true,
  description:
    "默认空白合成；不限定创作选型、风格、制作方法或推荐 2D/3D 框架。显式 renderer 只选择已有示例。",
  readiness:
    "目录描述真实接入接口；安装与运行能力用 film doctor 和目标浏览器验证。第三方依赖不会自动变成可 seek 的引擎。",
});
/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" });
}
/** @param {unknown} options @returns {CapabilityFilters} */
function filterOptions(options) {
  const result = capabilityFiltersSchema.safeParse(options);
  if (!result.success)
    throw invalid("Invalid capability filters: " + result.error.message);
  const { category, query, id } = result.data;
  if (id !== undefined && !items.some((item) => item.id === id))
    throw invalid("Unknown capability id: " + id);
  return { category, query: query?.toLowerCase(), id };
}
/** Structured discovery shared by CLI, MCP, agents and scaffold documentation.
 * @param {CapabilityFilters} [options]
 * @returns {AuthoringCapabilities}
 */
export function getAuthoringCapabilities(options = {}) {
  const filters = filterOptions(options);
  const selected = items.filter(
    (item) =>
      (filters.category === undefined || item.category === filters.category) &&
      (filters.id === undefined || item.id === filters.id) &&
      (filters.query === undefined ||
        JSON.stringify(item).toLowerCase().includes(filters.query)),
  );
  return structuredClone({
    schemaVersion: 1,
    defaultRenderer: "composition",
    categories: [...capabilityCategories],
    items: selected,
    mixing,
    selection,
    discovery,
  });
}
/** Compact context payload; inspect a capability id to read requirements and actual entry points.
 * @returns {AuthoringCapabilitySummary}
 */
export function authoringCapabilitySummary() {
  return structuredClone({
    schemaVersion: 1,
    defaultRenderer: "composition",
    groups: /** @type {AuthoringCapabilitySummary["groups"]} */ (
      Object.fromEntries(
        capabilityCategories.map((category) => [
          category,
          items
            .filter((item) => item.category === category)
            .map(({ id, name, kind }) => ({ id, name, kind })),
        ]),
      )
    ),
    mixing: mixing.map(({ id, description }) => ({ id, description })),
    selection: selection.description,
    discovery,
  });
}
/** Complete neutral overview for a project's README; generated from the same registry as discovery. */
export function renderCapabilityOverview() {
  /** @param {CapabilityCategory} category @param {CapabilityKind} [kind] */
  const names = (category, kind) =>
    items
      .filter(
        (item) => item.category === category && (!kind || item.kind === kind),
      )
      .map((item) => item.name)
      .join("、");
  return [
    "## 可用能力与接入边界",
    "",
    "默认工程为空白合成，不预选 2D/3D 框架、内容、风格或制作方法。根据作品需要自主选型；下列能力可组合使用，目录顺序不表示推荐优先级。",
    "",
    "| 能力 | 已有接入 | 用法与边界 |",
    "| --- | --- | --- |",
    "| 画面与合成 | " +
      names("visual") +
      " | 程序场景按共享绝对时间渲染；空白合成组织图层，Remotion 使用 React 根组件。 |",
    "| 素材 | " +
      names("media") +
      " | visual.json 的素材源或程序场景资源；视频编码先探测，图像序列需帧数组和 fps。 |",
    "| 动画辅助库 | " +
      names("animation") +
      " | GSAP 用于属性/时间线，Flubber 用于路径形变；均不是 renderer，须由场景按绝对时间驱动。 |",
    "| 音频 | 文件音频；" +
      names("audio", "generator-adapter") +
      " | 项目提供素材、合成函数、Worker/WASM 或 SoundFont/乐谱；在 loadAudio 加载的模块中导出 generators 注册生成器，标签不自动生成内容。 |",
    "| 音频处理器 | " +
      names("audio", "processor") +
      " | audio.json 的轨道、总线和主输出可配置处理链；支持片段、循环、淡化、变速和音量自动化。 |",
    "",
    "visual.json 可混合输出 Canvas 的程序场景、Lottie 和媒体。原生 Remotion DOM 不能放入 Canvas 合成图层；使用 Remotion 为根，通过 FrameScene 嵌入其他 Frame 场景。Remotion 组件音频与 Frame 音轨分别管理，导出统一混合一次。",
    "",
    "所有模块遵守同一绝对时间和释放协议。适配器不把任意第三方库自动变成可跳转/可离线导出的引擎；具体动画状态、跨切点延音和 WASM 初始化由项目实现。实际编解码、GPU 和浏览器导出能力仍需在运行环境验证。",
    "",
    "能力目录：" +
      discovery.localCLI +
      "；MCP：" +
      discovery.mcp +
      "；Agent：" +
      discovery.agent +
      "。可用 category、query、id 定位详情，再通过 film reference 读取对应接口说明（composition、remotion、audio-v7、audio、authoring）。",
  ].join("\n");
}
