# FRAME Studio 8.2.5 发布与生产验收

## 最终状态（2026-10-02）

**已发布、已上线、完整生产验收通过、清理完成。** 以下各阶段按发生顺序保留，早期的待完成及失败描述是历史记录，以此最终状态为准。

- 发布标签 `v8.2.5` 固定代码 `84bd7456c23b5c4a7640cf3fc78e0b62db520c7e`；生产 Studio/Controller 运行正式镜像 `sha256:79409bd52f19be959616f548428c1d545f5cf184186a02b5e2592962a5dafcc4`。
- 候选与正式镜像完整检查均为 **802 PASS / 0 FAIL / 3 明确跳过**。正式原生 TTS/STT 通过；生产 7 个现有作品 × 3 模式、Paseo 连接、混音样例导出、断资源网络缓存播放及自动更新均通过。
- 清理 8 个旧构建目录、10 个精确旧镜像、12 个重复语音压缩包（4.81 GB），以及两个本轮失败验收临时输出目录。共享模型、源压缩包、作品、数据库、卷、失败证据和保留的回滚镜像未删除。
- 未做发布前备份，只更新 Studio/Controller；最终六个受保护服务身份未变，公网与容器内 healthz/readyz 均 200。全部阶段/清理授权已关闭。
- 本轮未做 Windows 原生安装运行、物理麦克风测试或生产付费模型回合；完整缓存不保证消除设备计算与渲染瓶颈。

