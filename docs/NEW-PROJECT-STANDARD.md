# 新增工程与文件修改规范

本规范管理工程组织，不规定动画制作方式、内容、交付或音乐标准。2026-09-28 起所有视频采用单目录边界；本次已迁移三个现有 Demo。工具统一入口和 AI 接手说明见 [AI-WORKFLOW.md](AI-WORKFLOW.md)。

## 1. 一个视频，一个目录

```text
projects/<id>/
  AGENTS.md                 仅允许修改本项目的约定
  README.md                 工程入口、依赖、脚本与测试用法
  project.ts                静态元数据
  scene.ts                  场景入口
  audio.ts                  可选的浏览器音频生成器
  music/                    可选的程序乐谱、音色和音效源码
  public/                   浏览器运行素材、音轨、封面、独立索引
  production/               原始材料、MIDI、参数、来源与许可
  records/                  修改记录、验证报告、审查结论
  scripts/                  工程专属处理脚本
  tests/unit/ tests/e2e/     工程专属测试，自动发现
  exports/ .cache/           生成结果与临时文件，不提交
```

视频制作任务只能改 `projects/<id>/`，不修改任何其他位置。公共代码位于 `src/engine/`，公共 UI 在 `src/ui/` 与 `src/App.tsx`，共享工具在 `scripts/`。这些目录、依赖和根配置只由用户授权的工作台维护任务修改。项目可以只读使用公开引擎接口及已安装依赖，不导入其他项目、公共 UI 或 Node 运行接口。

项目 id 使用小写字母开头的字母、数字和单连字符，最长 64 字符，不能是 Windows 保留名称；目录、元数据和路由一致。

## 2. 创建与资源映射

```powershell
pnpm animation:new my-film "我的动画" --renderer canvas
pnpm project:check my-film --strict
```

脚手架创建全部必需文件后一次发布项目目录，拒绝覆盖已有目录。同 id 的创建锁在 `projects/.cache/new-project-locks/`；不清理不属于本次调用的锁。模板附带可选 `audio.ts` 示例，默认不启用声音。

工作台自动发现 `projects/*/project.ts`；素材直接从 `projects/<id>/public/` 映射到 `films/<id>/`，构建时复制进 dist，不在源码里生成第二份镜像。各项目保存自己的 `public/assets.json` 和 `public/waveforms.json`，工作台只读汇总，无需修改公共索引。

所有运行资源真实存在并属于本项目，路径不包含 URL、盘符、查询、目录穿越或跳出项目的符号链接。公共字体与模型解码器由引擎维护，项目不改动它们。

## 3. 代码协议

`project.ts` 只包含静态字面量或本文件常量、`load: () => import('./scene')` 和可选 `loadAudio: () => import('./audio')`。元数据导入不执行网络或文件写入。

场景保持 `createScene({width,height,quality}) -> {canvas,render(time),dispose()}`。支持任意绝对时间的直接、倒退和重复绘制。适配 GSAP、骨骼、粒子等库时关闭独立循环；所有调度由公共播放器负责。

声音通过 `audioTracks` 配置多条文件或生成音轨，使用同一时间轴。生成音轨在浏览器直接创建和播放，导出复用同一生成器，无需先生成 WAV。单条旧 `audio` 字段保留兼容，不能与非空 `audioTracks` 同时使用。具体协议见 [AUTHORING.md](AUTHORING.md)。

初始化失败和 dispose 均回收本实例资源；单实例不误删共享缓存。

## 4. 写入与验证边界

```powershell
pnpm project:scope my-film
pnpm project:scope my-film --base <开始任务时的提交>
pnpm project:check my-film --strict
pnpm posters --project my-film
pnpm assets:import my-film "D:/assets/model.glb" --license "来源和许可"
pnpm render my-film --width 1920 --fps 30
pnpm frame my-film --frame 150
```

`project:scope` 检查暂存、未暂存、未跟踪及可选基线之后的改动，发现本项目目录外的路径就失败。它不自动撤销任何改动；并行共享 checkout 中不能可靠区分改动作者，应使用独立 checkout。

导入、混音、封面和命令导出工具验证目标路径和符号链接，拒绝跨目录输出。普通导出默认拒绝覆盖，`--force` 只允许覆盖目标项目内的指定输出。浏览器导出由浏览器选择保存位置。原始资源不被生成命令覆盖。全量封面只有显式 `--all` 才执行。

这些是工程约定与受控工具检查，不会撤销外部编辑器或任意程序的系统文件权限；需要强制防护时由独立用户/容器文件权限实现。

公共维护运行 `pnpm verify`；项目任务执行结构检查、本工程测试和修改边界检查。严格模式只提升工程警告，不评判内容。测试依据源元数据，不写死工程数。独立使用 `FRAME_TEST_PORT`，不复用未知服务，不结束他人进程。

## 5. 协作与依赖

过程文档与工程说明分开：仓库公共维护的修改记录、报告和审查放根 `records/`；工程专属记录放自己的 `records/`。README 和 production/brief.md 保留稳定说明、需求与设计，不追加历次验证结果，必要时链接记录目录。已有历史记录只代表当时状态。

开始前读根 AGENTS.md、接口说明与项目 README，检查 Git 状态和 HEAD。共享文件修改前重新读取，只改必要内容。未经授权不重置、清理或暂存他人的改动。

pnpm 统一管理依赖，公共维护通过 pnpm 更新 package.json 和锁文件；不提交 node_modules、dist、exports 或缓存。资源随附来源/许可，不提交密钥。提交按明确清单，移动和删除同步修正引用，记录实际测试结果。
