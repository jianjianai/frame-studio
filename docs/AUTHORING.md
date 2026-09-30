# 工程接入与接口说明

V7 的音频编辑、生成框架和处理器见 [AUDIO-V7.md](AUDIO-V7.md)。V6 保留场景/音频协议 1 的旧作品兼容，新增可等待目标帧的协议与独立 `visual.json` 合成文档。默认新建为空白合成，无预选引擎。能力与接口见 [混合合成](COMPOSITION.md)。`beats` 中可选的唯一 `id` 用于更稳定的审片引用，例如 `{ id: 'opening', at: 0, title: '开场', detail: '...' }`；beats 是审片标记，可编辑视觉片段位于 visual.json，两者独立。引用和结果操作见 [V5 升级说明](V5-UPGRADE.md)。

修改边界见 [NEW-PROJECT-STANDARD.md](NEW-PROJECT-STANDARD.md)。每个视频的全部文件都属于 `projects/<id>/`，项目任务不能修改目录之外的文件。

统一工具入口是 `pnpm film help`；AI 接手与分镜预览见 [AI-WORKFLOW.md](AI-WORKFLOW.md)。单项目运行、局部修改、检查点、带声音审片、后台任务、冻结导出与旁白见 [AI-PRODUCTION.md](AI-PRODUCTION.md)，不需要连接 MCP 即可使用。

## 新建、资源与测试

```powershell
pnpm film new my-film "我的动画" --duration 12 --fps 24
pnpm assets:import my-film "D:/assets/voice.wav" --license "来源与许可"
pnpm project:check my-film --strict
pnpm project:scope my-film
```

自动注册 `projects/*/project.ts`。工程私有模块、脚本、测试都在本目录；可以只读调用 `../../src/engine/` 接口。`public/` 是运行素材，`production/` 是非运行源文件与许可，`records/` 单独保存修改记录、验证报告与审查结论，`exports/` 是忽略的导出结果。`assetUrl('films/my-film/image.webp')` 对应 `projects/my-film/public/image.webp`。

`tests/unit/` 与 `tests/e2e/` 位于项目目录，Vitest/Playwright 自动发现；无需修改公共测试列表。独立测试端口通过 `FRAME_TEST_PORT` 配置。

## 场景接口

```typescript
import type { Scene, SceneOptions } from "../../src/engine/types";
export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    canvas,
    render(time) {
      /* 按绝对秒数重绘，允许倒退与重复 */
    },
    dispose() {
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
```

render 可返回 Promise；异步资源可在 prepareFrame(time, {signal}) 中就绪，所有预览、截图和导出均等待后再提交画面。快速跳转时旧请求会被取消且不能覆盖新帧。公共播放器和导出器调用同一 render(time)，场景不创建独立时钟。按需要释放 timeline、事件、GPU、纹理与音频节点。初始化失败也回收本实例资源。随机内容采用固定种子。

## 多音轨与浏览器生成音频

`project.ts` 示例字段：

```typescript
audioTracks: [
  { id: 'voice', name: '旁白', kind: 'file', src: 'films/my-film/voice.wav', start: 2, offset: 1, duration: 8, gain: 1 },
  { id: 'melody', name: '旋律', kind: 'generated', gain: 0.6 },
  { id: 'pulse', name: '节奏', kind: 'generated', gain: 0.4 },
],
loadAudio: () => import('./audio'),
```

最多 32 条，每条 id 唯一。`start` 是项目起始秒数（默认 0），`offset` 是素材或生成器内部起点（默认 0），`duration` 默认到影片末尾，`gain` 默认 1、范围 0–4，`muted` 默认 false。文件不足时余下时间静音。播放器支持每轨静音、音量和总音量，暂停、跳转、变速和循环同步作用于所有音轨。旧 `audio: 'films/.../audio.wav'` 保留兼容，不能同时配置非空 audioTracks。

脚手架已提供 `audio.ts` 的可用示例，只需加上上述元数据即可启用，不需要重建音频文件。也可以自行实现：

```typescript
import type { GeneratedAudioOptions } from "../../src/engine/types";
export function createAudio(options: GeneratedAudioOptions) {
  const { trackId, context, destination, when, offset, duration, rate } =
    options;
  // 使用传入的 BaseAudioContext 创建 Web Audio 节点。
  // 从源时间 offset 生成 duration 秒内容，在 context 时间 when 开始，按 rate 播放。
  // 连接 destination，不创建 AudioContext 或独立计时器。
  return {
    dispose() {
      /* stop/disconnect 本次调用的全部节点 */
    },
  };
}
```

createAudio 可返回可选的 ready: Promise<void>，表示本次调用的初始缓冲已就绪；播放器等待它完成后才启动共同声画时钟。准备期间所拥有的 AudioContext 暂停，ready 不能等待播放时间推进。暂停、跳转和变速会撤销旧等待，dispose 仍须停止该调用的节点与后台调度。

可选导出 `prepareAudio(context): void | Promise<void>`，在播放时钟启动前加载素材并初始化生成器；此阶段不得启动声音节点或独立时钟。

