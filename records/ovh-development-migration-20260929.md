# OVH main 开发迁移记录

日期：2026-09-29。

## 范围与来源

用户确认只迁移当前项目 main，不迁移本地作品。来源 `C:\Users\28018\Desktop\动画`，提交 `403f8ee11258a025143da3ed9c6972d7fdb5c35c`。源工作区干净，366 个跟踪文件。

目标 `/home/agentdock/AgentDock/frame-studio`，位于 AgentDock 持久 workspace volume。通过 Git bundle 克隆 `--single-branch --branch main`，检出提交与来源一致；只建立 main 分支。Git fsck 完整性检查通过。传输 bundle 的两端 SHA-256 相同：`c0f8c88b230afe373f4d4d9e52ed7e266a0dbba1226b808b3e47877dd2709898`。

未迁入本地 projects、素材、导出、.env、.credentials 或 .secrets。测试所需作品由仓库自身夹具生成。GitHub fetch 保持原 origin，push 使用远端已有 jianjianai SSH 身份；dry-run 成功，本任务没有实际执行推送。

## 开发环境

- 专用容器 `frame-development`，UID/GID 10001，挂载该项目到 `/workspace`。
- 固定现有工具镜像，Node 24.21.0 / pnpm 12.4.2 / Chromium / FFmpeg / Git LFS。
- `pnpm install --frozen-lockfile` 成功，锁文件未变。
- 独立网络和测试 PostgreSQL：`frame-development-postgres`，测试数据库 `frame_test_development`，tmpfs 数据，未公布端口。
- 开发容器及测试库自动重启；源文件、Git 历史、依赖与开发环境文件位于持久卷。
- 已更新 AGENTS.md 的开发路径，并提供 docs/OVH-DEVELOPMENT.md。

## 验证

1. 远端执行 pnpm verify：工程检查（0 本地作品）、平台语法检查、两项类型检查、66 项平台单元测试、68 项 MCP 测试、播放器及工作台构建通过；MCP 1 项依赖外部音色库的用例跳过。
2. 首次服务端 1 项语音用例因 UID 10001 无法 chown 至执行器 UID 1000 失败。按 Linux 权限要求在独立、无 Docker socket 的开发容器中以 root 重跑完整 test:server：59 通过、0 失败、4 跳过，退出码 0。结束后恢复 `.cache` 所有者至 10001。此环境要求已写入开发指南。
3. 14 项工作台真实浏览器检查全部通过，包含实际 WebM 编码下载、音频操作、状态持久化及响应式布局。
4. 不具备真实执行器发布验收条件的 Codex/Claude 三例和 GeneralUser 外部音色一例明确跳过。没有把普通平台验证当作 verify:release 通过。
5. 新日志在 `.cache/ovh-dev/logs/`；工作台截图在 `.cache/frontend-validation/workspace/`。

## 清理与保留

远端传输暂存文件已删除，一次性 SSH 传输公钥已撤销。Windows 的 `.cache/ovh-migration-20260929` 删除请求被自动审批策略以 `blocked by policy` 拒绝，未绕过；该目录仍留在本机，含传输包、未完成的数据打包及已撤销密钥。数据打包未上传。

本机原仓库及作品保留。未变更、重启或迁移生产 FRAME 容器；没有发布镜像、公开开发端口或切换生产服务。今后开发以 OVH 的 main 为准。
