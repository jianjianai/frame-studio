# OVH 开发环境

主开发目录：`/home/agentdock/AgentDock/frame-studio`，在 ovh-docker 插件中指定此目录作为 workdir。直接在 `main` 开发，不再依赖 Windows 工作目录。

## 代码与持久化

代码及 `.git` 位于 AgentDock 的持久 workspace volume，重建 AgentDock 容器不丢失。开发容器 `frame-development` 将同一目录挂载到 `/workspace`；两处编辑的是同一份文件。`origin` 保持 `https://github.com/jianjianai/frame-studio.git`，Git 操作在 AgentDock 中执行，推送地址单独配置为 `git@github.com:jianjianai/frame-studio.git`，使用其现有 jianjianai SSH 身份（推送 dry-run 已验证）。不要在开发容器里复制账号凭据。

仅迁入 main 和可达提交历史；本地作品、配置、凭据及导出不在迁移范围。`projects/` 可以为空，平台验证使用自己的临时作品夹具。不要从生产数据目录复制作品来补测试。

## 日常命令

在 ovh-docker 的项目目录执行：

```sh
git status --short --branch
ssh host 'sudo -n docker exec frame-development pnpm install --frozen-lockfile'
ssh host 'sudo -n docker exec -u 0 frame-development pnpm verify'
ssh host 'sudo -n docker exec -u 0 frame-development chown -R 10001:10001 /workspace/.cache /workspace/dist /workspace/studio-dist'
ssh host 'sudo -n docker exec frame-development pnpm test:workspace'
ssh host 'sudo -n docker exec frame-development pnpm build:studio'
```

工具容器固定使用现有 FRAME 工具镜像 `sha256:43b5807e9a4db3f1265512f3f95df171091b774641acc1df495dc4cd42148470`，包含 Node 24.21.0、pnpm 12.4.2、Chromium、Git LFS 和 FFmpeg。实际代码和依赖来自 `/workspace`，不会调用镜像中的旧平台实现。常规开发容器用户 UID/GID 10001，与 AgentDock 一致。完整服务端测试的语音用例会将临时执行器文件 chown 为 UID 1000，因此完整 verify 或 test:server 需在这个无 Docker socket 的专用容器中使用 `docker exec -u 0`；执行后按上面的命令恢复生成文件的所有者。普通构建、工作台浏览器测试和编辑仍使用 UID 10001。

`FRAME_TEST_DATABASE_URL` 已在开发容器环境配置，仅连接独立的 `frame-development-postgres` / `frame_test_development`。测试会清空这个测试库；它不保存业务数据，使用 tmpfs，容器重启后重新初始化。独立网络为 `frame-development`，没有公布数据库端口。容器环境文件位于忽略的 `.cache/ovh-dev/`，权限 600。

开发与测试容器均设置 `restart=unless-stopped`。开发容器只保活，按需通过 docker exec 运行命令，没有挂载 Docker socket，不启动生产调度器。`pnpm verify:release` 的真实执行器仍需要单独搭建隔离候选镜像及容器控制环境，普通 verify 通过不代表发布验收。

## 预览与服务

运行 `ssh host 'sudo -n docker exec frame-development pnpm dev --host 0.0.0.0'` 可启动工作台 Vite 开发服务。其 API 需要另外启动独立开发平台，并使用独立业务库和数据目录；测试数据库不能作为业务库。本次迁移未启动业务平台或公开服务。

若需从 AgentDock 浏览器访问开发容器，可以通过 `ssh host 'sudo -n docker inspect frame-development --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"'` 查询开发容器 IP，然后用只绑定 AgentDock 回环地址的 SSH 本地转发访问该 IP 的开发端口。不要把开发服务直接接入生产 Caddy。

## 重建与维护

容器启动参数可通过 `ssh host 'sudo -n docker inspect frame-development'` 检查，但环境字段含测试库口令，不应完整输出到聊天或日志。安全查看挂载、镜像和状态时应使用相应 `--format`。重新创建容器时挂载源为 `/var/lib/docker/volumes/agent-dock_agentdock_workspace/_data/frame-studio`，目标 `/workspace`；加载该目录 `.cache/ovh-dev/dev.env`，保持工作目录和用户不变。

主代码、Git 历史和文档应持续提交；依赖和构建输出可重建。不得改动 `frame-studio-1`、`frame-speech-1`、`frame-postgres-1` 等现有生产容器。迁移记录见 `records/ovh-development-migration-20260929.md`。