分段生成器还可导出 `prepareSegment({trackId, context, offset, duration, rate, signal})`：实时播放只需准备首段缓冲，后续在 `createAudio` 中根据公共音频时间按需补充；OfflineAudioContext 必须先准备完整的请求片段再返回。播放器在播放、跳转和变速后等待准备完成才推进公共时钟；暂停状态下也可预先准备所选位置，但不能启动声音。可选 `signal` 用于撤销过期位置的请求，生成器取消本请求即可，不得销毁其他会话仍需的资源。异步生成失败通过 `createAudio` 参数中的 `onError(error)` 通知播放器，不能让画面继续走而音频缺失。导出 `disposeAudio(context)` 释放所属播放/导出会话的后台线程和缓存；每次 `createAudio` 的 `dispose()` 仍须立即停止本次声音节点及后续调度。

原采样乐谱可用 `createSampledScoreAudio` 边生成边播放；`createPcmAudio` 仍适合体积小、生成成本低的整段声音，详见 [AUDIO.md](AUDIO.md)。

生成器必须支持任意 offset 独立重建，不能依赖调用方按顺序请求。实时播放使用 AudioContext；浏览器和命令导出都使用 OfflineAudioContext。命令每段最多 10 秒，浏览器以最多 1 秒音频片段和视频交错编码。滤波、混响等需要历史的效果必须根据源时间重建预滚动状态或解析状态，避免分段交界变化；允许在生成器内部顺序推进并缓存，冷跳转到后段时先重建前面的状态。随机噪声使用固定种子/源时间。不要在模块导入时播放声音或访问文件系统。

浏览器 WebM 离线混合当前每轨/总音量和静音设置。命令 MP4 使用元数据中的每轨设置、总增益 1，不读取浏览器临时调音。两者复用相同的音轨裁切、定位与生成接口。

## 弱网预览

发布预览的压缩音轨先准备约 6 秒音频；按实际下载耗时最多增加到 8 秒，再启动共同声画时钟。播放时提前请求后续片段，按播放截止时间排序，最多并发 6 个下载。多轨共用内容哈希缓存，预加载、播放和再缓冲复用未完成请求；跳转只取消过期窗口，暂停立即停止声音和时钟。解码缓存上限 128 MiB，多轨或高速播放时自动收缩预取范围。

使用 audio.json 的实时混音仍读取原始素材，不预先合成整片；首段准备约 4 秒，播放时提前准备后续区间。网络导致音频未及时就绪时，播放器显示“正在缓冲，稍后自动继续”，一起暂停画面与声音，准备完成后恢复；取消播放不会稍后自行恢复。导出继续使用原始音频和既有质量设置。

预取能够吸收网络延迟和短时波动。持续带宽低于全部活动素材的码率时仍需等待，尤其是多轨未压缩 WAV；可使用音频面板或 film audio-media 生成兼容的压缩素材副本。

## 视频和单帧导出

```powershell
pnpm render my-film --width 1920 --fps 30
pnpm render my-film --start 5 --end 10 --width 1280
pnpm frame my-film --frame 150 --width 1280
pnpm frame my-film --time 5.5 --no-subtitles
pnpm render my-film --frame 150
```

帧编号从 0 开始；`--frame` 默认按项目 fps 换算秒数，指定 `--fps` 可覆盖。`--time` 直接指定秒数，与 `--frame` 互斥。单帧输出 PNG，无需 FFmpeg；视频输出 MP4，需要 FFmpeg 和 FFprobe 验证。

输出默认在 `projects/<id>/exports/`。`--out` 可指定本项目目录内的路径，默认拒绝覆盖，明确添加 `--force` 才替换已有文件。支持 FFMPEG_PATH、FFPROBE_PATH、FRAME_BROWSER。

浏览器的“导出作品”支持当前帧 PNG、字幕 SRT 和含混音的逐帧 WebM。WebM 独立选择分辨率和帧率，单独创建 high 细节场景，按第 i 帧 = i / fps 绘制并等待编码器接收每一帧，再封装成视频。命令导出复用同一帧数计算，帧率默认项目 fps；两种导出均不依赖实时预览帧率。片长不整除帧间隔时补齐最后一帧时长，音频补齐对应长度。浏览器可取消并释放资源，后台可能变慢但不主动丢帧；离开项目会取消。浏览器需支持 WebCodecs，编码文件缓存上限 256 MiB，超出时使用命令导出，不退回实时录屏。

`pnpm film storyboard my-film --times "0,2,5"` 生成带时间标记的 PNG 拼图和 JSON 清单，默认取 beats 与首尾帧。`posterTime` 可在元数据中指定封面秒数，省略时用片长中点。

开发页或 `?debug=1` 播放器提供 `window.__FRAME_STUDIO__`。`/?render=my-film&width=1280&time=5&subtitles=1` 为离线入口；等待 ready 后使用 frame(seconds, subtitles)、dataURL() 和 audioChunk(start, duration)。片段音频返回 48 kHz 双声道 16 位 PCM 的 Base64，每段不超过 10 秒。

## 画幅与输出尺寸

`project.ts` 可声明 `composition: { width: 1080, height: 1920 }` 来使用竖屏，正方形使用相同宽高；省略时沿用 1920×1080。元数据宽高为 2–8192 的整数，播放器、缩略图、单帧与视频输出共用此比例。新建项目可传 `--width` 和 `--height`。

工作台的分辨率选项按长边适配，实际输出宽高会显示在选项中。命令行 `--width` 表示实际像素宽度，需为 2–3840 的偶数；高度按画幅取最近偶数，任一边超过 3840 时需降低宽度。
