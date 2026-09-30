# GitHub 发布流程提速 · 2026-10-01

## 用户要求

GitHub 工作流只负责发布，不执行测试；优化 Windows 安装程序与 Docker 镜像的发布时间。

## 本轮修改

- 删除 GitHub 服务端验证工作流及发布任务里的 Windows 功能测试、测试工具准备与测试证据上传；本地测试命令和测试源码保留。
- Windows、app 镜像、speech 镜像在标签解析后并行构建，Release 等待三者发布资产全部成功。
- v 开头的标签自动调度 main 上的发布任务，构建固定为目标标签提交。main 上的 pnpm store、NSIS 编译器缓存跨版本共享，避免不同标签的 Actions 缓存隔离。
- Docker 构建缓存保存到每个镜像独立的 GHCR buildcache 标签，保留原 GHA 缓存作为迁移期读取来源。正式版本和源码 SHA 标签仍按原规则发布。
- app 镜像先通过 pnpm fetch 按锁文件缓存下载，再离线安装；仅改变版本号或脚本时复用依赖下载层。
- 源码 COPY 时直接规范文件与目录权限，避免每次发布递归 chmod 已缓存的整个 node_modules，从而重新生成和上传庞大依赖层。
- Windows 打包前解析不可变运行组件元数据。已有工具和语音组件直接复用，仅在新组件缺失时准备 FFmpeg 或 Python 构建环境。
- Release 说明改为资产构建与发布事实，移除自动宣称功能测试通过的文字。

## 之前的耗时基线

GitHub run 36757400618（v7.6.3）：Windows 总耗时 9 分 44 秒，其中真正打包 16 秒；服务端验证重试耗时 15 分 55 秒；验证完成后 app 镜像额外耗时 5 分 37 秒、speech 镜像 3 分 3 秒。第一次验证因下载测试工具停滞而取消，此次完整发布从创建到结束共 44 分 34 秒。

这些是旧流程的实测数据，不代表新流程的实测耗时。

## 本轮验证

- actionlint 1.7.12 检查全部工作流通过；PowerShell 解析检查通过。所有 GitHub 工作流中没有 tests 路径、pnpm verify/test、node --test、Playwright 或测试数据库命令。
- 从 GitHub 实际读取运行组件元数据，生成两个 JSON 共 544 字节，缺失组件为零，没有下载运行组件 ZIP。与正式 v7.6.3 安装包对比，tools/speech 的 ID 与 SHA-256 保持一致。
- 组件解析的缺失组件、首次发布、网络错误、错误摘要和仅缺语音组件分支均在本地验证。网络错误明确终止，不会误判为缺失后启动大组件构建。
- Windows 真实 Setup 重新构建成功，耗时 18.3 秒，1,753,057 字节；SHA-256 为 83f490c4bda1bb7ba21ca1e645bd94b7d4f7d8008f8b0253dc76fb36d98fba7f。此为本轮本地候选构建，不是原正式 v7.6.3 安装程序的摘要。
- 在 WSL Linux 文件系统的隔离目录中，使用 Node 24.21.0、pnpm 12.4.2 实际完成无 package.json 的 pnpm fetch，再执行冻结锁文件的离线安装，离线安装阶段耗时 138 ms；Vite 8.3.1 可执行。
- Dockerfile 1.14 的符号权限 COPY 实际构建通过：原 0700 目录转为 0755，0600 文件转为 0644，0700 可执行文件转为 0755；UID 1000 可以读取源码并执行工具。临时容器、候选权限镜像和 WSL 临时目录按本次创建范围清理。
- 按仓库要求在本地执行 pnpm verify：93 个 Vitest 测试通过，MCP 115 个通过、1 个可选音色库用例跳过，类型检查和两个前端构建通过；服务端阶段缺少 FRAME_TEST_DATABASE_URL，命令退出 1，完整验收未通过。日志保存在忽略的 .cache/release-speed-verify.log。

新流程的 GitHub 总耗时尚未实测，后续新标签发布时生效。首次运行将填充共享缓存；后续相同依赖的版本可以复用。

## 工程依据

- [GitHub 缓存的标签隔离规则](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)
- [工作流使用 GITHUB_TOKEN 触发 workflow_dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [Docker Registry 构建缓存](https://docs.docker.com/build/cache/backends/registry/)
- [pnpm fetch 的锁文件缓存设计](https://pnpm.io/cli/fetch)
- [Docker COPY 的符号权限语法](https://docs.docker.com/reference/dockerfile/#copy---chmod)
