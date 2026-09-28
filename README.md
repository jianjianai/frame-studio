# FRAME · 作品管理与 AI 创作平台

以 AI 创作、人类审片为中心的私人视频工作台：持久对话、精确播放器、多轨时间轴、素材与配音、独立版本历史、导出和 GitHub 同步。

## 两类独立仓库

- **平台代码**：[frame-studio](https://github.com/jianjianai/frame-studio)，包含网页、服务端、引擎、制作工具及 Docker 配置。
- **作品内容**：[frame-works](https://github.com/jianjianai/frame-works)，包含作品源码、关联素材和制作资料。可在网页设置中连接更多作品仓库。

平台仓库不保存作品，作品仓库不复制平台代码。镜像升级更新软件，GitHub 同步更新作品，两条流程独立。

## 使用

部署与首次配置见 [Docker / Dockge 部署](docs/SERVER.md)，产品与数据边界见 [作品平台设计](docs/WORKS-PLATFORM.md)。

首页显示最近打开。通过仓库进入作品列表，新建只填名称。每个作品使用同仓库内独立的 `works/<id>` 分支，素材库独立使用 `frame/materials`；作品历史和拉取/推送互不干扰。具体产品契约见 [AI 工作台](docs/AI-WORKBENCH.md)。

作品页常驻播放器、时间轴和 AI 对话，支持折叠导航、拖动分栏、左右/上下布局；素材、版本、导出和资料在弹窗操作。设置支持多个模型提供商、官方账号登录、多 GitHub 账号、CLI 独立升级及语音模型。管理员密码仅通过 `FRAME_ADMIN_PASSWORD` 配置。内置 CPU 中文 Kokoro 模型。

AI 消息提交后在独立容器执行，关闭浏览器不停止任务。通过结构、范围、项目测试和预览构建验证后才应用修改，自动产生 Git 版本并刷新播放器。导出文件有保留期限，与素材库分离；可发布到对应作品仓库 Releases。

外部 AI 使用带 Bearer 令牌的 `/mcp`；CLI 使用 `FRAME_URL`、`FRAME_TOKEN` 和 `pnpm platform works_list`。作品操作统一使用作品 UUID。隔离任务内使用 `pnpm film` 和 `node scripts/work-tool.mjs`。

支持浏览器的 AI 可通过 `works_browser` 获取[专用审片页](docs/AI-BROWSER.md)，使用控制台 `FRAME_AI` 在本机浏览器查看帧、播放片段、截图和导出，减少服务器计算。

## 开发与验证

`pnpm dev` 启动平台前端，代理到本机 3000 端口服务端。服务端需要 PostgreSQL 和部署文档中的环境变量。`pnpm dev:player` 是内部播放器调试入口。

制作接口见 [AUTHORING](docs/AUTHORING.md)，引擎规范见 [NEW-PROJECT-STANDARD](docs/NEW-PROJECT-STANDARD.md)。规范中的 `projects/<id>/` 指作品仓库或隔离任务内的作品路径。

公共维护执行 `pnpm verify`。历史作品回归单独执行 `pnpm verify:content`，需要先将独立作品仓库的 `projects/` 复制到临时测试 checkout。复制的作品不提交、不进入镜像。服务端测试使用独立的 `FRAME_TEST_DATABASE_URL` 数据库（名称含 `frame_test`）。验证与部署证据位于 [records](records/)。
