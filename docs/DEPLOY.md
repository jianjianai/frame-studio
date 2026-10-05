# 部署

## 本机

```bash
corepack enable && pnpm install && pnpm build
pnpm start            # http://127.0.0.1:4310
```

只监听 127.0.0.1 时不需要登录。需要 Chrome 或 Chromium（AI 看画面、作品检查、导出用），找不到时设置 `FRAME_BROWSER=/path/to/chrome`。ffmpeg 随依赖安装（`ffmpeg-static`），也可用 `FFMPEG_PATH` 指定。

## Docker

```bash
mkdir -p deploy/data && sudo chown 1000:1000 deploy/data
FRAME_PASSWORD='设置一个强密码' docker compose -f deploy/compose.yaml up -d --build
```

- 所有数据在 `deploy/data`（容器内 `/data`）：作品库、设置、对话、导出、语音模型、AI 账号凭据（`/data/home`）。
- 镜像包含 Chromium 和中日韩字体。三维场景在容器中用软件渲染，导出较慢。
- 更新：`git pull && docker compose -f deploy/compose.yaml up -d --build`。

### 反向代理

对外提供服务请放在 HTTPS 反向代理之后（麦克风录音要求 HTTPS），并设置 `FRAME_PUBLIC_URL=https://你的域名`。代理需要转发 WebSocket（`/api/ws`、Vite HMR）。Caddy 示例：

```
frame.example.com {
  reverse_proxy 127.0.0.1:4310
}
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FRAME_HOME` | `~/.frame-studio` | 数据目录 |
| `FRAME_HOST` / `FRAME_PORT` | `127.0.0.1` / `4310` | 监听地址 |
| `FRAME_PASSWORD` | （无） | 登录密码；监听非本机地址时必须设置 |
| `FRAME_PUBLIC_URL` | （无） | 对外访问地址（反向代理后）；也是 MCP OAuth 的签发者地址，外部客户端据此完成授权 |
| `FRAME_BROWSER` | 自动查找 | Chrome/Chromium 路径 |
| `FFMPEG_PATH` | 自动查找 | ffmpeg 路径 |
| `FRAME_AGENT_HOME` | 用户主目录 | AI 代理（claude/codex）的 HOME，凭据保存于此 |
| `FRAME_DEV` | （无） | `1` 时界面使用源码热更新 |
