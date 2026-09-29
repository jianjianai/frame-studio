# Dockge 常驻服务修正

日期：2026-09-29。范围：部署配置与工程说明，不修改播放器、动画、业务数据或运行镜像。

## 问题与处理

生产 `frame-data-init-1` 已成功执行并以退出码 0 退出，另外四个服务正常运行。检查当前 Dockge 容器 `/app/backend/stack.ts`：状态来自 `docker compose ls --all --format json`，只要状态字符串包含 exited 就判为 EXITED。因此栈此前显示 `exited(1), running(4)`，并非运行服务故障。

仓库 `deploy/compose.yaml` 与生产 `/opt/stacks/frame/compose.yaml` 均移除了 data-init 服务和 studio 的对应完成依赖。现只声明 studio、controller、postgres、speech 四个常驻服务。首次数据权限初始化保留为文档中的栈外 `docker run --rm`，无网络、Docker socket、数据库和主密钥，不带 Compose 项目标签，退出后自动删除；不使用休眠或重复启动伪装常驻。

核对旧容器的 Compose 项目/服务标签、退出码及唯一 `/data` bind mount 后，仅使用无 `-f`、无 `-v` 的 `docker rm` 删除已退出的初始化容器。生产 Compose 生效配置逐项对比，除初始化服务和依赖外完全一致；生产与仓库模板文件 SHA-256 相同。

## 生产验证

在 Dockge 自身容器内复查状态已变为 `running(4)`；四个常驻服务均 healthy。容器 ID、启动时间、重启次数、挂载均与变更前一致，`.env` 字节未改变。`/healthz` 为 ok、`/readyz` 为 ready，运行镜像仍为功能提交 746ff74。

本次未备份、未停止或重启运行服务、未删除数据卷、未重新构建或替换生产镜像。只做生产配置修正与退出容器清理，不运行升级迁移。

## 回归验证

3 项部署边界测试通过：公开 API 无 Docker socket、私有控制器边界不变；默认栈只有四个长期服务；栈外初始化命令保留权限隔离和自动删除。独立宿主机临时目录完成两次真实初始化运行，确认 UID/GID 1000、测试文件内容不变、重复执行成功且容器自动清除；不接触生产数据。

`pnpm verify` 退出码 0：73 项单元测试、68 项 MCP 测试、61 项服务端测试通过，无失败。MCP 跳过 1 项外部 GeneralUser 内容夹具，普通服务端验证跳过 4 项（3 个需独立真实执行器环境的用例及 1 个 GeneralUser 用例）；本次没有将普通 verify 宣称为 verify:release。类型、平台检查和播放器/工作台构建通过。

证据保存在忽略目录 `.cache/dockge-persistent-services-20260929/` 的 production.json、initialization.json、verify.log 与 verify.exit。项目根 AGENTS.md 已记录 Dockge 栈只保留常驻服务的约定，docs/SERVER.md 同步首次初始化及默认不备份的发布流程。
