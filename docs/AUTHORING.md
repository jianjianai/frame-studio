# 工程接入与接口说明

修改边界见 [NEW-PROJECT-STANDARD.md](NEW-PROJECT-STANDARD.md)。每个视频的全部文件都属于 `projects/<id>/`，项目任务不能修改目录之外的文件。

## 新建、资源与测试

```powershell
pnpm animation:new my-film "我的动画" --renderer canvas
pnpm assets:import my-film "D:/assets/voice.wav" --license "来源与许可"
pnpm project:check my-film --strict
pnpm project:scope my-film
```

自动注册 `projects/*/project.ts`。工程私有模块、脚本、测试都在本目录；可以只读调用 `../../src/engine/` 接口。`public/` 是运行素材，`production/` 是非运行源文件与许可，`exports/` 是忽略的导出结果。`assetUrl('films/my-film/image.webp')` 对应 `projects/my-film/public/image.webp`。

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

公共播放器和导出器调用同一 render(time)，场景不创建独立时钟。按需要释放 timeline、事件、GPU、纹理与音频节点。初始化失败也回收本实例资源。随机内容采用固定种子。

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

生成器必须支持任意 offset 独立重建，不能依赖上一段运行历史。实时播放使用 AudioContext；命令导出使用 OfflineAudioContext，按最多 10 秒一段渲染。滤波、混响等需要历史的效果必须根据源时间重建预滚动状态或解析状态，避免分段交界变化。随机噪声使用固定种子/源时间。不要在模块导入时播放声音或访问文件系统。

浏览器 WebM 录入当前每轨/总音量和静音设置。命令 MP4 使用元数据中的每轨设置、总增益 1，不读取浏览器临时调音。两者复用相同的音轨裁切、定位与生成接口。

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

浏览器的“导出作品”支持当前帧 PNG、字幕 SRT 和含混音的 WebM。WebM 从头实时录制，保持页面可见，切换后台会取消。命令导出逐帧绘制，不依赖实时预览帧率。

开发页或 `?debug=1` 播放器提供 `window.__FRAME_STUDIO__`。`/?render=my-film&width=1280&time=5&subtitles=1` 为离线入口；等待 ready 后使用 frame(seconds, subtitles)、dataURL() 和 audioChunk(start, duration)。片段音频返回 48 kHz 双声道 16 位 PCM 的 Base64，每段不超过 10 秒。
