# FRAME 8.1.0 音频与预览改造

## 范围与身份

- 用户授权公共工作台维护、Tone/Signalsmith 接入、三种预览模式、发布、生产切换与项目垃圾清理。
- 主开发目录为 ovh-docker 的 frame-studio，main 基线 f08fcb25592bfdd9c0b2dbb713641d0e73b74e70；无新工作树，无默认发布前备份。
- 生产原版本 8.0.2 / 3b368c8afca9d28e5967c66ccf0c14cd7e984230。实施记录与上线事实分开，生产验收另记。

## 实现

- Tone 15.1.22 全部类与 HostTone facade、宿主 Transport/getters、时间工厂、有限 Offline/Timeline；不另建公共播放时钟。
- Signalsmith Stretch 1.3.2 官方 WASM/Worklet 的完整 Web API；官方 wrapper 的已验证兼容修复使用版本固定、源码逐项匹配，不改 WASM。
- Sampler/ToneSequence/Signalsmith/ToneTimeline 便利接口；文件片段 pitch/preservePitch/stretch；全部 18 个 Tone 效果可组合到权威 audio.json。
- 绝对源时间、随机 seek、取消/释放、有限并发与 PCM 内存预算；长声音采用固定 DSP 处理网格。
- 原始/压缩/完整缓存三模式按观看者选择；正式导出始终使用原始媒体。
- 完整资源清单覆盖 public、代码、平台运行资源、字体、Worker/Worklet/WASM；SHA-256 增量校验、有限下载并发、内容复用和自动更新。
- opaque iframe 保持隔离；可信父页面验证服务器资源清单后提供持久缓存；Blob/模块/样式跟随接受版本、有界回收。
- 用户缓存进度/文件列表/取消/继续/重试/清理、音频编辑器控件；AI 能力目录、参考文档和浏览器控制共用实际实现。

## 已查出的具体问题与修复

- 初始缓存桥静态 import 破坏旧独立预览 fixture，触发每音频片段握手超时。改为仅 live 预览 lazy import、立即确认并排队；延迟 1.8 秒桥加载仍成功。
- 弱网络原有测试恢复：压缩首播 869ms、冷跳转 289ms，持续播放 stallSamples=0；不重复请求和漂移恢复亦通过。最终统一检查又发现弱网 fixture 的泛化文本替换将 await 注入新增同步 ACK 函数，导致测试桥脚本 SyntaxError；将 350ms 延迟准确注入原异步音频 ACK，并加入实际注入和父页桥安装检查，保留零缓冲门槛。修后实测 startup=5447ms、stallSamples=0、advance=15.96s、requests=28、duplicates=0，音频产品未因此修改。
- Signalsmith 长文件不同离线切点导致结果不一致：固定 2 秒网格、历史准备及交叉淡化，40 秒源文件不规则切点 PCM 最大误差 1.49e-8。
- 取消后的新版本不能丢失或重试回旧版；FRAME_AI 等待必须识别当前 revision、失败、取消与退出模式。
- 模块改写使用 es-module-lexer2.3.2 语法位置，避免修改普通字符串、正则或 tagged template。
- 工作台旧 UI mock 未提供 V8 live 合约、外部 speech engine 身份及模型列表；更新真实合约，保留跨窗口、重复状态、导出冻结与错误恢复检查。
- 既有 root 拥有的 UI 结果目录不能覆盖；支持独立 FRAME_UI_TEST_REPORT_DIR，不改旧产物权限。
- Node24 test 默认 spec 与 strict server TAP 摘要格式不同：正式发布 gate 同时解析两者，不伪造旧成功记录。

- 新增 native Remotion 音频组合 MP4 回归在 Vite 预览成功后，捕获 Webpack 将 signalsmith-stretch?raw 按未导出的子路径解析的问题；修复原生 bundler 的官方资源加载规则，保持 Worklet 原源码供逐项兼容匹配。

