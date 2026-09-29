# FRAME · 工程协作约定

本文件只约束代码、文件布局、工具与协作修改，不规定动画内容、制作方式、交付或音乐水准。

## 修改范围

工作区为当前仓库根目录。主开发环境已迁至 ovh-docker：`/home/agentdock/AgentDock/frame-studio`，容器命令与持久化说明见 `docs/OVH-DEVELOPMENT.md`。先读 `docs/NEW-PROJECT-STANDARD.md`、`docs/AUTHORING.md` 和目标 `projects/<id>/README.md`，检查 Git 状态、HEAD 和相关 diff。

**视频制作任务只允许修改 `projects/<id>/`。** 每个视频的源码、素材、音轨、代码音频、说明、制作源文件、专用脚本、测试和导出结果全部放在这个目录。不得修改其他视频，也不得改公共引擎、播放器、根配置、依赖或仓库规范；需要公共能力时提出工作台维护需求。只有用户明确要求的工作台公共功能维护任务可以修改公共目录，本次隔离、音频和导出改造属于此类维护。

工程共享 pnpm 依赖，可以只读调用 `src/engine/` 的公开接口。不得导入其他工程私有文件。新增依赖由工作台维护任务通过 pnpm 更新 package.json 与锁文件。

## 新建和接口

新增使用 `pnpm animation:new <id> "标题" --renderer pixi|three|canvas`。脚手架先准备完整目录再注册，拒绝覆盖已有目录。自动发现 `projects/*/project.ts`，不改公共列表或路由。

`project.ts` 保持静态元数据；`load: () => import('./scene')`，可选 `loadAudio: () => import('./audio')`。场景接口保持 `createScene({width,height,quality}) -> {canvas,render(time),dispose()}`。画面和声音共用绝对时间，场景不自建动画或音频时钟；随机数据可确定性重建。

音频支持 `audioTracks` 的多条文件/代码音轨。生成器使用公共播放器提供的上下文和调度时间，必须支持任意片段、变速与释放；正常播放不需要预先合成音频文件。

运行资源放 `projects/<id>/public/`，浏览器 URL 为 `films/<id>/...`，通过 `assetUrl()` 使用。不得跨项目引用资源或通过路径穿越、符号链接越界。`dispose` 和初始化失败路径只释放本实例资源。

## 工具与检查

统一命令入口是 `pnpm film help`。AI 接手先用 `pnpm --silent film context <id> --json` 读取项目入口、元数据、音轨和修改范围；工具说明见 `docs/AI-WORKFLOW.md`。`film storyboard` 生成带时间标记的组帧预览，`film frame` 定位单帧；均写本工程 exports，不改运行源码。

生成工具只能写目标项目目录，导出到 `projects/<id>/exports/`，临时文件在本项目 `.cache/` 或导出目录并清理。浏览器下载使用浏览器选择的保存位置。海报更新 `pnpm posters --project <id>`；全量必须明确 `--all`。检查命令只读，失败返回非零。

项目任务运行 `pnpm project:check <id> --strict`、相关测试和 `pnpm project:scope <id>`。后者检查暂存、未暂存与未跟踪改动；可用 `--base <commit>` 检查相对基线提交的改动。公共维护运行 `pnpm verify`。这是工程与工具边界，不是操作系统权限沙箱；任意外部程序的写权限需要另行配置系统隔离。

公共测试在 `tests/`，工程专属测试在 `projects/<id>/tests/`，自动发现。浏览器测试设置 `FRAME_TEST_PORT`，不复用未知服务。并行工作使用独立 checkout、构建目录与端口。

## 保留现有工作与提交

后续任务直接在 `main` 分支开发，不再新建工作树。开始前检查并保留已有未提交修改，避免并行任务相互覆盖。

工程说明、接口和使用指南放在 `docs/` 或项目 README；修改记录、验证报告、审查结论等过程文档统一放在独立的 `records/`。仓库公共维护记录放根 `records/`，视频专属记录放 `projects/<id>/records/`，不突破项目修改边界。项目 README 和 `production/brief.md` 不堆积过程记录，只保留说明及记录目录链接。导出器的临时机器结果仍随输出保存在忽略的 exports 中。

共享文件修改前重新读取，保留他人未提交内容。只改本任务文件，不全仓格式化，不擅自 stash/reset/clean、删除他人目录或结束他人进程。需要 WSL 编译时先复制到 Linux 文件系统，完成后只清理本次创建的临时文件。

按明确文件清单暂存，检查 diff，不使用 `git add .` / `git add -A` 捎带他人更改，不强推。移动/删除同步修正引用。失败检查如实记录，不把历史缓存当新结果。资源保留来源与许可证，密钥和个人配置不入库。
