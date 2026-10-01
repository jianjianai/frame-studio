import { z } from "zod";
import { adapters } from "../engine/adapters.mjs";
import { toneFeatureGroups } from "./audio-library-catalog.mjs";
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
    description:
      "Tone.js 完整宿主绑定 API：采样乐器、合成器、粒子播放、包络、效果、信号、事件编排与分析；使用宿主上下文进行实时和离线创作。",
    integration: {
      entry: "createToneAudio(build, prepare)",
      module: "src/engine/audio-adapters.ts",
      helpers: [
        {
          entry: "createSamplerAudio(options)",
          module: "src/engine/audio-authoring.ts",
          description:
            "自动准备原音采样，按音符序列演奏；源时间切片、包络、力度、复音与取消。",
        },
        {
          entry: "createToneSequence(options)",
          module: "src/engine/audio-authoring.ts",
          description:
            "宿主绑定的 Tone 音符编排便利层，支持任意片段重建与离线导出。",
        },
        {
          entry:
            "createToneTimeline({duration, build, maxBufferBytes}) / renderBuffer(signal)",
          module: "src/engine/audio-authoring.ts",
          description:
            "Part/Sequence/Loop/Transport 自由编排有限乐谱，一次生成浏览器 PCM 后支持精确跳转；默认 128MiB 预算，可交 Signalsmith 独立移调。",
        },
        {
          entry:
            "prepareTone / createToneContext / createToneFacade / HostTone",
          module: "src/engine/audio-adapters.ts",
          description:
            "完整 Tone 类、Transport/Destination/Draw/Listener 和 getters 均绑定当前宿主，不初始化 Tone 全局上下文。",
        },
        {
          entry: "noteToMidi / semitoneRate / notesInSegment",
          module: "src/engine/audio-authoring.ts",
          description: "音高换算与跨切点音符选择，避免重复手写时间与音高转换。",
        },
      ],
    },
    requirements: [
      "build 提供的 HostTone 自动绑定 toneContext；Tone.Transport 与 getters 可用，Tone.start 不启动宿主，setContext 拒绝替换宿主。不要导入全局 tone 命名空间。",
      "build 的 ready 与 prepare 会被宿主等待；跨切点状态用 ToneTimeline 的有限 PCM 或 ToneSequence 的有界音符缓存重建；Timeline 初次准备有计算与内存成本，长乐谱使用 Sequence 便利层或流式生成器。",
    ],
  },
  signalsmith: {
    package: "signalsmith-stretch",
    description:
      "Signalsmith Stretch 官方 WASM/AudioWorklet 完整接口：独立半音移调、保调变速、共振峰、循环、流式样本缓冲与处理配置；StretchSchedule 参数包含 rate、semitones、tonalityHz、formantSemitones、formantCompensation、formantBaseHz、loopStart、loopEnd。",
    integration: {
      entry: "createSignalsmithAudio(options)",
      module: "src/engine/signalsmith-audio.ts",
      helpers: [
        {
          entry: "createSignalsmithNode(context, channelOptions)",
          module: "src/engine/signalsmith-audio.ts",
          description:
            "宿主绑定的官方节点：schedule/start/stop/addBuffers/dropBuffers/inputTime/setUpdateInterval/latency/configure；支持 AbortSignal 和 dispose。",
        },
        {
          entry: "audio.json clips: pitch / preservePitch / stretch",
          module: "src/engine/audio-document.mjs",
          description:
            "文件片段直接使用独立移调和保调变速，无需另写生成器；stretch 控制共振峰和算法窗口。",
        },
      ],
    },
    requirements: [
      "声音素材通过项目 assetUrl 定位，实时预览与离线导出复用相同处理规则。",
      "补偿算法延迟并按源时间准备历史，变化/跳转取消过期任务；不同倍率和素材需试听确认。",
    ],
    reference: reference("audio-creative", "docs/AUDIO-CREATIVE.md"),
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
    "混音/导出为 48 kHz 双声道；默认变速仍改变音高，pitch 指定额外半音移调，preservePitch 使用 Signalsmith 保持原音高。",
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
const toneLibraryItems = toneFeatureGroups.map((group) => ({
  id: "tone-" + group.id,
  name: "Tone · " + group.name,
  category: "audio",
  kind: "helper-library",
  package: "tone",
  description: group.description,
  integration: {
    entry:
      "createToneAudio(({ Tone, toneContext, destination, when, offset, duration, rate }) => ...)",
    module: "src/engine/audio-adapters.ts",
    projectEntry: "audio.ts + generators",
    helpers: group.exports.map((name) => ({
      entry: "Tone." + name,
      module: "src/engine/tone-runtime.ts",
      description:
        "Tone 15.1.22 API 的 HostTone 包装；类、时间单位工厂与全局形状的 Transport/getters 均绑定本实例 toneContext。" +
        (name === "UserMedia"
          ? " 实时设备输入使用可信工作台授权桥，不能离线重放；具体能力见 tone-live-input。"
          : name === "Recorder"
            ? " 录制已有实时声音，不申请设备权限；不能在 OfflineContext 中直接录音。"
            : name === "Context"
              ? " 子上下文借用同一原生 AudioContext，并跟随宿主时钟推进。"
              : ""),
    })),
  },
  supports: { realtime: true, offline: true, seek: "author", template: false },
  requirements: [
    ...audioRequirements,
    "可自由组合全部官方类；设备与浏览器限制见对应接口说明，正式导出使用可重建的项目素材。",
    ...(group.exports.includes("UserMedia")
      ? [
          "UserMedia 经可信工作台显式授权的 PCM 桥接入麦克风；实时设备输入不能重放历史，正式导出前先固化为项目素材。",
        ]
      : []),
    ...(group.exports.includes("Recorder")
      ? [
          "Recorder 录制已有实时输出，不申请麦克风；不能在 OfflineContext 中直接录音。",
        ]
      : []),
    "使用 build 提供的 HostTone.Transport；事件按宿主绝对时间调度并支持取消、重建与释放。Tone.Offline 回调使用第二参数 offlineTone，防止外层命名空间路由到父上下文。",
  ],
  reference: reference("audio-creative", "docs/AUDIO-CREATIVE.md"),
  sources: [
    "src/contracts/audio-library-catalog.mjs",
    "src/engine/audio-adapters.ts",
    "package.json",
  ],
}));
/** @type {AuthoringCapability} */
const toneLiveInput = {
  id: "tone-live-input",
  name: "Tone 实时麦克风与录音",
  category: "audio",
  kind: "helper-library",
  package: "tone",
  description:
    "Tone.UserMedia 在安全预览中通过可信工作台的受限 PCM 桥使用真实麦克风；支持设备选择、音量、静音、效果、Meter/Analyser 与 Recorder。",
  integration: {
    entry: "new Tone.UserMedia().open(deviceId?) inside createToneAudio build",
    module: "src/engine/audio-adapters.ts",
    projectEntry: "audio.ts + generators",
    helpers: [
      {
        entry: "Tone.UserMedia.open / close / enumerateDevices",
        module: "src/engine/tone-runtime.ts",
        description:
          "工作台显式允许后申请浏览器麦克风权限；取消、关闭预览与最后一个输入释放时关闭所有自有采集资源。",
      },
      {
        entry: "Tone.Recorder / Meter / Analyser",
        module: "src/engine/tone-runtime.ts",
        description:
          "连接已有声音进行录音或分析；Recorder 不会自行申请麦克风。",
      },
    ],
  },
  supports: { realtime: true, offline: false, seek: "author", template: false },
  requirements: [
    "使用 build 提供的 HostTone 和宿主上下文；返回 ready: input.open() 与本实例 dispose。",
    "首次设备输入必须由用户在当前可信工作台预览中明确允许，再由浏览器授权；保持 opaque iframe 隔离。",
    "实时输入代表当前声音，不能任意 seek 到过去或在离线导出重现；录成项目 public 素材后使用文件音源或采样器。",
  ],
  reference: reference("audio-creative", "docs/AUDIO-CREATIVE.md"),
  sources: [
    "src/engine/tone-runtime.ts",
    "src/engine/live-audio-input.ts",
    "studio/live-audio-input.js",
  ],
};
/** @type {AuthoringCapability[]} */
const items = [
  ...visualItems,
  colorSource,
  ...animationItems,
  fileAudio,
  ...audioItems,
  ...toneLibraryItems,
  toneLiveInput,
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
      "文件与 Web Audio/Tone.js/Signalsmith Stretch/Worker PCM/WASM/SoundFont/自定义生成器可混用，audio.json 统一组织音源、轨道、片段、总线和效果。",
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
    "| 音频辅助库 | " +
      names("audio", "helper-library") +
      " | 完整 Tone 命名空间按功能查询；使用宿主上下文和绝对时间，支持准备、任意片段与释放。 |",
    "| 音频处理器 | " +
      names("audio", "processor") +
      " | audio.json 的轨道、总线和主输出可配置处理链；支持片段、循环、淡化、变速、独立移调、保调变速、Tone 完整效果和音量自动化。 |",
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
