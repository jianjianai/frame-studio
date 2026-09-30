# Remotion 工程

Frame 支持以 Remotion React 组件编写、预览和导出视频。默认新建仍为空白合成；只有显式选择 Remotion 才生成 React 示例。核心包、Player、Renderer、Bundler、Media、Transitions 和 Web Renderer 固定为同一版本 4.0.530。

## 创建与入口

~~~sh
pnpm film new react-film "React 视频" --renderer remotion --duration 12 --fps 30 --width 1920 --height 1080
pnpm film context react-film --json
pnpm film reference remotion --json
pnpm film check react-film --strict
pnpm film dev react-film
~~~

- project.ts：静态时长、帧率、画幅、字幕、Frame 音轨和加载入口。
- composition.tsx：默认导出实际视频 React 组件。使用 useCurrentFrame、useVideoConfig、Sequence、Series、spring、interpolate 等 Remotion 接口。
- scene.ts：公共 Remotion 适配器入口，不需要自行实现播放时钟。
- public/：项目独占素材。staticFile("photo.png") 与 assetUrl("films/react-film/photo.png") 均指向本项目素材。
- exports/、.cache/：输出和临时构建，遵守原有项目边界。

project.ts 中保留 load: () => import("./scene")，并声明 loadRemotion: () => import("./composition")。可选 remotion: { inputProps: { title: "可配置内容" } } 将 JSON 参数传给组件；预览和导出使用相同参数。帧率、尺寸和时长以 project.ts 为准，durationInFrames = ceil(duration * fps)。

已有 Remotion 工程可将选中的 Composition 的 component 放入 composition.tsx 并默认导出，将该 Composition 的 fps、durationInFrames/fps、width/height、defaultProps 对应填入 project.ts。保留项目内组件、CSS 与素材；无需运行 Remotion Studio 或自行 registerRoot。多个影片分别创建 Frame 工程；组件内部可继续拆分和复用本项目模块。calculateMetadata 的结果需写入静态 project.ts，避免工具所读时长和实际合成时长分歧。

## 混合引擎与素材

React/SVG/HTML/CSS 直接由官方 Player 和浏览器排版，不转换成近似 Canvas 图形。可使用 @remotion/transitions，以及 @remotion/media 的 Audio、Video。标准 Img、Sequence、字幕和 React 组件可自由组合。

已有 Frame Canvas、PixiJS、Three.js、Babylon.js、Lottie 或 visual.json 场景可通过 FrameScene 嵌入 Remotion。保持 load 函数稳定，避免每次 React render 都重建引擎：

~~~tsx
import { Sequence } from "remotion";
import { FrameScene } from "../../src/engine/remotion-composition";
const loadScene = () => import("./layers/world");

export default function Film() {
  return <Sequence from={30} durationInFrames={90}>
    <FrameScene load={loadScene} />
  </Sequence>;
}
~~~

FrameScene 将 Sequence 内的帧时间传给 render(time)，支持异步 prepareFrame、任意跳转和实例释放。不要让嵌入场景创建自己的循环。Remotion 原生 DOM 不是 CanvasImageSource，不能伪装成 visual.json 的 Canvas scene；混合画面以 Remotion 组件为根，Canvas 合成作为 FrameScene 子层。Remotion 子组件直接嵌套即可。

## 音频和预览

组件音频由 Remotion 管理，项目原有 audioTracks/audio.json/generated audio 继续由 Frame 管理。公共播放器统一播放、暂停、跳转、变速、循环和总音量；Remotion 媒体缓冲会通知公共音频时钟。组件音量与效果由 React 代码控制，Frame 音频面板调整 Frame 的音轨。

原生导出先由 Remotion 处理组件内音视频，再与 Frame 多音轨混合一次；分段导出的最终音频重新从完整区间生成，避免分段截掉组件声音。片段和目标帧率转换由公共导出计划控制。`film audio-export` 的 WAV/FLAC/MP3/OGG/M4A 混音包含组件声音；启用 stems 时，Frame 音轨按原有轨道输出，Remotion 组件音频作为独立的 `remotion-components` 汇总轨输出。导出帧和声音始终来自冻结工程输入。

## 导出与工具

~~~sh
pnpm film frame react-film --time 2 --width 1280
pnpm film storyboard react-film --times "0,2,5"
pnpm film render react-film --start 1 --end 4 --width 1280 --fps 24
pnpm film export react-film --width 1920
~~~

frame、poster、storyboard 使用官方 renderStill；视频使用官方 renderMedia。复用 FRAME_BROWSER，不自动下载额外 Chrome。导出到项目 exports，拒绝默认覆盖，生成 FFprobe 验证与渲染报告；正式分段导出继续支持恢复。CLI、本地 MCP、远程任务和 Agent 工具复用这些入口。frame_create_project / works_create 的 renderer 参数可以传 remotion；能力目录和 context/reference 会指向本指南和 composition.tsx。

浏览器 PNG/WebM 使用官方 Web Renderer，可取消。其兼容性与原生服务端不同：

- 浏览器导出用 @remotion/media 的 Audio/Video；旧 Html5Audio/Html5Video、OffthreadVideo 等不受 Web Renderer 支持的组件请走服务端导出。
- 浏览器导出保持工程原始 fps；需要转换 fps 使用服务端。裁切位置落在工程帧网格上。
- 浏览器需要相应 WebCodecs 与 Web Renderer 能力；不支持的浏览器/组件会报错，不退化为黑画面或无声成功。
- 浏览器 Frame 混音分段生成，PCM 缓存上限 128 MiB；长片使用服务端导出。
- 同步 dataURL() 仅适用于 Canvas。通用调试截图使用 await capture() 或 await captureAt(time)，CLI/MCP 截图自动使用原生 Renderer。

官方接口与兼容性：[Player](https://www.remotion.dev/docs/player/player)、[Renderer](https://www.remotion.dev/docs/renderer)、[Web Renderer](https://www.remotion.dev/docs/web-renderer)、[浏览器渲染限制](https://www.remotion.dev/docs/client-side-rendering/limitations)。Remotion 的使用遵循其官方许可。
