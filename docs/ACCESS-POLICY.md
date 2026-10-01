# 反向代理访问策略

Frame Studio 将入口访问策略交给反向代理。平台、WebSocket、远程 MCP 和 CLI 支持任意域名或 IP 的 HTTP(S) 地址；应用不检查 Host/Origin 白名单，也不强制 TLS。

## 反向代理负责的设置

- 域名和入口路由、TLS 终止与 HTTP/HTTPS 跳转。
- 入口认证、IP 限制、请求来源策略和访问限流。
- CORS、CSP、Referrer-Policy、X-Frame-Options、HSTS 等浏览器访问策略。
- WebSocket 升级以及真实请求信息的转发。

平台信任反向代理的转发头。代理应向平台设置实际外部协议的 `X-Forwarded-Proto`，让 HTTPS 访问取得 Secure Cookie，HTTP 访问取得可用的普通 Cookie。平台自己的会话 Cookie 使用 HttpOnly、SameSite=Lax 和当前主机，避免规范地址配置影响别名或 IP 登录。独立远程 MCP 的 OAuth Cookie 同样按请求的转发协议生成；直连 HTTP 时默认按 HTTP 处理。

## 规范地址与多域名访问

`FRAME_PUBLIC_URL` 和独立远程 MCP 的 `FRAME_MCP_PUBLIC_URL` 用于生成绝对链接、OAuth issuer 与 resource，属于规范地址，不是访问白名单。修改这些配置只会改变生成的地址；其他域名或 IP 仍可用于访问。

OAuth 客户端注册接受 HTTP(S) 回调，包括自定义域名、IP 和查询参数；授权与换取令牌仍使用登记的完整回调值。外部客户端自己的地址要求由该客户端决定。

登录、会话、API/MCP Token、OAuth PKCE、授权请求随机令牌、有效期和撤销功能继续用于身份和授权协议。作品预览的 sandbox iframe 用于运行作品代码隔离，作品目录、文件版本和写入边界用于数据正确性。

## 兼容性

- 缺少 Origin、`Origin: null` 或其他 Origin 均可进入正常登录和授权流程。
- WebSocket 使用会话认证，不要求 Origin 与规范地址一致。
- 旧 `FRAME_MCP_ALLOWED_ORIGINS` 和 `FRAME_OAUTH_REDIRECT_URIS` 配置被忽略，部署无需清理该变量。
- 独立远程 MCP 响应浏览器 Origin，并处理 OPTIONS；最终 CORS 策略可由代理覆盖。
- CLI 不再需要 `--allow-http`，该参数作为兼容输入保留。
- OpenAI 兼容语音服务可使用任意域名或 IP 的 HTTP(S) 地址。
