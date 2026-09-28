# AI 浏览器创作与审片

具备浏览器能力的 AI 可以在自己的浏览器内预览、审片和导出，节省服务器渲染资源。

通过 MCP 调用 `frame_works_browser({id:"作品 UUID"})`，或 CLI `pnpm platform works_browser '{"id":"作品 UUID"}'`。

若返回 `state: building`，使用 `task_get` 等待返回的任务完成，再次调用。服务器只编译作品并提供静态资源。`state: ready` 包含一小时有效的私密 URL、源码指纹与控制台入口。作品修改后再次取地址，会自动编译最新内容。地址不要求另行登录，不应公开分享。

在返回的地址打开浏览器，控制台使用：

```js
await FRAME_AI.ready();
FRAME_AI.info(); // 时长、帧率、镜头、字幕、音轨
FRAME_AI.help(); // 所有可调用方法
await FRAME_AI.frame({ frame: 60 }); // 精确帧号，返回 PNG dataURL
await FRAME_AI.frame({ time: 2, width: 1280, subtitles: false });
await FRAME_AI.storyboard({ times: [0, 1, 2], width: 320 });
await FRAME_AI.play({ start: 1, end: 3, rate: 1, loop: false });
FRAME_AI.pause();
await FRAME_AI.seek(2.5);
FRAME_AI.setTrack("voice", { gain: 0.8, muted: false });
FRAME_AI.state(); // 状态、诊断与导出进度
const { id } = FRAME_AI.exportVideo({ start: 1, end: 3, width: 1280, fps: 30 });
FRAME_AI.exportStatus(id); // 成功后返回 blob URL、大小和 MIME
FRAME_AI.download(id);
FRAME_AI.cancelExport(id); // 取消正在进行的导出
FRAME_AI.release(id); // 释放已生成文件
FRAME_AI.subtitles({ download: true });
```

画面渲染、Web Audio 合成、PNG 截图、分镜和逐帧 WebM 编码均在客户端执行。片段导出的画面和声音使用相同的源时间起点，输出时间从零开始。独立渲染器不改变作品源码。编码需要浏览器支持 WebCodecs；播放器会报告错误，不会偷偷改成服务器渲染。首次有声播放可能需要点击“启用声音并播放”。

浏览器导出需要保持该标签页打开，默认最多缓存 256 MiB 的编码结果。平台后台 AI 任务和服务器 MP4 导出仍可在关闭浏览器后继续。这是两种可自行选择的执行方式。
