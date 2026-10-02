# Paseo、音频与预览 8.2.2 发布及生产验收记录

## 不可变发布身份

- 源码：`58559978db60f1cbb0934bc2f957fbe760a926f6`，版本 `8.2.2`。
- 源码归档 SHA-256：`f96504108a3c6821950b3a8728135e827b7c2e2b2b465a7025602f1567812d1d`。
- annotated 标签 `v8.2.2` 对象 `8c7b57a4fe196f1193bcb75c052183f09e0d67f5`，指向上述源码，保持不可变。
- [GitHub Release](https://github.com/jianjianai/frame-studio/releases/tag/v8.2.2) 已发布；tag workflow `36971430616` 与 release workflow `36971435076` 成功。
- 正式镜像：`ghcr.io/jianjianai/frame-studio/app:8.2.2@sha256:286ab368d7aa0bb0ca7bf0eb8496abf9f95efdb4e65d7b896b7f6cb5888874f5`。
- Windows Setup 16,237,000 字节，SHA-256 `28cdddf1f877edbc4e5879f4977ae2bb90ee8fb58c91017a4d56855bc01b1f2a`；已验证发布下载、校验值和 PE 格式，未声称完成 Windows 原生安装运行。

## 候选与正式镜像完整门禁

候选镜像 `sha256:5579f70b9d566b7f1dca4352b82eb1168c1b482afb9bd1c940accc787fdd4129` 和正式镜像分别执行完整门禁，均为 **777 PASS、0 FAIL、3 项明确允许的 skip**：176 单元、128 MCP、473 服务端通过。包含真实 Docker 六作品 Paseo、浏览器音频和缓存目标，不以旧缓存代替本次结果。

| 证据 | Run | 日志 SHA-256 |
| --- | --- | --- |
| 候选门禁 | `20261002T053830Z-727cad6b` | `80ceccd9d749685858e8ca8a46a721974ea9db9425892293e3ee152956381322` |
| 正式镜像门禁 | `20261002T061708Z-fb7ce03c` | `44467cfa123e1230f7344d646f46a7c9c6ca967e4a72577d0a9d1b92d86ed00d` |

正式门禁回执 SHA-256：`d3d433ee1256839cece09776f8f24ccdcc3c25c09070d134c6dad82b0125a8c5`。实际 runtime、Paseo 固定源码与四个补丁、官方 WebUI bundle 身份一致；临时数据库、容器、网络清理无错误。更早候选失败和被后继候选替代的证据仍保留。

UI 范围与修复见 [音频与预览 UI 审查](audio-preview-ui-review-20261002.md)，共享模型设计见 [Paseo 共享语音模型](paseo-shared-speech-models-20261002.md)。

## 真实共享模型与原生语音

共享模型准备实际通过，Parakeet v2、Kokoro 和可选 Parakeet v3 三个目录 ready。暖机 run `20261002T060011Z-547310ec`，回执 SHA-256 `d108a0eb8b51d0bcf905aad20b052bdcf9bb9f086a58a21e2d846cc95615debe`。默认两个原始下载归档保留，尚未进行旧作品重复归档清理。

正式镜像的无网络、只读模型原生推理 run `20261002T072533Z-c8a809ce` 通过：

- Kokoro 输出 24 kHz 单声道 PCM16，118,174 字节、约 2.462 秒，finite PCM、52,055 个非零采样。
- Parakeet v2 在 438 ms 内识别为 “Hello, this is a short speech test.”。
- worker 正常 SIGTERM 退出；原 PID 身份消失、无后代或孤儿、IPC/全部管道关闭、client worker 清空，十项资源释放检查全部通过。无强制 SIGKILL。
- 回执 SHA-256 `df8ce10d1b21ff4a2cec7f6294e1a70ea7cc38a5447112c01e7adc14524fd059`；日志 SHA-256 `d03dc9ffc7bca079feadacd6a94f9f0cbad1a98cb2371525fc30137a0f93171a`；自有容器和脚本副本已清理。

前期私有探针错误地依赖 Node fork 的 `close` 事件；官方 shutdown 先 disconnect 再 kill 后，实际进程和资源已释放但该事件未发出。独立无模型复现后改为上述真实资源检查，保留 `closeEventObserved=false`；外层包装器也修正了新增字段导致精确字典比较误拒的问题。22 项释放夹具、47 项外层检查通过。公共源码和镜像未因私有探针修正而变化。旧失败回执完整保留。

本项没有发送付费模型对话、使用物理麦克风，也没有运行可选 Parakeet v3 的实际识别。

## 已部署，完整生产接受未通过

生产切换 run `20261002T072856Z-2446010` 成功，由 8.2.1 切换到上述 8.2.2 正式镜像：

- 切换前重新确认任务、原生 Agent 活动和候选均为空；仅更新 studio/controller。
- health 显示版本 8.2.2 与精确 revision，readyz 200。
- 作品源码、素材、关系和 blob 核对通过，凭据保留；speech、PostgreSQL、两个开发服务的容器 ID、镜像和启动时间未变。
- 未执行发布前备份。部署回执 SHA-256：`efa8bf46b0e9ab825d32d2341bb7e3282d8f9b1fcb8b7314caa10b7daa61678f`。

真实生产浏览器接受 run `8de126cf3f0d4d3a8c951b9a195273bb` **失败**。前五个作品的 original/cached/compressed、跳转和播放暂停均通过；第六个 sunny-rail 在首次播放后第二次点击，等待 playing=false 超过 30 秒。失败发生在该作品进入三模式循环前，不能把前一作品留下的 currentMode 当作失败模式。

该轮尚未创建临时作品；自有 token、一个 OAuth client、六个登录会话均已清理，无清理错误。失败状态回执已独立保留，SHA-256 `71e13a61303763faf1adc1aa565ea29a656478ccfd664ab27886f821b11f616e`。生产旧镜像和垃圾清理未开启。

窄范围 sunny-rail 三次真实播放暂停均通过，实际第二次点击在约 8.3–8.9 秒且按钮为“暂停”。该作品时长 36 秒、单帧渲染较重；原完整接受的超时根因仍未确定，不能以窄范围通过抹去失败。私有接受脚本增加有上限的点击瞬间及状态诊断，保留原断言、超时与暂停时钟门槛。

## 独立确认的待修复产品问题

对 8.2.2 真实 Player、session、Transport、Renderer 源码的隔离浏览器测试，使用可控制的异步画面准备，确认两个入口均可复现：

1. API play 等待画面时调用 pause，返回停止状态；画面准备完成后，旧请求再次启动播放。
2. UI 首次点击显示“暂停”但仍在准备画面，此时第二次点击未取消旧请求；准备完成后仍开始播放。

底层 AudioTransport 的代次取消正常；缺口位于上层等待画面后才发起新的 play。独立诊断日志 SHA-256 `5cbc2986b60892fad4f644a6e9ea55a9df7ffc7d12c01cd7a2693facf6e30674`。这证明需要修复异步播放意图，**不等同于已证明 sunny-rail 原超时的根因**。

后继版本 8.2.3 统一播放器会话的播放意图取消，并重新执行所需门禁、发布、部署及生产接受。8.2.2 标签、镜像和本记录中的历史证据保持不变。
