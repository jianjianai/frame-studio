# 8.0.2 生产发布 · 2026-10-01

用户要求将 Origin/Host/域名/TLS 入口策略修改上线生产。已部署 https://frame.nerviloom.com，实际运行 8.0.2，线上功能验收通过。未执行发布前备份、数据库转储或作品/素材/模型目录归档。

## 精确发布身份

| 对象 | 身份 |
| --- | --- |
| 入口访问策略源码 | `9451630ca965e29e13ed3cd5aeba840a70fefb13` |
| 最终源码、tag、生产 revision | `3b368c8afca9d28e5967c66ccf0c14cd7e984230` · `v8.0.2` |
| 生产及任务执行器固定镜像 | `ghcr.io/jianjianai/frame-studio/app:8.0.2@sha256:c0874aee5deac8e35f7844db47683decc54c4f030f9b1d08f56eed0c8a948dfd` |
| Node / engine protocol | `24.21.0` / `1` |
| 运行时指纹 | `2395810660055a7d100b2dfa1bc971efe9b0dd9913012b32696d3249f0233125` |
| 依赖锁指纹 | `b7fe83a679bcb1e84efae830be0cc98aac893b40b11ad87d785d2c69efd08821` |
| 最终公开健康检查时间 | `2026-10-01T10:46:56.941785+00:00` |

