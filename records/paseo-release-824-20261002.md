# FRAME Studio 8.2.4 发布与生产验收

## 不可变身份

- 源码 `31ff0974bfdd11b1e6b6ba496d7fbcf793e8e7cb`；提交 `fix(preview): 完善素材模式面板并修复重画面音频补给`。
- 归档 SHA-256 `0fc37a04fcb685e3f9696cb1e26104fd01b2cd9e15ab5ab92ae39456b9e2d2b3`。
- annotated 标签 `v8.2.4` 对象 `c393ea6f9f46c1967e16a99dcb7d0c9a4d146ee9`，远程 peel 与源码一致，保持不可变。
- [正式 Release](https://github.com/jianjianai/frame-studio/releases/tag/v8.2.4)；tag workflow `36996248602` 和 Release workflow `36996259451` 的五个发布任务全部成功。
- 正式镜像 `ghcr.io/jianjianai/frame-studio/app:8.2.4@sha256:21db32dc80d2e7d301ed1781a5870f8608eff7629a90811745ec4120fd9c5366`。
- 镜像内 792 个源码文件与固定归档逐项一致，源内容指纹 `ad9b9dbefb8c5750e4931f43fb5e5db7665c1a8059436f191bbd5b7820cf4ec7`。runtime fingerprint `4101384a7b98989078c4387694b89d31e447e90a3defff2384c7a8c45ac5dc3e`。

## 本次改进与聚焦证据

8.2.3 的生产验收暴露重画面下采样乐谱流欠载；本次等待实际原生初始队列并自适应补给，保留严格同步保护、分段生成、精确跳转和取消。真实 old-fail/new-pass 及释放、倍率预算、离线样本数证据见 [音频修复记录](soundfont-stream-heavy-frame-824-20261002.md)。

用户通过关联聊天明确要求素材模式进入左侧功能区并在右侧面板显示，本次统一合入。复用同一播放器和权威缓存 client；补充事件握手、旧会话隔离、键盘焦点、窄屏、错误恢复和清理确认。独立预览保留自身控制。实际 Chromium 和截图检查见 [素材面板记录](preview-media-panel-20261002.md)。

此前 Tone/Signalsmith 全公共接口、AI 能力发现、官方 Paseo 完整 WebUI/daemon、三种素材模式及 UI 修复保持；没有改用户作品或曲谱。

## 候选完整检查

候选镜像 `sha256:25e9ddecc5f37b880b3519239903355bce5faa1b60e0d41ccf42458124a3949c`。run `20261002T100953Z-a53b2784`，1255 秒，执行 `pnpm verify:release`。

**793 PASS / 0 FAIL / 3 明确跳过**：176 核心、128 MCP、489 服务端通过。MCP 129 个目标有 1 项允许跳过，服务端 491 个目标有 2 项允许跳过。可选授权素材和非 Linux 原生环境目标保持明确边界，新生成音色库回归实际执行。

- 回执 SHA-256 `49e69ba72d0f333ff6708054b34398987920c7aa1943f144a002c19ec64e5ca5`。
- 日志 392,237 字节，SHA-256 `f287e474ac0460ba3965e1971189cff74c6eb546774afe21009d5efff3fe9757`。
- 新素材控制桥 #298、整页面板 #299、Soundfont 重画面和释放 #339、完整混音导出 #328、实际 Docker 六作品 #184、官方 Paseo 完整 UI 到验证/应用/撤销 #266、V8 三模式离线缓存与热更新 #421–427 全部通过。
- 严格 skip guard、HTTP 镜像身份、源码不变与 Paseo 官方包/四补丁证明通过；自有 probe/pg/runner/smoke 和网络确认不存在，本 run 标签容器为 0，cleanup errors 为空。
- 独立复核 SHA-256 `adb9920ac36a9b18fa5f888f76595b75135afe110faf7d1ff7176517eb9a2b42`。

## 共享模型准备

候选 warm run `20261002T103309Z-7bca26b0` 实际通过，三个共享模型就绪，内层准备 1416 ms。两个源下载归档共 802,093,919 字节，前后 SHA 保持一致。没有重复模型下载。

current/permanent 回执逐字节相同，3603 字节，SHA-256 `fafd22107b9c4766346ff3c0545dba46d1b90e213d94b7a30ea42cbf4f549c15`；日志 1152 字节，SHA-256 `b2c94df605251fa877ee53b626da87e23b15d339bc0be8d761d183ac17aaf192`。自有容器、标签和临时脚本目录均确认清理，warm 阶段已关闭。此项不是正式镜像原生推理证据。

## 实际发布制品验证

publication run `20261002T103831Z-797abcd52e` 通过。正式镜像已实际 pull 并核对 revision/digest，安装包实际下载、校验和 PE 格式检查通过：

- `FrameStudio-v8.2.4-win-x64-Setup.exe`：16,265,614 字节，SHA-256 `6f52afce91d667b6cddfd53dd91faf99072657890da5a2b384138a8f75086b44`。
- `.exe.sha256`：104 字节，SHA-256 `efb7693a1d681be4ca97ad4dcd79b2c322aa8ba9811f75d56913ecd734b44d5e`。

没有声称完成 Windows 原生安装运行。发布后临时说明明确区分已发布与待验收，正文 readback SHA-256 `5df0108615dd9787d1fb1955d5dd2d333b875892163552bd11c0fed07e77187b`。

## 后续状态

正式镜像完整检查 run `20261002T103934Z-ed1b9781` 已通过，1305 秒，同样 **793 PASS / 0 FAIL / 3 明确跳过**。回执 SHA-256 `5a22cb7285dc8323a8b0df8174be0eb3ecd027a41c308a59437e635e861d7d95`；日志 391,382 字节，SHA-256 `b9e6c0c78058fa546b4881684735f4898510c821ecc9653392107997d5b10162`。正式镜像、源归档、HTTP 身份、新音频/素材面板及严格 skip 检查均通过；自有容器和网络清理记录无错误。

正式完整检查独立复核 SHA-256 `1955ada273fe9c054e280f9388bb1caaeb8ffd3feeae7b73f7eed11e72d04e53`；精确自有 probe/PG/runner/smoke/network 实际均不存在，owner 标签容器为 0。

正式原生语音 run `20261002T110254Z-404561b9` 通过：TTS 输出 24kHz PCM，118,232 字节、2.46317 秒，peak 14,158、RMS 0.06149、非零 52,019，全部 finite。STT 在 517ms 内正确识别同段音频为 “Hello, this is a short speech test.”。Worker 原 PID 消失、正常 SIGTERM、stdio/IPC/handle 关闭，无后代、孤儿或新 client Worker，十项资源检查通过；`closeEventObserved=false` 如实保留，forced=false。付费 API 和模型下载为 0。两个源归档前后校验保持一致，自有容器、标签和脚本目录确认清理，warm/native 阶段均已关闭。

current/permanent 原生回执逐字节一致，14,702 字节，SHA-256 `0b8a4f02b6b9e356c65aff1c9e8067720c2bcca42637d49b46a841a1d530a226`；日志 7939 字节，SHA-256 `da194100ba59c1d8d7a2d62768ebbbbb3abd944815e8ce4c386ce2d30701e922`。没有声称物理麦克风、Windows 原生推理或可选 Parakeet v3 实际识别已验证。

首轮生产切换 `deploy-20261002T110505Z-3035592` 被活动任务检查正常阻止，未执行服务切换：作品 `work-8d43897b` 的渲染任务 `c055c463-9c7d-4a5f-aa20-eb0bbbd5ddaf` 当时正在运行。保留失败日志，没有中断用户任务；该任务于 `2026-10-02T11:08:14.586089+00:00` 自行成功完成。只读核对 active task 为 0 后，使用原封不动的正式镜像和部署 helper 重试。

第二轮切换 `20261002T111520Z-3049809` 在切换后保留性检查失败：唯一非派生变化为 `work-8d43897b` 的 status（draft→finished）、description、updated（11:15:58.666Z）和源码 SHA（4281a7…→1c480c…）；资产文件、资产主表和 blob tree 未变，但引用记录从 78→77，需查明来源。脚本已自动回滚并验证恢复 8.2.3 / `61719e3` / `sha256:96277b10…`；没有放宽检查。只读调查确认外部制作在 render 成功后仍继续交付收尾：该作品在 `11:17:04Z` 新增提交 `3a32ab7f048cba50f8fd7cea31b389ea19417148`，改动仅制作交付清单和审查记录；资产引用变化仅该作品的 poster.svg，实际 blob 未删除。保留完整失败记录，等待外部写入稳定后才允许重试。回滚回执已按 run 单独保留，SHA-256 `e0f2312d19559a1070f9c52500fa9c6518c96f2dd87253afc9bd05c24e0086f7`。完整生产浏览器验收和精确旧资源清理尚待完成；失败历史见 [8.2.3 记录](paseo-release-823-20261002.md)。

## 生产切换完成

外部制作收尾完成后，11:21:46.104Z 与 11:23:07.326Z 两次快照间隔 81.222 秒，作品源码、元数据、Git HEAD 和审计摘要保持一致，活动任务/Paseo 均为 0。只读调查 SHA-256 `65a66c19ba4355314b8d4efe6614ef50d87a5745d006a94b00b12dbfd01088c6`。海报引用是源文件更新后残留的旧引用，扫描清理引用没有删除 blob。

第三轮 run `20261002T112338Z-3063549` 沿用原 helper 和全部保留检查，通过并实际部署 8.2.4 / `31ff097` / 正式 digest `21db32dc…`，部署内层 82 秒。healthz 返回精确版本和源码，studio/controller 健康，readyz 200。前后完整作品源码、资产、blob 和凭据保留；仅改 FRAME_VERSION。speech/Postgres/两个开发容器的 ID、启动时间和镜像均保持不变；未执行备份。

部署独立复核 SHA-256 `5219956ceebb6cae4542100f4727daf422172e6a459ef5fc9d0ae036107a788b`：24 个作品完整内容、94 项资产、94 个仓库关系、77 条引用与 88 个 blob 保留，仅允许的派生索引刷新；线上镜像和四个无关服务身份再次核对一致。

首轮 8.2.4 生产浏览器 run `d7ed8db6cb6c4bdcad54dc5a67b28e71` 失败：前三个作品各三模式通过，打开第四个 tiny-seed 的公网页面时 `page.goto` 遇到 `net::ERR_CONNECTION_CLOSED`，尚未执行该作品功能断言。没有浏览器 pageerror，活动任务为空，QA 作品尚未创建；自有 token、1 个 OAuth client 和 6 个会话清理通过。10 个失败证据共 1,087,991 字节逐项源/副本 SHA 相同并留存，retention SHA-256 `1c8f0e88cb92e176a76363bbea4e0710de76552a60c50b9c7ec10807e5271e34`。独立核查确认原应用和代理均未重启或崩溃，没有同时间 5xx；公网入口及 health/ready 200。无法唯一归因客户端、HTTP/3 或网络层，保持首轮 FAILED；review SHA-256 `450fff92a0d183c1a6ec54036258626879182dad77d420243a491b7f65235f94`。随后按相同 helper、全部原断言再次运行完整验收，结果见下一节。旧资源清理尚未执行。

## 第二轮完整生产验收

run `8be188886473485abe768755d80d93b7` 内层 501 秒，最终 **FAILED**：7 个现有作品各三模式全部通过，包含原有重画面 sunny-rail 与新完成的 work-8d43897b；全部 cached 模式校验原始清单、持久文件数量并实际阻断资源网络后播放/定位。新建 QA 的真实 PNG（5906 字节）与 MP4（7552 字节）导出任务成功，使用正式 `31ff097/21db` 镜像。

随后 Paseo 实测 session API 返回 200，但 AI 面板显示范围无效，iframe 数量为 0，等待 180 秒后失败，与人工截图和固定 localhost 的代码根因一致。后续 QA 的三种创作音频模式、自动热缓存更新及最终完整数据保留 wrapper 尚未执行，不能称完整接受通过。

自有 QA 作品 1、token、OAuth client 1 和会话 6 已清理；自有 Paseo native 停止且容器移除，activeTasks 与 browserErrors 均为空。全部 824 执行阶段已关闭。17 个失败证据共 2,791,298 字节逐项源/副本 SHA 相同并保留；retention SHA-256 `aba424c2bb3acf7cb98c9c2cc7fded6899b04c10bb5a1290ee8a76e3a74f519d`。独立复核 SHA-256 `fdd4d0fdbd6b66456833a77c91defda6003be262ed813175da5b8d08a3836494`。

## 后继修复：Paseo 缺省公网访问源

人工复查首轮生产截图发现右侧 Paseo 显示“返回的作品连接范围无效”。只读核对生产没有 FRAME_PUBLIC_URL，createApp 使用 localhost 缺省值，网关将其固定写入 bootstrap.parentOrigin，与浏览器真实 HTTPS 访问源不一致。该问题独立于前述连接瞬断，属于需要修复的产品默认行为。8.2.5 将按实际请求推导嵌入访问源，覆盖本机 HTTP、代理 HTTPS、别名、端口与 IPv6，保留 workId/nonce/iframe 约束，不引入额外域名配置要求。

8.2.4 Release 已如实补充已部署、完整接受未通过和后继修复状态；正文 SHA-256 `2ceb5709e67b7f093da8b22c1c3cce4560f0f8da5affe25bc11e80621f242759`。标签/源码/制品均保持不可变。

## 本轮没有擅自扩大的优化

- `server/speech.mjs` 的 seedSpeech 在内置配置未变时仍加密/upsert，可另行优化为仅差异写入。
- 既有 ScoreStream 历史 PCM/Worker 跳转缓存仍保留已生成内容；本次只约束未来队列预算，没有擅自加入会改变随机跳转代价的历史缓存淘汰策略。