[发布页面](https://github.com/jianjianai/frame-studio/releases/tag/v8.2.5) · [生产站点](https://frame.nerviloom.com)

## 固定源码与改进

源码 `84bd7456c23b5c4a7640cf3fc78e0b62db520c7e`，提交 `fix(paseo): 按实际访问源连接作品并支持反向代理别名`，已推送 main。源归档 SHA-256 `1925cfddcfd14f3702118fd0d8057dcec9de47b5081fbcc647f46152c18925ff`。

本版修复 8.2.4 真实生产验收确认的 Paseo localhost 缺省地址问题：两个 bootstrap 入口共享实际请求地址推导，覆盖本机 HTTP、代理 HTTPS、不同访问别名、端口和 IPv6；移除失效的 origin 参数。无需增加域名或 TLS 配置，作品和消息 nonce/iframe 约束保持。真实 old-fail、11/11 聚焦检查、类型检查和独立审查见 [修复记录](paseo-origin-825-20261002.md)。

Tone/Signalsmith、三种预览资源模式、父页面素材面板、异步播放取消与重画面采样补给均保留；8.2.4 的 7 个实际作品三模式/导出成功和 Paseo 失败分别保留，见 [8.2.4 历史记录](paseo-release-824-20261002.md)。

## 本轮发布准备

19 份私有 helper 仅变更版本、私有路径和 run/database 身份，不复制任何旧门禁或生产回执充作本版结果。生产验收的 76 个原静态断言、超时与重试语义全部保持；10 个精确旧镜像身份、保护项和 8 个历史目录边界不变。源转换复核 SHA-256 `25d026deb38b4d1c07984e67a9f94671cd91858cc1529914b318932642a995dc`，根逐文件校验 SHA-256 `7c8c6957a802b47e960639fa40a3caf83fffccbbedebc13679a4318b6df34b27`。

生产前态于 `2026-10-02T11:45:25.767904+00:00` 实测为 8.2.4 / `31ff097` / `sha256:21db32dc…`，studio/controller healthy，公网 healthz 200；不是将历史值冒充新查询。

候选构建完成：镜像 `sha256:a167b94a6af5a8761bc61a738c85e5e8314721e83168c5e80ccd79709dcca84f`，内部构建 60 秒；镜像内 794 个源码文件与固定归档逐项匹配，源指纹 `3c1e680324c51304893696ff04ca8e322a859460af0326acedcc86763f1d68ea`，runtime fingerprint `780ba5184872e9fcfea5c239fd2a8eda356230bb8111dc7dfee2b0b73bfa5119`。官方 Paseo 0.10.2 源码/四补丁/完整包证明保持一致。

候选完整检查 run `20261002T115707Z-9ebae165` 通过，1270 秒：**802 PASS / 0 FAIL / 3 明确跳过**，其中核心 176、MCP 128、服务端 498 通过。MCP 共 129 个目标、服务端共 500 个目标，跳过保持原允许的可选素材/平台范围。完整官方 Paseo 原生工作流、新 HTTP/HTTPS alias 嵌入回归、实际 Docker 冷启动、原音频与缓存目标全部通过；strict skip、HTTP 镜像身份、源内容不变与自有资源清理检查通过。

回执 SHA-256 `c855cab2c0629d77ad12898ecf9bd3dea6e4c7fb3b32a676a51e5c206259e3b5`；日志 393,750 字节，SHA-256 `b67ddfae27e3c1bc75e10bb5eff543e444c50de9fbec462c47ab355dc8f551cb`。

正式发布、原生语音、生产切换与清理待实际完成后补充。本版未创建发布前备份。

## 发布与共享模型准备

候选独立复核 SHA-256 `bdf150c52bb238c1a2031a4e3fdf5b6a2d600657b1eed58392998c92dd911dba`；四个自有命名 probe/pg/runner/smoke 容器与网络确认不存在，全部本 run owner 标签容器为 0。

annotated 标签 `v8.2.5` 对象 `eddc9de3bcda8c370e5e923f317e4c65c24efff9`，peel 精确 `84bd7456c23b5c4a7640cf3fc78e0b62db520c7e`。自动 tag workflow `37006088855` 成功，自动触发 Release `37006099341`，没有重复手工 dispatch。

warm-only run `20261002T122006Z-8e4a29f0` 实际通过。3 个模型 ready，内层检查 151ms；两个原始源归档共 802,093,919 字节前后 SHA 保持一致，没有重复模型下载。current/permanent 回执逐字节相同，3603 字节，SHA-256 `8396cf07ad52ac440f9e40777eb8fd8f7571a17a7ed8a72eff0bb28469a378d2`；日志 1151 字节，SHA-256 `ea24a431fd663f4b18fac741bff9128b7eb01ff5a34daf9244b9f3bd0dfe3a8d`。

自有容器、owner 标签和脚本目录确认清理，无 cleanup errors；warm 已关闭、native 保持关闭等待正式门禁。本项不是本版正式原生推理证据。

## 实际发布制品

Release workflow `37006099341` 的 source、Windows、app image、speech image、publish 五个任务全部成功。正式 [v8.2.5 Release](https://github.com/jianjianai/frame-studio/releases/tag/v8.2.5) 已发布。

publication run `20261002T122552Z-26a02907a0` 实际通过，正式应用镜像 `ghcr.io/jianjianai/frame-studio/app:8.2.5@sha256:79409bd52f19be959616f548428c1d545f5cf184186a02b5e2592962a5dafcc4` 已 pull 并核对精确源码。

- Windows Setup 实际下载 16,274,103 字节，SHA-256 `0a6d72f9e11a9944fe92dfa2e64a3d2fd51e79a8c835b6a50ff9d5a6f2225e84`。
- 校验和文件 104 字节，SHA-256 `7ce26317cc7b29d370f88a39b5a3f483e65f919b21cb5544ab87f7cc909aef02`。
- PE 格式及发布校验和验证通过；不是 Windows 原生安装运行证明。

发布正文明确标明正式检查与生产验收待完成，readback SHA-256 `c521ed473d66dfeb5d71476ab6c5e573face32f6ef400a93b35eab4b8d392256`。正式镜像完整检查已经启动，生产仍为 8.2.4，旧资源清理尚未执行。

## 生产视觉证据补充

私有生产验收仅增加在 Paseo 原 composer/配置/作用域/请求和 WebSocket 断言全部通过后保存 `qa-paseo.png`，并将该文件加入原最终 artifacts 复制名单。完整原断言、超时、重试及失败/自有资源清理逻辑逐字节保持；没有启动额外会话或修改公共源码。两份原文及精确差异已保存，Node24 单文件和实际拼接脚本语法、Python AST 均通过。

差异 SHA-256 `59647eb1a8b82350c73cd3199ece29180acc4938221691595f1aa40629543fba`；补充审查 SHA-256 `55b82ef22b5d1f73ea1796bee87e229c23d9d042757e9b58894bd4247af35f99`。独立复核 SHA-256 `e625418ba5d78f7eb0785f8759a76da68adb7fd8eeb2eaecb303ec92cb62591e`；精确逆转两处新增后与 before 原文逐字节相等。此时尚未执行生产验收，截图将在实际运行中生成。

## 正式镜像完整门禁

正式镜像完整 `pnpm verify:release` run `20261002T122727Z-817f2eb6` 实际 exit 0，内层 1254 秒。**802 PASS / 0 FAIL / 3 明确跳过**：核心 176，MCP 128/1 skip，server 498/2 skip；cancelled/todo 均 0。跳过是可选 sampled preview 夹具、Windows 本机无 Docker 模式、GeneralUser 音色库夹具；不把它们计作本轮已验证。

正式 gate 回执 SHA-256 `56d64f8e2a4bd4f54d8f8164867a8068b3e8095c4e94fc9c4df4e79744d23228`。实际日志 393,449 字节，SHA-256 `cd776153077db56e9de914bfe6e4ea63980851611bbecf6991accbd07eaa21a3`；源 794 文件、runtime、官方 Paseo 完整包、真实 HTTP 镜像身份与 strict skip 守卫均通过。

原生完整 Paseo 回合/验证应用、代理 origin/alias、Docker 冷启动、音频实际导出、SF2 850ms 重帧、素材面板、三模式断网/热更新/弱网和导出冻结检查全部实际通过。独立复核 SHA-256 `b9d18ae3d6108b2c349ad91bdc170eacaca3505698661fa98d459e82426be432`；四个自有命名实验容器、网络以及本 run 全部 owner 容器确认不存在，cleanup errors 为空。

正式门禁阶段已关闭。后续原生语音、生产切换、浏览器验收和旧残留清理按新回执继续。

## 正式原生语音

正式 native run `20261002T125000Z-c4c50175` 实际通过并 exit 0。current 与永久回执完全相同，14,692 字节，SHA-256 `249e5aed77fd8db7e4658f22275844d3da11d3101cb1243da5ba4f671f1948ed`；日志 7,929 字节，SHA-256 `bba76ea431ad075b7293712d35b59890a111f997c1a3d3e18d6e1ceecbc4d1c1`。

实际 TTS 输出 24kHz、118,014 字节、2.458625 秒 PCM，peak 14495、RMS 0.06161、51,937 个非零样本且数值有限；STT 使用同一 PCM，430ms 正确返回 `Hello, this is a short speech test.`。Worker 原 PID/start identity 已消失，正常 SIGTERM、stdio/IPC/handle 关闭、无后代/孤儿/新增 client worker，10 项检查全部通过；没有强杀，closeEventObserved=false 如实保留，不将事件未观测写作观测到。

本次付费 API 调用和模型下载均为 0；不是物理麦克风测试。两个源归档 SHA 与 warm 前后保持一致，共 802,093,919 字节。自有容器、owner 标签、临时脚本目录全部确认不存在，cleanup errors 为空。warm/native 均已关闭，最终 speech authorization SHA-256 `95219ca517187fb6785adfcf5aecd75beb91e2ec3f9fc58ce5cb8592f2ca354d`。

## 生产切换

正式部署 run `20261002T125249Z-3308289` 实际 exit 0，81 秒完成；部署回执 SHA-256 `a5fe687002c28168c5aa557cf7583c8e4a522bf87c6320089569e3d83bb7228b`。切换前 tasks/native/candidates 全部为空，旧版为 8.2.4 / `31ff097` / `sha256:21db32dc…`。

只切换 studio/controller；两容器实际镜像为正式 gate 通过的 `sha256:79409bd52f19be959616f548428c1d545f5cf184186a02b5e2592962a5dafcc4`，healthy，healthz 返回 8.2.5 / `84bd745`，readyz 200。核心及 Paseo 迁移清单兼容；只修改 FRAME_VERSION，凭据保持。作品源码、素材和完整 blob 树前后验证保留，语音、生产数据库、开发容器和开发数据库共四个无关容器的 ID、镜像和 StartedAt 未变。

未执行发布前备份，未重启无关服务。此部署成功不替代随后真实公网浏览器全量验收。

## 第一轮生产浏览器验收：Paseo 新会话入口未完成

run `6769d7bbc5024202bdf60effb35c4398`，日志标签 `production-acceptance-20261002T125516Z-6769d7bbc5024202bdf60effb35c4398`，内层 376 秒后失败，外层进程 exit 1。全部 7 个现有作品 × 3 种模式、原始缓存清单、断资源网络播放/跳转及临时样例 PNG/MP4 已通过；不能因此宣布完整验收通过。

Paseo 原始地址问题已不再出现：iframe 数量 1、session HTTP 200、panelErrors 为空；bootstrap、作品配置及原生状态断言通过。新的失败在 probe 的 composer 即时 count 为 0 后，寻找 `workspace-new-tab-button` 超时 30 秒。尚未执行随后的 creativeAudioModes 三模式和 hotCachedRevision，外层最终完整 preservation 也未执行。

真实 existing-paper-wings 截图已呈现官方 frame-draft 工作区、New tab 与 Agent/Terminal/Diff 等入口，没有旧 scope 错误。保留证据后核对响应式入口及探针假设，不放宽原成功条件或超时。

清理回执：临时作品 1、token、OAuth client 1、session 6 均成功清理；临时 Paseo stopped/containerCleared，activeTasks 与 unexpectedBrowserErrors 均为空。所有失败原文与容器输出复制后逐项校验 SHA，20 文件共 2,822,036 字节；保留清单 SHA-256 `46d8d7894bbb25d7d74ea57f6c651021af8aaf20c6902edc0fc41af2aa41e7c3`。原始自有容器输出仍保留。accept 阶段已关闭，旧残留清理尚未执行。

独立失败复核 SHA-256 `ceb7b5f9735c493933ba56988eea8e931eb67fcffb20c5fe4ee1167072958d04`。官方固定源码确认：`packages/app/src/panels/new-tab-panel.tsx:90–105` 的新会话 launcher testID 为 `workspace-new-tab-agent`；`workspace-new-tab-button` 仅存在桌面标签栏。`WorkspaceScreen` 按 `useIsCompactFormFactor` 在小于 720px 时使用 MobileWorkspaceTabSwitcher。实际 FRAME 右侧 iframe 约 440px，故桌面按钮不存在。launcher 仅切换本地 draft target，不创建 agent 或发送模型 turn。

因此修复范围是私有验收入口；公共产品源码及正式镜像不变。原 scope HTTP/WS 循环、composer 输入清空与就绪截图均位于第一轮错误后方，尚未执行。

私有入口修正已冻结并独立审查通过：在原 30 秒整体期限内等待可见 composer 或 `workspace-new-tab-agent`，必要时真实点击 launcher，并继续原 120 秒 composer/填入清空、bootstrap/config、HTTP/WS、就绪截图和全部后续验收。精确逆向替换该单一 block 后，其他内容与 before 逐字节一致；Node24 单文件和 wrapper 实际拼接语法均通过。未改产品源码、wrapper、成功条件或超时，未发送模型回合。

新 probe SHA-256 `8af5dedaee7ccfe0068af47363a2f9e92e910ad0f675071444ef7b0205e83ba7`；diff SHA-256 `232047946bab3d2a8e0885ffd100bdbec78ab0995d0fc1292e6cf2a6bde8465c`；根因固定源码证明 `3ebf97a2290acf29f52da547af459488345c6198857375ee60dd0de62d6b8d17`；peer 审查 `8e6096f86a0d2506babe6d01bfec4df4f5decb00c21055c77f2688b82c6a497c`。基于明确修正重新运行原完整验收，第一轮失败保留。

## 第二轮生产浏览器验收：功能通过，访问时间元数据核对阻止收尾

run `92b7e54632eb451e99c80dac80ab25bb`，日志标签 `production-acceptance-20261002T131020Z-92b7e54632eb451e99c80dac80ab25bb`，内层功能 report 为 passed，但外层最终 inventory 比较抛出 `Production work content changed: opened,sync_state`，整体 exit 1，372 秒。不把内层成功冒充外层验收完成。

7 个现有作品 × 3 模式、PNG/MP4、官方 Paseo 就绪与输入清空、配置/作品范围/3 个 HTTP 请求及 1 个 WebSocket 校验全部通过，无外部资源或提供商密钥暴露，没有发送模型回合。新样例原始/完整缓存/压缩三模式通过，完整缓存 52 文件 / 6,348,531 字节且持久文件数一致；源码和图片自动由 revision 1 更新到 2，更新后阻断资源网络仍播放。临时作品/token/OAuth/session/native 自有清理全部通过，activeTasks 和 unexpectedBrowserErrors 为空。

前后唯一非索引差异来自实际查看的 7 个作品：`opened` 最近打开时间与 `sync_state.checked` Git 状态检查时间向前更新。原 Git 分支、remote、ahead/behind、dirty、work 子状态等其余值未变。需独立核实所有作品源码、资产关系和 blob 后，只在验收语义上验证这些正常访问元数据；不修改生产数据或通用部署比较来凑过结果。

本轮全部原文和容器输出保留为 22 文件、3,516,132 字节，源与复制 SHA 逐项匹配；清单 SHA-256 `145cebfc00a1ab01104c28ea8178e07c75a5943e98820e5c604e5dc717412e14`。root 实际查看 `qa-paseo.png`，官方 New Agent 与输入框在窄面板正常显示；`qa-cache-updated.png` 呈现素材模式右侧面板、52/52 文件、100% 与 revision 2，新图形/代码正确，布局无观察到的遮挡。

验收专用元数据核验已冻结：调用链是 `studio/creation.jsx:61` → `works_open` → `server/workbench.mjs:102` 更新 opened；页面挂载/聚焦的 fetch sync status 更新 Git checked。仅本轮实际验收且未删除的作品允许 opened 和 sync_state.checked 单调更新，并限制在本轮开始/结束时间内（明确 5 秒时钟容差）。sync_state 的类型、全部其他键和值保持精确一致。深拷贝中只规范化已验证的两时间戳后，继续使用未修改的原部署比较；原库存保存真实值，allWorkFieldsIdentical 如实为 false，usageMetadataUpdates 列出变化。

49 个纯函数正反例（含真实捕获库存与未访问、已删除、倒退、越窗、其它 Git 状态、源码/素材/blob 改变等拒绝）和 Python AST 全部通过；独立 peer 对冻结字节审查 READY。原 `deploy.py` SHA 仍为 `befde96abad75c6832c5ca8cf849eb68b8d0579d0bb26f1149967c9de2cb24e9`，没有修改生产数据。新 wrapper SHA-256 `450840ccf97bd8713d6b1329b3b02821eb32165d774035b50b3142d68004f23b`；review `4e296f480ace03af11cd36be7f479923da9e572dcba57ff6839ddb6d6d3c1918`；fixture log `fc6b3ad69ae30972f87eb50bf74043ad611bf5bcddf0eadb90f364360cde6d55`。两次旧失败回执保持原样，使用新 wrapper 再运行完整验收。

## 最终生产浏览器验收通过

使用冻结的修正后原完整 wrapper，run `27268422c6f64ceea7ab8d906d320c3a` 实际整体 exit 0，372 秒，9 项完整检查全部通过。最终回执 SHA-256 `7a227a384b5d150428169331ded7eeaca465c1c329279cd937a3a471fff00139`，精确正式 8.2.5 / `84bd745` / `sha256:79409bd5…`。

- 全部 7 个现有作品三种模式：准备、跳转、播放/暂停、原始缓存清单与阻断资源网络播放通过。
- 官方 Paseo 窄面板真实打开 New Agent、输入后清空，bootstrap/配置/作品工作区和 HTTP/WebSocket 范围正确；不发送模型回合，不暴露 provider secrets。
- 临时作品的 Sampler、Tone 乐谱/Timeline、Signalsmith 和移调文件混音，三种预览模式及实际 PNG/MP4 导出通过；导出实际解码与有效 PCM 检查通过。
- 完整缓存 52 文件 / 6,348,531 字节，持久文件数一致；代码和图片从 revision 1 自动更新为 2，更新后阻断资源网络仍播放。
- 临时作品 1、token、OAuth client 1、session 6、临时原生 daemon 和本 run 容器输出目录全部清理；activeTasks、unexpectedBrowserErrors、cleanup errors 均为空。
- 24 个原作品内容和源码、94 素材、94 素材库关系、77 引用及 88 个 blob 完整保留。24 项派生索引与 7 项访问时间元数据变化分别列明，allWorkFieldsIdentical=false，不冒称全部 SQL 字节未变。

12 份截图与 PNG/MP4 产物逐份复制并记录 SHA。root 实际查看本 run 的 `qa-paseo.png`（SHA `991364a9c1486c4ebc7b53a3407ee51ceb0124a744ee7d6504f945647e6cddb4`）与 `qa-cache-updated.png`（SHA `942043f16f398c436408771b519b0b7a35a0da1ca408ecb9c3fda5175327570d`）：Paseo 输入区、左侧素材模式入口、右侧三选项、52/52 文件与 100% 进度及版本 2 均实际可见，布局正常。

## 独立复核与范围外优化

最终生产验收独立回执 `final-accept-review-27268422c6f64ceea7ab8d906d320c3a.json` SHA-256 `216edb2694b4b43e8ef9f905bd7e2e8c13746c181c93474d888f0f3050ab32fb`：所有 12 份产物共 2,273,508 字节，实际文件/大小/SHA 精确相符；inner stdout 与 final.report 相同；原库存与内容约束均成立。7 个既有作品做三模式预览，实际导出的是专门音频 QA，未冒称旧作品逐个导出。

按用户要求另行记录两项既有优化机会，本次不扩大实现范围：

1. `server/speech.mjs:34–48` 的 seedSpeech 在已有配置未变时仍 encrypt/upsert；可按解密后的配置及内置字段差异决定是否写入，减少重复加密和数据库写入。
2. `src/engine/soundfont-stream.ts:29,76,203–206` 的历史 PCM 在会话 dispose 前保留，Worker `soundfont.worker.ts:30–32,86–93,141–143` 保留未传出的预滚动片段。已有 128MiB 约束针对未来补给窗口，不是整段历史的总内存上限；长作品可另行设计可重建、受预算限制的历史缓存回收。

两项均留给用户决定后续是否优化。未将历史缓存删除或重新合成算法混入本轮音乐行为修复。

## 清理预检兼容修正

通过最终生产验收后才启用 cleanup 阶段。第一组目录/镜像只读 audit 在读取固定六个保护容器时退出，独立语音归档 audit 也安全退出，没有生成成功 audit 或删除任何内容；两个实际失败的回执 SHA-256 `b5519315bb147462198f542ef74b62c6a168d2ea3793ab1bcb713c0432e2992f`。

原因实证为 Docker Go template 直接读取 `.State.Health` 时，两个本来没有 Health 字段的开发容器报 `map has no entry for key Health`。只将该可选字段访问改为 `index .State "Health"`；原来的 null 输出语义、固定六容器、生产 studio/controller 必须 healthy 与准确镜像、所有 allowlist/授权/删除保护全部保持。新旧固定六容器元数据对照：生产四个原行相同且 healthy，两个开发容器 running、health=null。

helper 新 SHA-256 `1154a953ebaf282b81e44159380ae03b969e83cdd78d835fdef312cba0fb8290`，before 原 `50d8a785…`；单 token diff SHA-256 `164ff4d099aec10edd8e931b7b375b32e4cf72fdccf82b2f72a28355db9f7f0d`；review `fa1b23a03d97318fcb21e30703808eed9f0e7a260e589b9e222852178672a874`。精确逆替换恢复原文件、Python AST 与独立 peer 全部通过；语音归档 helper 未改。随后重新获取两项 fresh audit，未重用失败清单。

公开 Release 已先同步真实已部署/已验收、清理收尾状态，readback SHA-256 `cb83232977fb42971748643af8fa58ad0f4559c8f4e9bbee8e43288c6981fc19`。

## Fresh 清理清单与精确授权

两个 fresh 只读 audit 均 exit 0，productionMutations=0：

- `cleanup-audit-20261002T134534Z-3390338.json`，SHA-256 `63d6f1f5a55f5f43b46b12ee65f9a7c899c986913e6cb548dadb0e5bd070fe79`：8 个历史构建目录（allocated 61,460,480 字节）及 10 个精确旧镜像 eligible，无 retained 项，各镜像容器引用为空。
- `speech-archive-cleanup-audit-20261002T134634Z-3392834.json`，SHA-256 `15d5661744b118cdddbc11c46e0e793c5a4692abd0798e316380b76f7cc627b8`：6 个旧作品 home 的 `.downloads` 中 12 个精确重复源压缩包，逻辑 4,812,563,514 字节、allocated 4,812,640,256 字节，逐文件 SHA、inode、单链接及无占用核验通过。共享三个模型 ready、正式 native 回执相符、实际消费者只读挂载共享模型。

root 逐项核对固定路径、镜像 ID、来源、revision、无容器引用及全部保护项，分别创建 root0600 精确授权：目录/镜像授权 SHA-256 `e1233c2d0cb8e577641d87214d5be61aa794b8b9fe9ca06497e216800affae3c`；12 归档授权 SHA-256 `270a1878f5d856c8afc5b527d5caa44cda4534e6da96c1d6f5c0ee8e2a29bb61`。执行时逐项重核，不使用全局 prune，不删除卷、作品、完整 home 或共享模型；已有备份和非清单镜像保留。实际删除结果随后独立记录。
## 目录与镜像已清理；语音归档重新审计

目录/镜像执行 run `20261002T135216Z-3399596` 实际成功，删除精确 8 个目录及 10 个旧镜像。结果回执 SHA-256 `6c4bf759c0313e72c977374aeabd49f9e351be5d84b1d4838dcd8905f9660a3f`；目录 allocated 61,460,480 字节。镜像标称体积存在共享层，不将标称合计冒充实际释放磁盘量。

随后独立语音归档步骤在删除前报 `Current proof differs from reviewed audit`，12 个归档均未删除，两精确授权及全局 cleanup 随即关闭。只读诊断确认唯一差异是两个当时运行的 Paseo 消费者已不在 running 容器列表：配置 SHA、共享模式值、正式部署/验收证明、baseline、native 和 shared 模型状态等全部精确相同。不能据此判断容器退出原因，也不为清理重启或终止消费者。

诊断证据 SHA-256 `acb1c3aad298b6af684c32ab8de2b5ad44bb16680006099f20a6d7e12efa6c66`。保留原严格复核，恢复相同 cleanup stage 字节后重新获取仅语音归档 fresh audit；不放宽守卫，不重复执行已成功的目录/镜像清理。

目录/镜像独立复核通过，review SHA-256 `9d3d53e3060c21e98a381545d1379d8c0f006a630e3ea8cd3fb278366a2171d2`。精确 8 目录、10 镜像实际均不存在，214 个文件系统 journal 项与 30 个镜像 intent/alias 项对应完整，errors 为空。固定六个保护服务身份/启动时间/健康状态未变，无容器或数据卷删除，所有模型与作品目录保留。清理前后同一文件系统空闲空间增加 9,561,788,416 字节，作为观察值记录，不跨同盘挂载重复累加。

历史 v8.2.1–v8.2.4 Release 均已保留原结果并追加 v8.2.5 已完成生产验收的后续说明，没有覆盖历史失败或移动标签；逐份正文 readback 相等。

新语音审计 `speech-archive-cleanup-audit-20261002T140657Z-3431627.json` 实际 exit 0，SHA-256 `6216db3e9393d8be3f64e1f1ea3414eda3ef55715ff0ed13636e1b402fb18ce8`。12 个目标与旧审计逐值一致，包括 inode、SHA、大小、owner、nlink 和时间元数据；6 个配置的当前 running 容器列表均为空，配置内容和共享模型方式不变。root 复核精确完整 entries、其余七项证明及模板后创建新 root0600 授权，SHA-256 `90cb76d61312c0a00c79142131f326a6f2f11a34e8d090d9e54c5e11dd84aca3`，只执行新语音归档清单。

## 清理执行完成与最终健康

语音归档执行 run `20261002T140849Z-3438936` 实际 exit 0，删除 12 个精确重复源压缩包，逻辑字节 4,812,563,514，allocated 4,812,640,256；errors 为空，目录、模型和 home 删除数均为 0。结果 SHA-256 `b65e9823e2195a34d04df6634b7c7037c1f3bc34da82b4c8cf9f0c00242f4faf`，journal SHA-256 `5d9e41bd17b11fd712147bcad1d2d64a84ffe42874ebc44b12aff12758ee4354`。执行后 speech 精确授权及全局 cleanup 均关闭。

仅本轮两次失败验收的容器临时输出目录也已清理，27 文件 / 5,619,060 字节，父目录保留。删除前后外部保留证据 42 文件 / 6,338,168 字节逐项大小/SHA 相等，两个原输出目录均确认 ENOENT。服务 UID1000 使用目录 fd 锚定 unlink/rmdir；没有改变权限或触及数据库/作品/daemon。回执 SHA-256 `573bfeb2f8eb53928bd8948c50b3f3582d862f3ed4f39902636ed830ad5d85b3`。

最终只读健康检查 SHA-256 `48e662465b1fd68d7a6f58c955dd215f38be7d1d761c45122d6a271091e48ab5`：公网 healthz/readyz 均 200，8.2.5 / `84bd7456c23b5c4a7640cf3fc78e0b62db520c7e`；容器内部同样通过，固定六个服务的容器 ID、镜像、StartedAt 和健康状态与清理前精确相同。全部发布阶段与两项清理授权关闭。

语音清理独立只读终审通过：36 条 journal 精确对应 12 组 intent → unlinked（remainingLinks=0）→ removed，12 个目标 nofollow stat 均不存在。三个共享模型必需文件 metadata 与审计逐值相同，两个共享源归档 802,093,919 字节重读 SHA 相符，native 回执/日志保持；未重新启动或删除任何模型/工作区。

最终 v8.2.5 公开 Release 正文 readback SHA-256 `e731d3e511aa8c1e26fb364da49a8aa07562e7f481676a4c4344021db8baa03c`，包含实际部署、验收、清理数量、限制与指南链接。标签和镜像不变；此记录另以文档提交归档，不触发生产重新构建或部署。