[发布运行](https://github.com/jianjianai/frame-studio/actions/runs/36846930791) 的 source、Windows、app、speech、publish 全部成功；[正式 Release](https://github.com/jianjianai/frame-studio/releases/tag/v8.0.2) 已发布。CI 只构建发布，功能验证独立执行。

实际下载 Windows Setup 并核对 MZ/PE 与 sidecar SHA-256：1,864,331 字节，摘要 `476707c7a08f99434774949c4aacd6cf1430bfe2fd880e93147853ce5045add7`。未在 Linux 声称完成 Windows 原生安装运行验收。

## 候选验证与修正

入口策略当前源码执行 pnpm verify 通过：平台/类型检查、161 项核心测试、121 项 MCP 测试及两个前端构建成功；MCP 有 1 项可选音色库跳过。普通服务回归 349 项中 343 通过、6 环境跳过、零失败。最终独立远程 MCP 改动又运行 12/12 测试及平台语法/类型检查，均通过。

8.0.1 / ab46328 精确源码与正式镜像在独立 PostgreSQL、网络及真实 Docker 中执行 Studio 构建和严格发布服务回归，exit 0：350 项、348 通过、0 失败、0 取消、2 明确条件跳过，严格 skip guard 成功。真实 Codex、Claude、无效修改 CLI 与 MCP → Docker frame/render → CLI 下载 → 解码通过。Docker 模式额外执行一个嵌套 Remotion 资源边界用例；最初部署脚本少算一项，在任何切换前停止，经核对仅修正自有部署计数期望，没有修改测试或放宽断言。

随后实际 8.0.1 切换发现 package.json 已更新，但独立公开版本常量仍为 8.0.0。健康身份门禁自动恢复原配置，8.0.0 再次 healthy；没有把此失败切换算作成功，也没有改写旧 tag/镜像。同步两个版本字段后发布新的 8.0.2。

逐文件比较不可变源码归档，8.0.2 与已通过严格门禁的候选仅 package.json 和 src/contracts/version.mjs 的版本字段不同，其他源码字节相同。新镜像的依赖锁、engine protocol、Node 和架构不变；doctor、公开/包版本对齐、私密产物排除检查通过，实际 HTTP /healthz 报告正确 8.0.2/revision。精确新镜像另执行平台语法/类型检查及 API、OAuth 浏览器、WebSocket、CLI、本地模式、真实 Docker frame/render 回归：21 项、20 通过、0 失败、1 个 Linux 上 Windows 原生条件跳过，目标 skip guard 通过，耗时 79 秒。完整 350 项门禁对应 ab46328，未将其描述为精确 8.0.2 的全量重跑。

两个元数据夹具先后因测试主密钥格式及包装对象生命周期用法错误，在目标测试前退出；核对真实实现后只修正自有夹具，最终完成回归，没有修改产品密钥要求或接口。

## 生产切换及数据

切换前确认无活动生产任务/执行器。旧镜像、新镜像及数据库的 9 项迁移 ID/校验值一致，无新迁移，旧版本回退兼容。仅修改生产 .env 的 FRAME_VERSION 为正式版本/摘要，只重建 studio/controller；Compose、凭据和 FRAME_LIVE_PREVIEW_POLLING=1 保持。speech 继续为 7.3.2，PostgreSQL、speech、development 及开发 PostgreSQL 的容器 ID/启动时间最终逐项一致，没有新增一次性 Compose 服务。

起始磁盘仅剩约 69 MiB；本任务只回收超过 3 小时未使用的 Docker 构建缓存（Docker 报告 9.583 GB），未删除镜像、数据卷、作品、素材、模型或旧备份。本任务没有执行发布前备份。过程中宿主机 /opt/frame* 临时验收目录消失，具体清理来源未确认，不能声称此前日志仍可取回；线上服务和仓库源码保持。最终可用空间 31,177,510,912 字节。

切换时实际比对确认原有 20 条作品记录/源码树哈希和 48 条素材记录一致，此结果来自成功部署工具返回。原始审计目录消失后，在项目缓存重新建立明确的原始 ID 集合及素材创建时间范围基线，最终验收后的 20 条作品与全部源码树哈希、48 条素材全部字段逐项一致。原始切换逐行文件已不可取回，后续新比对和最终产物实际存在，不将恢复的摘要当作原始日志。

## 实际线上验收

- 公开 HTTPS 入口使用无 Origin、Origin: null、任意 HTTP 与 HTTPS Origin，登录、认证 API 和 WebSocket 订阅全部成功；错误密码和未认证访问仍返回 401。
- 直接应用 HTTP 接受任意 Host/其他 Origin，Cookie Secure 随代理报告的 HTTP/HTTPS 协议变化，应用不再生成入口 X-Frame-Options/CSP。
- OAuth 实际动态注册接受非回环 HTTP 域名、HTTP IPv4 及其他 HTTPS 域名回调。独立正式 HTTPS MCP 客户端的工具发现/context 报告 8.0.2；HTTP CLI 无需 allow-http 即可调用。
- 全部 5 个在用作品实际 Chromium 加载、定位、播放、暂停和零诊断错误检查通过；12 份大音色库/WAV 的首尾 16 字节真实 HTTP 206、Content-Range 与原始文件字节一致。
- 一次复测在暂停确认前读时钟失败；另一轮 Sunny Rail 冷启动触发既有音频生成保护暂停。没有删除失败记录或修改引擎。最终每个作品用独立浏览器并等待音频就绪，确认 playing=false 后沿用 250ms/0.02s 时钟稳定及零错误断言，全部通过。不承诺冷启动或负载下不会保护暂停。
- 临时 Remotion 作品实际暂停定位、生产 frame/render 成功；runtime 为本次精确 revision/8.0.2/固定镜像。PNG 5,897 字节、MP4 7,507 字节，视频实际解码 12 帧且包含音频。
- 最初清理夹具误用不存在的 works_delete，核对 works_trash 合同后清理自有首轮作品、Token、OAuth 客户端和精确测试登录突发的 6 个会话。最终重跑的自有作品回收、Token 撤销后实际 401、OAuth 客户端删除、6 个会话登出后实际 401。最终临时 Token/客户端及私有恢复凭据文件均不存在，没有活动生产任务。
- docker cp 无法读取 tmpfs，改为逐文件读取真实字节并核对大小/SHA-256，最终保存 9 个截图、媒体和 JSON 证据。不会导出私有凭据恢复文件。

最终公开 /healthz、/readyz 均 200，studio/controller healthy，生产执行器固定镜像及轮询配置一致。任务数据保全与健康结论均经过最终复查。

## 证据与验证边界

最终证据位于仓库忽略目录 .cache/proxy-access-release-802/recovered，包含实际线上日志/JSON、9 个校验过的产物、新数据哈希比对、镜像与安装包身份及从本轮工具返回恢复的门禁摘要。源码归档摘要 `c466c02efb50b752e4966f31625812730b932972a286f4a39b3db98ee2644484`，最终线上结果摘要 `8e3431188171b3182a257d136b0fd6596396fa644785cdef46224081d103da5f`。原始 /opt 门禁和前几轮日志已不可用；恢复摘要明确引用本轮实际工具 session，不伪造原日志摘要或重跑事实。

会话中的既有 Frame 连接器 workspace_context 在上线前后均返回通用 Internal error，未将此连接器状态算作成功；独立实际 HTTPS MCP 客户端验证成功。Windows 原生安装运行、真实云模型推理未在本次更新中复测。截图和原始私人证据不公开凭据、预览能力 URL 或用户源码。
