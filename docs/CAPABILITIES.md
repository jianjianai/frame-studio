# 可用能力与 AI 接入

本页说明项目能用什么、如何发现准确接口，以及混合使用的工程边界。不规定内容、风格、镜头、配乐或制作方法，也不为框架排序。默认 `composition` 是空白工程容器，创建工程不等于已决定采用 2D、3D 或 React。

## 一次查询，不猜支持范围

```sh
pnpm --silent film capabilities --json
pnpm --silent film capabilities --category visual --json
pnpm --silent film capabilities --category animation --json
pnpm --silent film capabilities --category audio --json
pnpm --silent film capabilities --query "路径" --json
pnpm --silent film capabilities --id remotion --json
pnpm --silent film describe capabilities --json
```

category 为 visual、media、animation、audio；query 对能力名称、用途、接入与限制做大小写不敏感的文字筛选，id 返回一项准确能力。不需要先创建作品，也不执行场景、GPU 初始化或素材下载。未知字段、分类与 id 明确报错；找不到 query 的匹配项只返回空列表。输出的 supports 表示适配协议，实际 GPU、解码器、浏览器和用户素材仍需运行验证。

CLI、本地/平台 MCP 的 `frame_capabilities`、平台 Agent 的 `node scripts/work-tool.mjs capabilities`、工程 context 摘要和新建 README 来自同一能力目录。视觉与音频适配项由运行时注册表派生；文档不维护第二份 renderer enum。

MCP 参数例子：`{"category":"audio"}`、`{"id":"remotion"}`。Agent 对应 `node scripts/work-tool.mjs capabilities '{"id":"remotion"}'`。平台 CLI 可用 `pnpm --silent platform capabilities -` 从 stdin 传递同样过滤条件。需要正文时，CLI 使用 `film reference <name> --json`，Agent 使用 `node scripts/work-tool.mjs reference '{"name":"<name>"}'`；省略 name 可列出参考目录。平台 MCP 使用 `frame_authoring_reference`，同样可省略 name；本地 MCP 使用 `frame_read_reference({name})`，name 必填，参考目录从 workspace/project context 的 references 获取。

连接器可能缓存旧工具清单。平台 workspace context 包含当前能力摘要与实时 schema 发现入口；用 `frame_tool_describe` 查询 `frame_capabilities`、`frame_works_create` 或 `frame_authoring_reference` 的当前参数，再调用所需工具。清单没有显示某个框架不表示服务端未支持。此指引不能强制刷新第三方连接器缓存。

## 框架、辅助库、素材分别是什么

| 类型 | 真实能力 | 入口与要求 |
| --- | --- | --- |
| 视觉根与合成 | composition、Canvas 2D、PixiJS、Three.js、Babylon.js、Remotion | 使用该能力返回的 integration；仅显式 renderer 选择会生成框架示例 |
| 动画资源 | Lottie Canvas | 自包含项目 JSON，按绝对时间定位；不冒充任意 AE 工程或表达式兼容 |
| 素材源 | 图片/SVG、视频、图像序列、纯色图层 | visual.json 素材源、Remotion 组件媒体或程序场景资源 |
| 动画辅助库 | GSAP、Flubber | 前者处理属性/时间线，后者处理路径形变；均不是独立 renderer |
| 音频来源 | 文件、Web Audio、Tone.js、PCM Worker/WASM、SoundFont/MIDI、自定义生成器 | 文件需要素材；程序生成需要真实模块、函数、Worker/WASM 或采样库与乐谱 |
| 音频处理 | 增益、声像、滤波/EQ、压缩、峰值保护、延迟、混响、失真、立体声宽度、旁白避让 | 配置在 audio.json 的轨道、总线、主输出链；限制见 audio-v7 |

GLB/glTF、贴图和后处理可以在相应 3D 场景中使用，不是额外的根 renderer。Three 的 `src/engine/three-assets.ts` 提供 `loadGltf(url, renderer)`（Draco/Meshopt/KTX2 解码）、`setAnimationTime(mixer, seconds)` 与 `createPostPipeline(renderer, scene, camera, bloom)`。后处理需要场景显式使用返回的 composer 渲染；`createThreeScene` 的默认 render 仍直接调用 renderer.render，仅在 build 中创建 composer 不会自动接入。Remotion 包含 React/DOM/SVG/CSS 与官方 Player、Renderer、Media、Transitions、Web Renderer。源码中的帮助库与资源处理工具也可按其公开接口使用，不能仅凭 package.json 已安装就声称有任意插件、任意模型或全浏览器离线兼容。

