# FRAME · 工程协作约定

本文件只约束代码、文件布局、工具使用和协作修改，不规定动画制作方式、创作流程、交付标准或音乐水准。单次任务中的内容要求不得自动加入工程规范。

## 开始修改

工作区：`C:\Users\28018\Desktop\动画`。所有工程复用本仓库，依赖统一由 pnpm 管理。先读 `docs/NEW-PROJECT-STANDARD.md` 和 `docs/AUTHORING.md`，再看目标模块说明；执行 `git status --short --branch`、查看当前 HEAD 及相关 diff。

只改本任务需要的文件。共享文件修改前重新读取，保留他人未提交内容；不要顺手全仓格式化。并行优先独立 git worktree、构建目录和测试端口。不擅自 stash/reset/clean、删除他人目录、结束所有 Node/浏览器进程或关闭他人服务。

## 目录和注册

- 工程代码：`src/projects/<id>/`；`project.ts` 元数据与 `scene.ts` 接口一一对应，id 与目录一致。
- 新运行资源：`public/films/<id>/`；工程说明和非运行源文件：`production/<id>/`，说明入口 `README.md`。
- 工程专用脚本：`scripts/projects/<id>/`；公共代码/工具：`src/engine/`、`scripts/`。
- 测试：`tests/unit/`、`tests/e2e/`；临时和生成结果：`exports/<id>/`、`.cache/`、`.logs/`，不提交 Git。

已有资源目录可以保留，不为规范批量搬迁。新增使用 `pnpm animation:new <id> "标题" --renderer pixi|three|canvas`，完整准备依赖后再注册，不能先留下缺少 scene.ts 的 project.ts。元数据不执行网络或文件写入。自动发现负责列表和路由，不逐工程修改公共 UI 或写死数量。

## 代码与资源接口

保持 `createScene({width,height,quality}) -> {canvas,render(time),dispose()}`。公共播放器调度绝对时间，场景不得自建动画循环/音频时钟；随机状态可确定性重建。GSAP/ticker/骨骼等库适配该时间接口，不限制采用哪种库实现。

`dispose` 和初始化失败路径回收本实例资源，不误删共享缓存。场景不 import Node 或工程处理脚本，不依赖其他工程的私有模块。资源路径在 public 下，通过 `assetUrl()`/元数据加载，防止路径穿越和外部运行资源依赖；密钥与个人配置不入库。

## 脚本与验证

检查命令只读；生成命令声明目标和覆盖行为，只写目标工程。共享索引保留无关条目。失败返回非零，不把旧缓存当新结果。单工程封面命令是 `pnpm posters --project <id>`；全量须明确 `pnpm posters --all`。

运行 `pnpm project:check`、相关测试及必要的 `pnpm verify`。严格模式 `pnpm project:check <id> --strict` 只把工程警告提升为失败，不评判内容。公共测试从项目元数据计算数量，不能从 UI 反推预期。设置 `FRAME_TEST_PORT` 避免冲突，不复用未知旧服务。

依赖通过 pnpm 变更，同步 package.json 和 pnpm-lock.yaml；不提交 node_modules/dist。涉及资源导入时保留第三方来源与许可证文件，不分发未经授权的源文件。

## 提交

存在并行改动时不用 `git add .` / `git add -A`，按明确清单暂存并检查 diff。只提交本轮代码、必要配置、测试与文档；不捎带他人的工程，不强推。文件移动/删除时同步修正引用。测试失败如实记录，测试源码与提交源码不一致时重新核对。
