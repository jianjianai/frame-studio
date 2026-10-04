# 本机开发与生产

当前执行环境就是 OVH Docker 宿主机。当前 checkout 为 `/home/ubuntu/Documents/AgentDock/frame-studio`；直接在 main 开发，不经 ovh-docker 插件或 SSH 中转。先检查 Git 状态、HEAD 和相关 diff，保留已有未提交内容。

## 开发与测试

工具镜像包含 Node 24、pnpm 12.4.2、Chromium、Git LFS 和 FFmpeg。已有 `frame-development` 挂载另一份 AgentDock checkout，不能把它当作当前代码。需要容器工具时，以当前目录为明确 bind source，使用自己创建的 `docker run --rm`，选择独立测试目录、端口和数据库；结束后清理本次临时资源。

工具检查仅输出镜像、状态及挂载等需要的字段，不输出含口令的完整 inspect 或生产 `.env`。当前用户通过 `sudo -n docker` 使用 Docker。测试库名必须含 `frame_test`，不连接生产库；测试不会导入生产作品。

依赖通过 `pnpm install --frozen-lockfile` 显式安装。`verifyDepsBeforeRun: false` 避免运行制作命令时重写只读共享依赖。公共维护运行 `pnpm verify`，正式切换运行 `pnpm verify:release`；真实执行器用固定候选镜像、隔离数据库和目录。完整测试后只清理本次容器及输出，不执行全局 prune。

## 生产路径

Dockge 栈为 `/opt/stacks/frame`，持久数据为 `data/`、`postgres/` 和 `models/`。当前 public URL 为 `https://frame.nerviloom.com`。发布只更新本次需要的软件服务，保留 PostgreSQL、语音及其他项目服务。共享 T3 的部署与独立升级见 [T3 Code](T3-CODE.md)。

## 授权生产更新

后续更新按用户要求默认跳过发布前备份：不自动转储数据库、打包数据目录，也不重复完整校验历史备份。保留构建与测试、活动任务检查、必要服务切换和上线验收；不为备份停机。已有备份和旧镜像保留。不可逆数据迁移或删除另行说明并确认，备份仅在用户明确要求时执行。完整约定见根 `AGENTS.md` 的“发布与备份”；不要直接复用历史记录或缓存脚本中的全量备份发布流程。

回退前必须核对目标镜像的迁移清单覆盖当前数据库的迁移记录。即使迁移只新增表或列，旧程序仍可能因“数据库比应用更新”而拒绝启动；不能仅凭迁移可加性判断回退兼容，也不能删除迁移记录绕过检查。兼容回退基线与上线中发现的问题记录在当次 `records/` 报告中。

上线验收须核对全部未删除作品的当前源码与运行时预览，包含大文件媒体；健康接口通过不能替代作品验收。若已有任务占用作品，等待并核对当前预览，避免重复构建。