原有 `film composition engines` 和 `film audio engines` 继续分别返回视觉注册表和音频适配/处理器。Agent 的 `work-tool engines` 查询语音提供商、模型和音色，与这两个目录不同。

## 混合接入先看输出类型

输出 Canvas 的 Scene 可作为根场景，也可注册到 `createCompositionScene(options, visual, loaders)` 的项目内模块表。visual.json 管理片段、图层顺序、变换、时间映射和显式视频原声；复杂三维对象、粒子或模拟仍由场景代码管理。

Remotion 是 React/DOM 根。通过 `FrameScene` 嵌入 Canvas、PixiJS、Three.js、Babylon.js、Lottie 或 visual.json；原生 DOM 不是 CanvasImageSource，不能作为 Canvas 合成的 scene 图层。不要把 `engine: "remotion"` 标签当作 DOM 到 Canvas 的转换器。React 子组件在同一根内直接组合，详见 [REMOTION](REMOTION.md)。

GSAP/Flubber 控制所选 Scene 或组件的状态，不提供独立输出画布。GSAP 时间线保持 paused，按共享绝对时间定位；释放本实例的 timeline/tween，不清除其他工程或实例的全局状态。Flubber 从绝对时间计算插值进度，再由场景绘制路径。

全部 Scene 按协议支持重复、倒退、任意时间定位。宿主统一播放、取消和导出；模块不能自建独立 requestAnimationFrame 或音频时钟。异步 createScene 和 render 的 Promise 由宿主等待；prepareFrame(time, {signal}) 等待资源并响应 AbortSignal。异步创建和渲染不接收该 signal，宿主通过版本和销毁状态阻止旧结果提交，并释放失效实例。固定步长模拟、历史效果与跨切点状态可在模块内重建；适配器不自动赋予任意第三方代码这些能力。

## 从空白工程接手

1. 读作品 context，确认 project slug/工作 UUID、文件边界、元数据和 authority。已有 renderer 是工程事实；按本次需求决定是否保留，不因默认容器推断创作意图。
2. 按任务需要读取能力条目及对应 reference；读取够用的接口即可，不必重复输出所有长文档。
3. 新建时可显式传 renderer，也可保持默认空白容器。已有 id 不重跑 new；保留现有内容，先 checkpoint，再用 hash 保护的 edit/patch 修改项目入口。
4. Canvas 类工程接入 Scene/visual.json。采用 Remotion 时在项目添加 composition.tsx，声明 renderer、loadRemotion 和 scene 适配入口。若不再使用旧 Canvas 合成，移除其 loadVisual 声明；若要保留，必须在 React 根通过 FrameScene 显式连接。单独保留 loadVisual 不会显示 visual.json，authority.visual 仍指向 React 根，canvasComposition 只表示可选子文档。
5. 导入素材后，将返回 URL 接到权威文档或组件/Scene 代码；接入完再检查片段范围、素材时长和声画同步。
6. 先静态检查，再按相关片段做首帧、跳转、播放与视听检查；需要成片时使用冻结输入的导出与媒体验证。报告实际覆盖范围，工程通过不代表创作观感已审完。

静态元数据、资源隔离、读写 hash 和 lifecycle 见 [AUTHORING](AUTHORING.md)。合成编辑操作见 [COMPOSITION](COMPOSITION.md)，具体工具发现见 [AI-TOOLCHAIN](AI-TOOLCHAIN.md)。

## 音频权威与生成模块

声明 `loadAudioDocument` 后，audio.json 是混音权威；旧 audioTracks 不再控制实际混音。文件/语音导入应添加 source、track、clip 到该文档，或按实际根组件需要使用 Remotion 媒体。未声明文档的旧工程可继续使用 audioTracks；新多轨编辑可通过 audio get/edit 同步创建文档与加载入口。

生成器通过项目 loadAudio 模块导出 generators 注册表。audio.json 的 module 标识选择实际生成器，engine 标签记录能力类型，不会安装库、创建乐谱、生成 WASM 或自动加载用户采样库。生成器接收宿主 context、destination、when、offset、duration、rate，按任意片段重建并清理本次声音节点；Tone 实例不能使用全局 Transport 或关闭宿主上下文。

Frame 音频文档与 Remotion 组件音频分别管理并统一同步，正式导出混合一次。浏览器可播、独立音频导出和视频导出具有各自实测限制，见 [AUDIO-V7](AUDIO-V7.md)、[AUDIO](AUDIO.md)、[REMOTION](REMOTION.md)。旁白服务能力、音色和表达参数从配置服务实时发现，见 [SPEECH](SPEECH.md)，不从视觉目录推断。
