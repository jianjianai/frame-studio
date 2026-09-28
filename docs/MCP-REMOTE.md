# 远程 MCP 接入

本服务为单个 FRAME 工作区提供 Streamable HTTP、内置 OAuth 授权码 + PKCE 和可选静态 Bearer token。原 stdio 和 film 命令保持可用。远程请求使用同一项目服务，项目范围由本机配置决定，不接受客户端切换根目录。

## Windows 一键启动

双击根目录的 **`启动MCP.cmd`**。脚本自动进入仓库目录，检查 Node.js，缺少依赖时通过 pnpm 安装，读取 `.env` 并检查配置，然后启动远程 MCP 和已启用的 Cloudflare 隧道。保持窗口打开，按 Ctrl+C 停止；失败时窗口会保留错误信息。

首次没有 `.env` 时会生成随机私有凭据并停下来提示填写配置，不覆盖已有文件。域名、OAuth 回调和隧道 token 仍需按下文填写。需要使用 `.evn` 或其他配置文件时，在终端运行 `启动MCP.cmd .evn`；相对路径以脚本所在目录为准。已有依赖时无需 pnpm；启用隧道仍需安装 cloudflared。

## 五步接入

在仓库根目录运行以下命令。需要已安装项目依赖；首次安装使用 `pnpm install --frozen-lockfile`。

1. 创建私有配置：

   ```powershell
   pnpm film mcp-remote init
   ```

   生成 `.env`，自动创建不同的随机 Bearer token 和 OAuth 授权密码，不在终端打印，不覆盖已有文件。参考模板是根目录的 `.env.example`。环境变量优先于文件；修改后重启服务。

2. 编辑 `.env` 中的实际域名、项目列表和 OAuth 回调地址：

   ```dotenv
   FRAME_MCP_PUBLIC_URL=https://mcp.your-domain.com
   FRAME_MCP_PROJECTS=my-film,birth-of-a-frame,borrowed-light
   FRAME_MCP_AUTH_MODE=both
   FRAME_OAUTH_REDIRECT_URIS=https://your-ai.example/oauth/callback
   ```

   以上域名和回调只是示例，必须替换。回调地址取自要连接的 AI 客户端，必须精确匹配，不能填 MCP 服务地址，也不支持 `*`。需要让 AI 新建作品时，预先把新作品 id 加进项目列表；明确填写 `*` 才允许全部项目。初始模板只开放三个 Demo。

3. 在 Cloudflare 创建或选择已有的**远程管理命名隧道**，将公开主机名 `mcp.your-domain.com` 路由到 `http://127.0.0.1:8787`，不设置路径过滤。把该隧道的运行 token 写入 `.env`：

   ```dotenv
   CLOUDFLARE_TUNNEL_ENABLED=true
   CLOUDFLARE_TUNNEL_TOKEN=你的隧道运行token
   CLOUDFLARED_PATH=cloudflared
   ```

   安装 cloudflared 并使其在 PATH 中可用，或填入可执行文件绝对路径。路径有空格时用双引号包住；Windows 可使用 `C:/tools/cloudflared.exe`。服务会启动并管理自己的 cloudflared 进程；若已有独立运行的隧道，保持 `ENABLED=false`，让已有隧道指向本机端口。这里不需要 Cloudflare API token，不使用临时随机域名。

4. 检查配置，然后启动：

   ```powershell
   pnpm --silent film mcp-remote check --json
   pnpm film mcp-remote serve
   ```

   `check` 只验证配置、静态客户端和启用时的 cloudflared 可执行文件，不创建授权状态，不连接外部 AI，也不证明隧道连通。`serve` 前台持续运行；关闭终端或 Ctrl+C 会关闭自身隧道和后台作业。长期运行需让该命令由你使用的进程管理服务托管。

5. 在外部 AI 客户端选择 **Streamable HTTP**，填写 `https://mcp.your-domain.com/mcp`。按下面的 OAuth 或 Bearer 方式连接。先确认 `https://mcp.your-domain.com/healthz` 返回 `ready`，再实际调用项目列表和上下文；只有这些公网步骤通过，才算完成外部接入。

统一入口 `pnpm film mcp-remote` 与 `pnpm mcp:remote` 等价。若坚持使用 `.evn` 文件名，每条命令都显式加 `--env-file .evn`；不会自动猜测文件。直接使用 Node 时写成 `node -- scripts/mcp-remote.mjs serve --env-file .env`，避免 Node 把应用参数当作自己的环境文件选项。

## 内置 OAuth

