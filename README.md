# FRAME · 作品管理与 AI 创作平台

以作品为中心的私人动画工作室：创建作品、AI 对话、画面预览、素材与配音、版本快照、视频导出和 GitHub 同步。

## 两类独立仓库

- **平台代码**：[frame-studio](https://github.com/jianjianai/frame-studio)，包含网页、服务端、引擎、制作工具及 Docker 配置。
- **作品内容**：[frame-works](https://github.com/jianjianai/frame-works)，包含作品源码、关联素材和制作资料。可在网页设置中连接更多作品仓库。

平台仓库不保存作品，作品仓库不复制平台代码。镜像升级更新软件，GitHub 同步更新作品，两条流程独立。

## 使用

部署与首次配置见 [Docker / Dockge 部署](docs/SERVER.md)，产品与数据边界见 [作品平台设计](docs/WORKS-PLATFORM.md)。

登录后进入作品库，直接新建或打开作品。在同一创作页查看画面、与 Codex / Claude Code 对话、使用素材、合成中文配音、保存版本并导出。关闭浏览器不会停止后台任务。

设置中管理 AI 凭证、工具独立升级、语音引擎和模型、多个 GitHub 作品仓库、MCP 令牌及登录密码。内置 CPU 中文 Kokoro 模型，支持兼容语音 API 和 Kokoro 模型上传。

外部 AI 使用带 Bearer 令牌的 `/mcp`；CLI 使用 `FRAME_URL`、`FRAME_TOKEN` 和 `pnpm platform works_list`。作品操作统一使用作品 UUID。隔离任务内使用 `pnpm film` 和 `node scripts/work-tool.mjs`。

支持浏览器的 AI 可通过 `works_browser` 获取[专用审片页](docs/AI-BROWSER.md)，使用控制台 `FRAME_AI` 在本机浏览器查看帧、播放片段、截图和导出，减少服务器计算。

## 开发与验证

`pnpm dev` 启动平台前端，代理到本机 3000 端口服务端。服务端需要 PostgreSQL 和部署文档中的环境变量。`pnpm dev:player` 是内部播放器调试入口。

制作接口见 [AUTHORING](docs/AUTHORING.md)，引擎规范见 [NEW-PROJECT-STANDARD](docs/NEW-PROJECT-STANDARD.md)。规范中的 `projects/<id>/` 指作品仓库或隔离任务内的作品路径。

公共维护执行 `pnpm verify`。历史作品回归单独执行 `pnpm verify:content`，需要先将独立作品仓库的 `projects/` 复制到临时测试 checkout。复制的作品不提交、不进入镜像。服务端测试使用独立的 `FRAME_TEST_DATABASE_URL` 数据库（名称含 `frame_test`）。验证与部署证据位于 [records](records/)。
