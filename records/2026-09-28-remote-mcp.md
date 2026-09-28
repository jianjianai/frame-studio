# 远程 MCP、OAuth 与 Cloudflare Tunnel

基线：main `4bc30848110e4758b4de4633562bd10e0b434742`。用户明确要求外部 AI 接入，支持 OAuth、Bearer token 和环境文件配置隧道，并选择内置 OAuth。改动是工作台公共维护；本次未编辑现有两个未跟踪作品的源码与说明。

## 已实现

- 在原 28 工具之上增加官方 SDK Streamable HTTP 入口，原 stdio 与 CLI 保持共用项目服务。按授权主体持有后台作业，普通 HTTP 连接结束不取消任务；其他授权不能结束本授权的进程。
- 内置单所有者 OAuth：元数据发现、受限动态注册、预注册、公有/机密客户端、S256 PKCE、带密码与 CSRF 校验的同意页、一次性授权码、资源绑定、访问令牌、刷新轮换与重放撤销、撤销端点。
- 全局项目允许列表、只读、scope 收紧、每请求认证、Host/Origin 检查、请求体/连接/认证容量限制。持久化 token 哈希与状态独占锁。
- 产物返回认证下载链接；导出目录范围检查、流式下载、Range/HEAD。下载使用请求头授权，未引入公共分享链接。
- `film mcp-remote init/check/serve/revoke`，`.env.example`，`.evn` 显式文件名支持；本机初始化随机凭据而不打印。Cloudflare 命名隧道 token 仅通过子进程环境传递，自身子进程随服务关闭。
- 说明文档 `docs/MCP-REMOTE.md` 及主入口索引。实际 `.env` 被 Git 忽略，域名、客户端回调和隧道 token 留给部署配置。

## 实际修正与检查记录

- CLI 测试发现当前 Node 会处理 `--env-file`；入口使用 `node -- scripts/...` 明确分隔 Node 与应用参数，避免提前读取错误文件。
- 真实 Chromium 授权测试发现 `Referrer-Policy: no-referrer` 导致合法同源表单 Origin 为空。改为 `same-origin`，保持同源 CSRF 校验且不向外部回调发送 Referer；CSP 仅为配置允许的回调来源放行表单跳转。真实浏览器完成密码授权、跨来源回调与授权码交换。
- 初次 `pnpm verify` 的工程检查通过，类型检查失败：`projects/borrowed-light/exports/original-v1/render-offline.ts` 的备份路径被纳入全仓源码编译。未改作品与备份，在公共 tsconfig 排除生成的 exports、缓存、历史与测试输出目录后，类型检查和 107 项单元测试通过。
- 本机 `cloudflared --version` 返回 2026.8.3；仅验证可执行文件，未建立真实公网隧道。
- 测试修正：跨授权取消按照现有作业契约返回 `unobserved` 而非工具错误，断言改为检查任务未被取消且原授权最终成功。浏览器测试对虚构 HTTPS 回调的跳转拦截不稳定，改用实际监听的第二个回环 HTTP 服务验证跨来源回调，避免依赖外部 DNS；这是 OAuth 允许的本机回调例外，不代表公网 TLS 已验收。

| 验证 | 实际结果 |
| --- | --- |
| 工程检查 | 5 个项目，0 errors / 0 warnings |
| 类型检查、生产构建 | 通过；构建覆盖当前 5 个作品 |
| 单元测试 | 10 个文件 / 107 项通过 |
| 既有 MCP/制作检查 | 全量 MCP 运行中的原有 23 项通过，含 stdio、新旧协议、事务/回滚、渲染、混音、冻结输入、后台作业与交付检查 |
| 新远程接入检查 | 最终 `node --test tests/mcp/remote.test.mjs` 10/10，通过真实 SDK OAuth、Bearer、权限、重启/刷新/撤销、不同授权作业、认证下载、浏览器表单及隧道子进程控制 |
| CLI 配置 | 真实 init/check/help 通过；拒绝覆盖；`.env` / `.evn` / `.secrets` 被 Git 忽略；输出没有凭据 |
| 浏览器回归 | 独立端口 43183 跑完 22 项，21 通过 / 1 超时：sunny-rail 片尾等待超过 51 秒；结束后在独立端口 43184 仅复测该项，通过（55.4 秒，总测试用时）；首次失败证据保留 |
| 文件与格式检查 | 修改文件的格式检查、`git diff --check` 通过；MCP 测试独占临时目录已清理 |

`pnpm verify` 的最后一次整链运行因上述浏览器 OAuth 测试夹具失败停在 MCP 阶段；夹具修正后完整复测了远程测试文件，随后分步补跑生产构建和浏览器回归。没有将之前失败的整链表述为一次全绿运行。原始日志位于忽略的 `.cache/remote-verify.log`、`.cache/remote-final.log`、`.cache/remote-build-e2e.log` 和 `.cache/remote-sunny-retry.log`。播放检查的偶发超时未归因于本次远程接口改动，也不因单次复测通过就认定其时序稳定性问题已修复。

本次变更按用户要求提交至本地 main，不推送远端；没有创建新的工作树。提交范围仅包含远程 MCP 代码、测试、文档、配置模板及公共检查修正，排除私有 `.env` 和两个未跟踪作品目录。根 `.env` 已由 init 创建随机私有凭据，公网域名与回调仍为示例，隧道默认关闭。

## 尚未外部验收的范围

没有用户实际域名、隧道凭据或外部 AI 回调配置，因此未进行真实 Cloudflare 连通或第三方 AI 登录。配置检查通过、进程启动、本地 SDK/浏览器通过分别只证明各自范围。单所有者授权不提供不可信多租户的操作系统隔离，也未实现旧式 SSE、CIMD 或第三方 OIDC 登录。