支持标准授权码流程，强制 S256 PKCE。客户端先读取受保护资源与授权服务器元数据，自动注册或使用预注册 client id，然后打开 FRAME 授权页。页面显示客户端名称、回调地址、允许访问的项目和请求的权限。输入 `.env` 的 `FRAME_OAUTH_ADMIN_PASSWORD` 并点击允许；浏览器跳回原客户端，客户端换取访问和刷新令牌。

授权密码只填在 FRAME 自己域名的页面。它与 Bearer token、Cloudflare 隧道 token 分开。这是单个工作区所有者的授权服务，没有第三方登录账户系统。客户端名称来自客户端自报，授权时同时核对回调地址与权限。

默认支持动态客户端注册，但注册的所有回调都必须在本机允许列表中。客户端要求固定 client id / secret 时，可在 `.env` 预注册：

```dotenv
FRAME_OAUTH_CLIENTS='[{"client_id":"my-ai","client_name":"My AI","redirect_uris":["https://your-ai.example/oauth/callback"],"token_endpoint_auth_method":"client_secret_post","client_secret":"替换成至少32字符的独立随机密钥"}]'
```

将相同 client id / secret 填到 AI 客户端。无客户端密钥时使用 `"token_endpoint_auth_method":"none"` 并去掉 `client_secret`；也支持 `client_secret_basic`。所有客户端仍必须使用 PKCE。

| 接口                                        | 用途                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `/.well-known/oauth-protected-resource/mcp` | 发现资源、授权服务器和 scope；根路径的元数据同样可用   |
| `/.well-known/oauth-authorization-server`   | 发现 OAuth 端点、PKCE 与认证方式                       |
| `/oauth/register`                           | 允许列表内的动态客户端注册                             |
| `/oauth/authorize`                          | 授权页面及人工同意/拒绝                                |
| `/oauth/token`                              | 授权码交换、刷新轮换；必须带 `resource=<公网地址>/mcp` |
| `/oauth/revoke`                             | 撤销同一客户端持有的授权                               |

支持 `frame:read` 和 `frame:write`，读权限必选。写权限包括编辑、新建、运行代码、渲染和产生文件；仅只读时不提供这些工具，直接调用也返回 403。全局只读配置优先于所有令牌。访问令牌默认 15 分钟，整个授权和刷新期限默认 30 天；刷新不会无限延长授权期限。旧刷新令牌重放会撤销整组授权。访问、刷新令牌为不透明随机值，客户端无需解析 JWT。

撤销全部 OAuth 授权：先停止远程服务，再运行 `pnpm film mcp-remote revoke`，随后重启。更换授权密码**不会撤销已有授权**，需要同时执行 revoke。撤销单个连接可由客户端调用 `/oauth/revoke`；已运行的对应作业会在清理时取消。授权状态持久化在 `.secrets/frame-mcp/`，仅保存 token / client secret 的哈希；授权过程中的短期码与同意请求不跨重启保留。

## Bearer token

客户端支持自定义 Authorization 头时，可使用 `.env` 中的 `FRAME_MCP_BEARER_TOKEN`：

```text
URL: https://mcp.your-domain.com/mcp
Authorization: Bearer <FRAME_MCP_BEARER_TOKEN>
```

每次 MCP 请求及产物下载都需要同一请求头，不把 token 放进 URL。静态 Bearer 默认拥有读写权限，可设 `FRAME_MCP_BEARER_SCOPES="frame:read"`。它不自动过期；轮换 `.env` 值并重启即可使旧 token 失效。不要把 OAuth 授权密码或隧道 token 填到这里。

`FRAME_MCP_AUTH_MODE=oauth` 只启用 OAuth；`bearer` 只启用静态 token；`both` 同时启用。Bearer-only 模式不提供授权服务器端点。

## 全部项目读写与逐次审批

本机私有 `.env` 使用以下配置，允许创建任意新项目并操作全部已有项目：

```dotenv
FRAME_MCP_PROJECTS=*
FRAME_MCP_READ_ONLY=false
FRAME_MCP_BEARER_SCOPES="frame:read frame:write"
```

修改后重启 MCP。OAuth 客户端需获得 `frame:read frame:write`，已有只读授权不会被静默升级。`mcp-remote check --json` 的 `permissions` 返回项目范围、可授予权限、Bearer 权限、服务端是否逐次确认和客户端审批归属。

服务端验证身份和权限后直接执行，没有逐次人工确认步骤。这里的完整权限指本工作区所有项目的制作能力，路径边界、版本冲突和操作锁继续有效。

