# Remotion 原生接入 · 7.4.0

日期：2026-09-30。工作目录：ovh-docker /home/agentdock/AgentDock/frame-studio，main。起始代码为 1ae5dac；开发期间他人提交的 8e233d3 生产记录已保留。本次只做工作台升级及开发提交，不发布生产服务。

## 交付范围

- 固定 Remotion 4.0.530 核心、Player、Renderer、Bundler、Media、Transitions、Web Renderer 同版本。
- --renderer remotion 原子脚手架，composition.tsx 默认 React 组件，loadRemotion 与 JSON inputProps，严格入口校验。
- 官方 Player 原生 DOM 预览，公共时钟、播放/暂停/跳转/变速/音量、媒体缓冲、字幕、异步截图、实例销毁。
- FrameScene 将现有 Canvas/2D/3D/合成场景嵌入 Remotion Sequence，等待异步准备与首帧绘制，释放各自资源。
- 项目级 staticFile 绑定；多个预览不会通过全局 public 路径串用其他工程素材。支持别名及 namespace import。
- 冻结输入内的官方 Bundler/Renderer，PNG、封面、storyboard、MP4、分段导出、恢复、FFprobe 验证、非整帧裁切及输出帧率转换。
- Remotion 组件声音与 Frame 多音轨只混合一次；正式导出最终声音包含两套音源；纯音频和 FLAC 等格式支持汇总混音以及 Frame/Remotion 分轨。
- 官方 Web Renderer 浏览器 PNG/WebM 与取消、分段 Frame 混音、明确兼容错误。
- CLI/MCP/平台/Agent 共用 renderer 枚举和工程上下文，新增 remotion reference；默认新工程仍是空白合成。
- 使用指南 docs/REMOTION.md，接口和工程文档同步更新。无数据库迁移。

## 实际验证

在 frame-development 执行 pnpm verify，退出码 0：

| 检查 | 结果 |
|---|---|
| 结构、平台检查、两套 TypeScript 检查 | 通过 |
| 单元测试 | 83 通过 |
| MCP | 86 通过，1 个可选音色库用例跳过 |
| 播放器和工作台生产构建 | 通过 |
| 服务端测试 | 187 通过，6 个环境相关用例跳过 |

既有环境跳过：3 个真实外部 Coding Agent/执行器用例、Windows 本地运行、授权 GeneralUser 音色库、真实 Docker executor 影片链路。本次未搭建这些可选外部环境，也没有将普通 verify 计作生产 release 验收。

新增 tests/mcp/remotion.test.mjs 实测 CLI/MCP 创建、component 入口、context/reference、引擎选择和独立素材绑定。旧 audio-v7 回归中遇到 Vite 后续优化 Tone 依赖导致页面重载；显式预优化依赖后该用例以及完整回归通过。

新增 tests/server/remotion.test.mjs 使用临时真实工程，包含 React/Sequence、视频、SVG 图片、Canvas 场景、组件 Audio 和 Frame 生成音轨。最新单独运行退出码 0，约 132 秒：

- 原生截图、倒退后同帧字节一致、不同帧变化。
- 首帧 Canvas 像素与浏览器截图像素断言；实际查看原生和浏览器 PNG。
- 0.27 秒非整帧起点、12→24 fps，36 帧 MP4，首帧像素、尺寸和音频校验。
- 真实 Player 播放/暂停。
- 浏览器 WebM 的实际帧数和音频流。
- 正式分段导出、最终混音、恢复已有验证片段。
- FLAC 混音、Frame 生成音轨 stem、Remotion 组件汇总 stem，响度分析确认非静音。

视觉检查发现最初 FrameScene 在首帧像素绘制前释放初始化 handle，原生/浏览器截图可能缺 Canvas 图层。修复为等待首帧 prepareFrame/render 后释放，并增加两种输出的像素检查。运行日志在忽略的 .cache/remotion-*.log，截图在 .cache/remotion-native-qa.png 和 .cache/remotion-qa.png；临时工程及冻结输入由测试清理。

## 明确边界

浏览器使用官方 Web Renderer，组件兼容范围与服务端不同：使用 @remotion/media 的 Audio/Video；旧 Html5Audio/Html5Video/OffthreadVideo 等走原生服务端。浏览器保持工程 fps，变更 fps 使用服务端；Frame PCM 缓存上限 128 MiB。同步 dataURL 不能表示 DOM，改用 capture/captureAt；受控 CLI/MCP 使用原生截图，不返回空白成功。

以静态 project.ts 为 Frame 元数据权威，已有 Remotion 工程将选中的 Composition component 接入；calculateMetadata 的结果先固化为项目元数据。组件自己的音轨由组件代码控制，Remotion 导出的汇总 stem 不冒充可独立控制的每个 React Audio 节点。指南已说明这些接口边界。

全量验证使用 root 运行后，普通用户最终构建曾因 dist/assets 所有权报 EACCES。按 docs/OVH-DEVELOPMENT.md 恢复 .cache、dist、studio-dist 到 UID/GID 10001，并再次执行普通用户 `pnpm build`，退出码 0，构建成功。最终 `git diff --check` 通过。