- 全量服务端浏览器检查发现实际 live status 新增 mediaMode 被旧 strict 消息契约拒绝，导致聊天实时版本引用丢失；共享契约引入同一模式枚举，保留未知字段和无效模式拒绝，并用真实工作台/DB 回归验收。
- 全部 Tone 接口审计在真实 Chromium 中证明 UserMedia 在 opaque iframe 即使增加 microphone allow 仍被 Invalid security origin 阻止；Recorder 可直接录制已有声音。补上可信工作台显式授权、有界 PCM 与硬件释放桥，不为麦克风取消隔离；实时输入不能重放历史，离线导出先固化项目素材。
- 原压缩预览 high 质量测试旧期待原文件，现以独立 original/compressed 模式验证新契约；正式导出继续以原文件验收。

## 验证状态

- 服务端媒体/资源专项 32/32，实际 FFmpeg AAC/H264 转码并完整解码；详见同目录 preview-modes-server-validation-20261001.md。
- 浏览器完整缓存专项 11/11：SHA、Range、配额、取消、安全桥、断网原生视频/声音/字体/Worker/Worklet/WASM、9 次更新 Blob 有界、清理作品隔离与自动更新。
- 音频创作真实 Chromium 专项已验证 18 效果、半音与保调倍率、流式/循环/配置、随机 seek、Sampler/ToneSequence、HostTone 与事件乐谱；最终统一 gate 结果待补充。
- 初始完整 verify 因缓存桥回归失败；第一次执行曾被工具默认 120 秒中断。它们均不算通过结果。
- Tone 文档效果固定处理网格已使 8 个调制效果长位置切点误差归零；LFO/载波使用影片源时间，相邻采样衔接与倍率变化已实测。实际用户 Tone 控件与 workspace gate 已完成，28/28、errors []、pnpm exit0。原生混合 Remotion MP4 回归 1/1、既有原生导出与缓存回归 2/2 均 exit0，验证实际 12 帧、音轨、完整 FFmpeg 解码与非零 PCM。Signalsmith 最大 500ms block / 250ms interval / split 配置也在 Chromium 验证了 750ms 实际延迟补偿。最终完整 verify 待执行；发布/生产尚未执行。

## 全量检查中间结果

- verify-final-20261001T165114Z：170 单元通过；MCP 126 条中 125 通过、1 用户自备音色库可选跳过；服务端 373 条中 365 通过、2 失败、6 本地集成条件跳过，pnpm 总退出 1。两项失败分别是上述 live status 契约和旧 proxy 高质量期待；此轮不作为最终通过证据。
- 最终源代码需包含麦克风桥和严格消息契约修复后重新冻结、运行 pnpm verify；发布出的正式固定 digest 镜像再运行 pnpm verify:release。


## 完整输入与上下文验收

- Tone.UserMedia 在保持 opaque origin=null 的预览中，经可信按钮批准后连接真实 Chromium fake-device 麦克风，再进入 child Worklet、Tone.Meter 和 Tone.Recorder。批准前 4.5s、上下文暂停 5.5s 后恢复均成功；峰值 .15332，Opus/WebM 25231 bytes，close 后全部原生音轨 ended。
- 原生与安全桥输入 2/2、父页安全/生命周期 1/1 均退出 0。涵盖迟到 getUserMedia 与设备枚举取消、拒绝与停止不可静默重开、foreign frame/非法参数/合成点击拒绝、44.1/48k 共用捕获、有界 4 包、心跳与 credit 分离、失联回收、src/作品切换撤权、离线上下文不申请输入。
- Tone.Context 子包装跟随宿主 tick；真实 offline Loop 4 次事件、非零 RMS .02269，live 共享绝对调度时间及 dispose 后停止事件验证通过，不另建 NativeAudioContext。
- Tone 文档 PitchShift 在倍率 2 的 native PeriodicWave normalization 与参考有轻微幅度差（RMS 差 .00216，相关 .999978）；不宣称变速后每个采样都位相/幅度逐位一致。其余已测固定网格切点仍一致。
- 严格 live status 契约修复后，原 v5 实际 UI+DB 引用、审片、草稿、撤销回归 1/1；新增独立 original/高质量 compressed/冻结导出代理回归 1/1，实际 converted=4，均 exit0。