ChatGPT 网页端的确认框由 ChatGPT 控制，MCP 服务器不能通过 `.env` 关闭，也不能把编辑/渲染伪装成只读。将 Frame Studio 的应用权限设为“允许所有操作”（`full_access`）可以取消该应用的逐次询问；通过应用权限管理接口修改后应回读确认。该设置只作用于指定应用，不需要更改全局权限。修改服务器本身不能证明网页端已免审批。自己的 OpenAI Responses API 客户端可以设置 MCP 工具参数 `require_approval: "never"`；该参数属于 API 请求，不能填进 `.env` 冒充 ChatGPT 网页设置。[OpenAI 官方审批说明](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

```javascript
const frameTool = {
  type: "mcp",
  server_label: "frame_studio",
  server_url: "https://your-mcp-domain/mcp",
  authorization: process.env.FRAME_MCP_BEARER_TOKEN,
  require_approval: "never",
};
```

OAuth 首次登录用于确认访问者身份，与每次工具操作的审批不同；远程身份认证保持有效，不开放匿名写入。

## 配置表

| 配置                                | 默认/要求                                                               |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `FRAME_MCP_PUBLIC_URL`              | 公网 HTTPS 根地址，无 `/mcp`、查询串或尾部子路径；本地开发允许回环 HTTP |
| `FRAME_MCP_HOST` / `FRAME_MCP_PORT` | `127.0.0.1` / `8787`；隧道转发到此处                                    |
| `FRAME_MCP_PROJECTS`                | 必填项目 id 列表，空格或逗号分隔；显式 `*` 为全部                       |
| `FRAME_MCP_READ_ONLY`               | `false`；`true` 对 OAuth 和 Bearer 都生效                               |
| `FRAME_MCP_AUTH_MODE`               | `both`；也可选 `oauth` / `bearer`                                       |
| `FRAME_MCP_BEARER_TOKEN`            | 随机值，至少 32 字符；init 自动生成                                     |
| `FRAME_MCP_BEARER_SCOPES`           | 默认读写；全局只读时进一步收紧                                          |
| `FRAME_OAUTH_ADMIN_PASSWORD`        | 20–256 字符的私有密码；init 自动生成                                    |
| `FRAME_OAUTH_REDIRECT_URIS`         | OAuth 模式必填，精确 HTTPS 地址；仅回环地址可用 HTTP                    |
| `FRAME_OAUTH_CLIENTS`               | 可选预注册客户端 JSON，最多 64 个                                       |
| `FRAME_OAUTH_ACCESS_TTL`            | 900 秒；允许 60–3600                                                    |
| `FRAME_OAUTH_REFRESH_TTL`           | 2592000 秒；允许 3600–7776000                                           |
| `FRAME_MCP_ALLOWED_ORIGINS`         | 额外允许的精确浏览器 Origin，无通配符；普通服务端 AI 客户端通常不需要   |
| `FRAME_MCP_JOB_TIMEOUT`             | 600 秒；允许 1–3600                                                     |
| `FRAME_MCP_MAX_PRINCIPALS`          | 最多 32 个活跃授权作业管理器；每个最多 2 个后台作业                     |
| `CLOUDFLARE_TUNNEL_ENABLED`         | `false`；启用时必须填 token 和固定 HTTPS 公网地址                       |
| `CLOUDFLARE_TUNNEL_TOKEN`           | Cloudflare 命名隧道的运行 token                                         |
| `CLOUDFLARED_PATH`                  | `cloudflared` 或绝对可执行路径                                          |
| `CLOUDFLARE_TUNNEL_PROTOCOL`        | `auto`；网络受限时可选 `http2` 或 `quic`                                |

## 外部 AI 读取产物

现有 34 个制作工具与 stdio 共用实现。`frame_read_artifact` 等结果中的本机产物会附加 HTTPS `resource_link` 和 `structuredContent.remoteArtifacts`（纯图片模式不附加链接）。产物下载限于已授权项目的 `exports/`；素材下载限于已登记的 `public/imports/`。两者支持 Range、HEAD 和流式传输，不开放仓库根目录、源码配置或私有状态。PNG 原生图片回读、JSON 回读和显式的 WAV 内联音频仍可使用。

素材上传使用 `/uploads/`，字节下载使用 `/assets/`，复用同一 OAuth/Bearer 验证。Cloudflare 应转发整个域名，原有配置不需要额外开放端口。每块最多 1 MiB，避免将大文件放进单次 JSON 请求；服务重启后同一授权可继续已确认的分块偏移。具体命令和 HTTP 请求格式见 [素材传输](ASSET-TRANSFER.md)。

远程链接也要求 Authorization 头，没有公共分享链接或 URL token。某些 AI 客户端不能为资源下载附加请求头；这些客户端可用工具内联回读图像/报告，视频需要通过支持认证下载的客户端或本机查看。返回链接不代表模型已看完视频或听过音频。

作业按授权主体管理，普通 HTTP 请求结束、客户端关闭连接不会取消已经启动的导出。使用同一个授权可继续 `frame_job` 查询；只能取消该授权自己启动的正在运行作业。重启后已有结果仍可查询，未完成任务报告 `unobserved`，不根据旧 PID 结束未知进程。

## 部署边界与故障定位

此服务用于你授权的 AI 操作**单个可信本机工作区**。项目级文件边界不构成操作系统沙箱：运行项目测试、构建和渲染会执行本机代码。多人不可信托管需要额外的进程/容器、checkout、网络与资源隔离。不要向不信任的客户端授予写和执行权限。

- 公网地址、授权元数据、回调使用同一稳定域名；Cloudflare 应转发整个主机，不只 `/mcp`，并保留请求头和查询参数。不使用 Cloudflare Access 交互式登录挡住这些端点，除非 AI 客户端本身支持该额外认证层。
- 不缓存 MCP、OAuth、产物下载；服务返回 `no-store`。不要在反向代理中记录 Authorization、授权码、表单密码或刷新令牌。cloudflared 使用 warn 级别，隧道 token 通过 `TUNNEL_TOKEN` 环境变量传入，不出现在启动参数中。[Cloudflare 参数说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
- 401：检查当前 token、认证方式和过期时间；客户端可从 `WWW-Authenticate` 自动发现 OAuth。403：检查 Origin 或只读权限。400 `invalid_target`：检查 `resource` 是否精确为公网 `/mcp` 地址。回调错误：核对 AI 实际回调与允许列表。
- 429：请求/授权容量或密码失败次数限制；按错误等待或清理旧授权。密码连续失败 10 次会临时限制 10 分钟。
- 隧道进程退出时整个服务退出并报告失败，便于托管程序重启。日志中的 `process_started` 只表示进程启动，公网可达性需要独立验证。
- `.secrets/frame-mcp/server.lock` 防止双实例覆盖状态。崩溃遗留锁先核对 PID 与本机实例确已停止，再处理该锁；不要直接删除整个授权目录。Windows 文件权限还应按自己的系统账户管理；程序请求的 POSIX 文件模式不替代 Windows ACL。
- 使用当前官方 SDK HTTP 和 2025-11-25 无状态 HTTP；不提供旧式独立 `/sse` 端点，也未实现 OAuth Client ID Metadata Document 或第三方 OIDC 登录。客户端应支持动态注册或预注册加 PKCE。具体外部 AI 的兼容性以真实连接为准。

## 实现约定

- `/mcp`：官方 SDK HTTP 处理器，兼容现代协议与 2025 版无状态 HTTP。后台作业按授权主体保存，多个请求可持续查询/取消；关闭服务会释放自己的作业。
- OAuth：受保护资源发现、授权服务器发现、受限动态客户端注册、预注册客户端、S256 PKCE、人工登录授权、一次性授权码、短期访问令牌、轮换刷新令牌、重放撤销和令牌撤销。回调地址必须与本机允许列表精确匹配。
- 权限：`frame:read` / `frame:write`；写权限包含编辑与执行可信项目代码。Bearer 与 OAuth 都不能越过本机项目范围和只读配置。每次 HTTP 请求重新认证。
- 运行配置只来自 `.env` 或进程环境。支持 `--env-file .evn`，不自动猜测拼写。样例可提交；实际 `.env`、`.evn` 和 `.secrets/` 被 Git 忽略，并排除在制作快照之外。init/check/serve 输出不打印凭据。
- Cloudflare：已有的命名隧道，token 通过子进程环境传给 cloudflared。本地服务默认只监听回环地址；外部地址必须使用 HTTPS。域名、隧道和回调由使用者填写，服务不擅自修改 Cloudflare 账户。
- OAuth 状态只保存令牌哈希，持久化于 `.secrets/frame-mcp/`；独占锁避免多个实例覆盖授权状态。进程崩溃的锁需确认实例已停止后再处理。

协议依据：[MCP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[官方 SDK](https://ts.sdk.modelcontextprotocol.io/v2/)。验证范围见 [本次记录](../records/2026-09-28-remote-mcp.md)。
