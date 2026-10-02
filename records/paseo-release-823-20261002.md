# FRAME Studio 8.2.3 发布与生产验收

## 不可变身份

- 源码 `61719e317ef507d14ded6db07345867a61eacfc2`；归档 SHA-256 `077c7ec27787b495161182b65074e5c951fbfc64a245d5eb987c5110bf3ba28e`。
- annotated 标签 `v8.2.3` 对象 `5405000603ff18cfa11146bd9dafc360ec3cf48b`，保持不可变。
- [正式 Release](https://github.com/jianjianai/frame-studio/releases/tag/v8.2.3)；tag workflow `36987434330`、release workflow `36987442543` 全部成功。
- 正式镜像 `ghcr.io/jianjianai/frame-studio/app:8.2.3@sha256:96277b10ae5782f5cb770b43288e18f22534389b4ed81dcd7f27fe9789273e46`。
- Windows 安装包 16,244,080 字节，SHA-256 `36440b460fcd8d6c6cbbab907ffcca3a19e62da580674a9b103de0c17327bb63`，实际下载、校验与 PE 格式验证通过；未声称完成 Windows 原生安装运行。
- 发布校验 run `20261002T090625Z-0fa120a89f`，exit 0。

## 修复与 UI 范围

本轮只复审音频与预览相关 UI。此前数字草稿、效果 JSON 合并、采样/Signalsmith 控件、缓存进度与错误恢复、Pixi/Worker 缓存、窄屏和键盘问题已修复，见 [UI 记录](audio-preview-ui-review-20261002.md)。

8.2.3 统一会话播放意图，取消等待画面时的旧启动、旧恢复与迟到状态；重复播放复用当前准备，保留缓冲续播，见 [播放取消回归](player-intent-cancellation-823-20261002.md)。真实浏览器聚焦目标 7/7、类型检查通过。

另行独立真实 Space 键验证通过：首个按键显示准备状态，第二个按键取消，释放旧 render 后时钟仍暂停且 250 ms 稳定，浏览器错误为空。证据 `ui-space-cancellation-review.json` SHA-256 `ecf1a97def9ed126f906c1a01d46459d536205e36e10c4a1ae4986b7a5d0717c`，日志 SHA-256 `32f301adeb1114296b5c336d3e89934bb42a8ee3255817a469cc8694623dda86`。首轮私有观察器过早读取 defaultPrevented 的失败保留；没有改产品或放宽行为断言。

## 候选完整门禁

候选镜像 `sha256:5664db6c8fa913fd0529f6c40c7f205fcc6f8c90864e42fee291b47a4fe5642d`。

Run `20261002T084029Z-26ac11bf`，1225 秒，**784 PASS / 0 FAIL / 3 明确跳过**：176 核心、128 MCP、480 服务端通过。包括官方 Paseo 完整 UI、原生受控 CLI、实际 Docker 冷启动六作品、Tone/Signalsmith、三模式完整离线缓存与热更新、原始导出、新播放意图回归。跳过仅为既有可选素材/非 Linux 原生环境目标，实际生成的音色库回归仍执行。

- 回执 SHA-256 `cc2f7937c284b2d2defe589fb0a85a0553596b279f2cbad7a43c952da1c44d5f`。
- 日志 SHA-256 `6ac28495b7ff4c9a41ed44c6b0085fa75fb86b26ad6e48d3c0c00594944e3df7`。
- 严格 skip guard、HTTP 镜像身份、源码字节及 Paseo 官方包/四个补丁证明通过；自有容器和网络删除确认，cleanup errors 为空。

## 共享模型准备

真实候选镜像 warm run `20261002T090527Z-0c77cebb` 通过。Parakeet v2、Kokoro、可选 Parakeet v3 已就绪，复用既有缓存，内层准备 191 ms；两个原始下载归档大小和 SHA 保持一致。

- current/permanent 回执 SHA-256 `2392f508cf91dedb4bbca20cef546b080d0889ecf0853c0caa06381af85c3a18`。
- 日志 SHA-256 `90dc5d353cb37dec940f3962322ab1e7331d4744147e8f6922f00abf65ded00c`。
- 自有容器与脚本目录确认不存在，cleanup errors 为空。此项不是正式镜像原生 TTS/STT 结果。

## 后续阶段状态

正式镜像完整门禁 run `20261002T090758Z-a3efbedc` 已通过，1242 秒，同样 **784 PASS / 0 FAIL / 3 明确跳过**。回执 SHA-256 `55fd080aa6cb9a70e32b0111f677985a2c511911b7dc1856f865e8bff1c64220`；日志 SHA-256 `75108e4570ae1cde3ad50a7ad2036414d6d851ea9a11603f22864950c4901f31`。实际正式镜像、源归档与 HTTP 身份通过，自有容器和网络已清理，无错误。

正式原生语音 run `20261002T093201Z-f927e390` 通过：Kokoro 输出 24 kHz 单声道 PCM16，118,210 字节、2.4627 秒、峰值 14,180，finite PCM；Parakeet v2 在 460 ms 内识别同一段音频为 “Hello, this is a short speech test.”。工作进程十项资源关闭检查通过、正常 SIGTERM、无强制终止/后代/孤儿。`closeEventObserved=false` 如实保留，资源释放由进程身份及 IPC/stdio/handle 检查证明。付费 API 和模型下载均为 0，自有容器和脚本目录确认不存在。

原生 current/permanent 回执 SHA-256 `38158a839c8a3fc7d3269627fcbba56bc9e39795064f4450ac6288b57533935b`；日志 SHA-256 `b83bb62456e45e026db4124a68474dab764adc8d411a489162db8c91d3e176df`。没有声称物理麦克风、Windows 原生推理或可选 Parakeet v3 实际识别已验证。

生产切换 run `20261002T093410Z-2786959` 成功，耗时 81 秒：正式 8.2.3/61719e3/96277 镜像，studio/controller healthy、readyz 200。切换前任务/native/candidate 均为空；只修改 FRAME_VERSION 并更新这两个服务。原作品、素材和凭据保存检查通过，speech、PostgreSQL、两个开发服务的容器 ID、镜像与启动时间不变。未执行发布前备份。部署回执 SHA-256 `99029a0efd73a790b90879463226f81945d9975ba699ad64edf1cd016d13e6d1`。

完整生产浏览器接受 run `66394c19059c4e78ae6e5daf08f85192` **失败**。前五个既有作品各三模式通过，第六个 sunny-rail 在 compressed 基础播放暂停验证中，暂停点击前出现代码音频补给不足并自动停止；实际 click 发生时按钮已为“播放”，因此重新启动，随后等待暂停超时。该诊断明确排除了自然播放结束（time 3.22027 / duration 36）及暂停后旧异步启动复活。

时间证据：点击请求前 playing=true、renderMs 855.4；约 572 ms 后自动停止；实际 trusted click 时 playing=false，错误为“音频生成未跟上播放，已暂停以保持声音与画面同步，请继续播放”。下一任务恢复播放。需要修复采样乐谱流在重画面下的准备和调度，而不能放宽验收暂停断言。

失败回执 SHA-256 `4467f59a6cec0a039c2ba4efeca6aa38d1ddcc8538ccb5f66ade12fc350aec81`；外层 stdout 报告 SHA-256 `6a72492932c1a92cedfebaef2d887969c2db62c6f92a47881c2074b54b792478`。当前没有活动任务或浏览器 pageerror。QA 作品尚未创建；自有 token、1 个 OAuth client、6 个登录会话已清理，无错误。旧资源清理没有执行；823 执行阶段全部关闭。

后继 8.2.4 处理此问题，8.2.3 已发布/部署的事实与失败生产接受结果分别保留。

823 失败运行的 10 个证据文件（5 张截图、2 份容器报告和外层回执/标准输出/标准错误）已完整留存，共 1,865,161 字节，逐项 source/copy SHA 一致。留存回执 SHA-256 `7b006b6ff8952fb2ab4d25d43682a75a4b376ed647430abcea57786bd8065266`。正式 Release 已明确标注生产接受失败及 8.2.4 修复中，readback 正文 SHA-256 `8e09a94318c8a6af161737556e9fb8813ffe73dc0a66c7b8c6993eaf9cff2cbf`。

切换前生产为 8.2.2。该版失败接受的 5 张截图与 2 份报告已精确留存，7 文件共 1,438,653 字节，source/copy SHA 全匹配；留存收据 SHA-256 `59f0029313ddb575750509473d66b76a28ba866d92e43f6d8cad95b654238c65`。没有旧 Frame 初始化退出容器可清理。

## 未扩大范围的优化

`server/speech.mjs` 的 seedSpeech 对内置配置即使内容不变仍重新加密并 upsert。可单独改为仅配置有差异时写入；本轮未擅自修改，留给用户决定。
