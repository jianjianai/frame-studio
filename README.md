# FRAME · 作品管理与 AI 创作平台

V7 增加多轨音频文档与编辑器、Web Audio/Tone.js/PCM Worker/SoundFont 混用、轨道/总线/主输出处理链、波形与格式转换、独立音频及分轨导出。使用方法见 [V7 音频](docs/AUDIO-V7.md)。

V6 增加统一混合合成、视频/图片/图像序列、Three/Pixi/Canvas/Babylon/Lottie 接入和异步目标帧渲染。新项目默认空白，不预选 2D/3D 引擎；GUI、CLI、MCP 共用 visual.json 及版本冲突保护。接口见 [混合合成](docs/COMPOSITION.md)。旧场景/音频协议 1 继续兼容，[V5](docs/V5-UPGRADE.md) 的 AI 直接执行、版本化审片、任务诊断和撤销能力继续复用。

以 AI 创作、人类审片为中心的私人视频工作台：持久对话、精确播放器、多轨时间轴、素材与配音、独立版本历史、导出和 GitHub 同步。

## 两类独立仓库

- **平台代码**：[frame-studio](https://github.com/jianjianai/frame-studio)，包含网页、服务端、引擎、制作工具及 Docker 配置。
- **作品内容**：[frame-works](https://github.com/jianjianai/frame-works)，包含作品源码、关联素材和制作资料。可在网页设置中连接更多作品仓库。

平台仓库不保存作品，作品仓库不复制平台代码。镜像升级更新软件，GitHub 同步更新作品，两条流程独立。

## 使用

Windows 客户端见 [Windows 本地模式](docs/WINDOWS-LOCAL.md)；服务器部署见 [Docker / Dockge 部署](docs/SERVER.md)。产品与数据边界见 [作品平台设计](docs/WORKS-PLATFORM.md)。

Windows 首次启动下载工具与 Python 运行环境，Node 依赖由 pnpm 按锁文件安装并缓存，更新时复用。Windows 程序包和服务器语音镜像均不携带语音权重；在设置中按需下载推荐模型或上传自定义 Kokoro 模型。

首页显示最近打开。通过仓库进入作品列表，新建只填名称。每个作品使用同仓库内独立的 `works/<id>` 分支，素材库独立使用 `frame/materials`；作品历史和拉取/推送互不干扰。具体产品契约见 [AI 工作台](docs/AI-WORKBENCH.md)。

作品在新标签页打开，无全局侧栏。AI 对话与时间轴均可显隐，播放器始终保留进度条；左右分栏及视频/时间轴高度可拖动，细分割线仅在交互时显示。素材、版本比较、统一导出和资料在弹窗操作。服务器设置支持多个模型提供商、官方账号登录、多 GitHub 账号、CLI 独立升级及语音模型。服务器管理员密码仅通过 `FRAME_ADMIN_PASSWORD` 配置。本地模式直接使用电脑上已安装并登录的 Codex 和 Claude CLI，使用 SQLite，无工作台登录密码。

AI 消息提交后在隔离工作目录执行，关闭浏览器不停止任务。服务器使用独立容器，Windows 本地模式使用原生子进程。通过结构、范围、项目测试和预览构建验证后才应用修改，自动产生 Git 版本并刷新播放器。导出文件有保留期限，与素材库分离；可发布到对应作品仓库 Releases。

外部 AI 使用带 Bearer 令牌的 `/mcp`，从 `frame_help` 发现操作；CLI 使用 `FRAME_URL`、`FRAME_TOKEN` 和 `pnpm platform help`。作品操作统一使用作品 UUID，支持参数发现、局部补丁、批量事务、任务等待、上传续传和产物下载，详见 [平台 MCP / CLI 工作流](docs/PLATFORM-TOOLS.md)。隔离任务内使用 `pnpm film` 和 `node scripts/work-tool.mjs`。

远程接手先用 `frame_workspace_context`，查询参数用 `frame_tool_describe` / `pnpm --silent platform describe`。分页搜索、精确补丁、任务等待、产物下载与断点上传见 [远程 MCP 与 CLI 工具指南](docs/PLATFORM-TOOLS.md)。

支持浏览器的 AI 可通过 `works_browser` 获取[专用审片页](docs/AI-BROWSER.md)，使用控制台 `FRAME_AI` 在本机浏览器查看帧、播放片段、截图和导出，减少服务器计算。

## 开发与验证

`pnpm dev` 启动平台前端，代理到本机 3000 端口服务端。服务端需要 PostgreSQL 和部署文档中的环境变量。`pnpm dev:player` 是内部播放器调试入口。

制作接口见 [AUTHORING](docs/AUTHORING.md)，引擎规范见 [NEW-PROJECT-STANDARD](docs/NEW-PROJECT-STANDARD.md)。规范中的 `projects/<id>/` 指作品仓库或隔离任务内的作品路径。

公共维护执行 `pnpm verify`。历史作品回归单独执行 `pnpm verify:content`，需要先将独立作品仓库的 `projects/` 复制到临时测试 checkout。复制的作品不提交、不进入镜像。服务端测试使用独立的 `FRAME_TEST_DATABASE_URL` 数据库（名称含 `frame_test`）。验证与部署证据位于 [records](records/)。