## 最终麦克风与分析回归补充

- 17:38 全量检查未通过：170 单位测试通过；MCP 128 项中 126 通过、1 native Meter 峰值零失败、1 可选音色库跳过，随后 server 阶段未执行。未据此发布。
- 真实录音 PCM RMS 0.1285 证明输入存在；定位 Tone 内部 split → native Analyser 分支未持续拉取。单独公开 output 或源级静音支路不足以修复。
- 固定 Tone 15.1.22 的宿主 facade 为 Analyser/Meter/DCMeter/FFT/Waveform 的 native 分析分支提供同 rawContext 共享静音 sink；不外放；实例释放对应连接，最后一个实例释放 sink，初始化失败及 context 关闭回收。
- Node 24/root 的 frame-development 实际浏览器回归 2/2 通过：持续 440 Hz 立体声 WAV，先仅分析、无 Recorder/扬声器；Meter 0.21546、Analyser/Waveform 0.30000、DCMeter 0.29931、FFT -25.29 dB；随后 Recorder 25822 B，实际解码 PCM RMS 0.21101。
- 同目标 opaque iframe 授权等待 4.5 秒、context 暂停 5.5 秒后恢复，Meter 0.1245、Recorder 25289 B；关闭/取消/设备枚举取消全部通过。原默认 fake 输入断言也在修复后通过；未放宽断言，未延长等待掩盖问题。pnpm typecheck 通过。
- 该音频目标 session-920927e9b06e62a9203071c6。以下重新冻结整个源树执行最终全量检查。


## 最终源检查与已复测修复

- verify-final-20261001T180743Z：pnpm verify 退出 1，不能记成整套通过。类型检查、21 个单位文件 / 170 测试通过；MCP 128 项，127 通过、0 失败、1 可选采样音色库跳过；server 375 项，366 通过、3 失败计数、6 跳过。
- server 中两次失败计数来自同一个 CLI 能力目录采集的父/子测试：Buffer 逐块隐式转字符串截断 UTF-8。只修改测试 stdout/stderr.setEncoding('utf8') 两行，保留完整 deepEqual；实际 CLI、HTTP 与 MCP 编解码不存在同类问题。原集成文件 7/7、0 跳过复测通过（toolkit-utf8-final-20261001T180743Z-rerun.log）。
- 另一个失败是移动端父/子同时完整展示编译错误，挤压画面。改为默认折叠、可键盘展开的全文诊断，显示值去除 CSI/OSC/ESC，原上报错误保留；重连始终可用。麦克风提示独立网格行；真实 iframe callback/ref 管理缓存和输入 bridge，修复预览数据先于作品信息返回时漏装 bridge 的竞态，来源/窗口/URL 校验未放松。
- 最新构建后的原公共 workbench、live-preview-creation 和 v8-cache 文件 3/3、0 跳过、exit 0（workbench-layout-targets.log），保留原 mobile >=140px、控件不重叠及所有播放/缓存/更新断言。受控真实编译失败与麦克风权限 UI probe 1/1，确认键盘全文、typed ACK、拒绝/重允许、无窄屏横向溢出；手机错误态 stage 272.75px，桌面麦克风提示时 preview pane 1436×939。最新类型检查、Studio 构建、diff 检查通过。
- 冻结源树与最后完整 run 比较：只变更上述四个 UI 文件及两行 UTF-8 测试采集，音频/服务器/能力目录实现均相同。保留完整 run 失败事实；正式发布镜像仍必须完整执行 pnpm verify:release 并通过才能部署，不以这些专项代替正式镜像全量门禁。
- 本地 server 六项跳过：真实 Codex/Claude/invalid CLI、Windows 本地执行、可选 GeneralUser 包及 Docker 端到端。正式镜像门禁会开启真实 Docker/CLI 执行，Windows 与用户音色库的可选跳过依严格白名单处理；未声称本地跳过项已经通过。
