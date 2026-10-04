# FRAME 服务端与 T3 架构

作品仓库只保存内容，软件、依赖和公共制作工具由匹配的 FRAME 运行时提供。所有作品共用一个 T3 Code 原生服务，日常创作与实时预览使用各作品唯一的权威工作目录。完整产品契约见 [AI 工作台](AI-WORKBENCH.md)。

## 运行角色

- `studio` 提供公开 React 页面、Fastify API、WebSocket、MCP 和 T3 的同源网关，不挂载 Docker socket。网页与外部工具通过统一业务操作注册器调用 FRAME 功能。
- `controller` 使用 PostgreSQL advisory lock 取得调度领导权，管理 FRAME 后台任务的领取、执行器、结果保存、清理和心跳；只有这个角色持有 Docker socket。
- `t3` 管理原生 project、thread、对话历史、权限、终端与 Codex/Claude Code 执行。作品按实际 cwd 绑定 project，多条 thread 共享同一作品目录；不为每个作品或回合创建 AI 执行容器。
- `executor` 是 FRAME 后台任务的独立非 root 容器，记录运行时身份，使用本次任务目录及制作工具。固定 CPU、内存和进程上限，没有数据库、Docker socket 或平台主密钥。
- `speech` 提供独立 CPU 语音合成，模型和声线在持久模型目录中管理。

Compose 只声明长期服务，一次性初始化在栈外按需执行并退出。FRAME、T3、语音和 CLI 独立升级，部署与共享运行时发布见 [服务器部署](SERVER.md) 和 [T3 Code](T3-CODE.md)。

## 持久数据与事件

PostgreSQL 保存 FRAME 作品索引、GitHub/语音配置、后台任务与事件，以及原生作品绑定、审片引用和验证报告。T3 在自己的持久目录保存原生账号、项目和对话；FRAME 不维护第二份提供商目录或上游对话会话。Git 保存作品源码与版本，文件系统保存素材、运行时和构建/导出产物。

FRAME 后台任务按持久事件游标补齐，T3 原生 shell 与终端订阅维护活动缓存。PostgreSQL NOTIFY 只传递变化对象及作品范围，WebSocket 刷新相关订阅；原生权限、线程活动和连接状态的变化合并通知，文本和 usage 流不逐 token 写数据库。重连时重新核对状态，对话与终端两份状态均同步完成前保持待核对，不把暂时断线判为执行结束。

## 唯一作品目录与后台任务

`works/<uuid>` 是作品 Git worktree，项目内容位于 `projects/<slug>/`。可视编辑、T3 文件/终端、AI、CLI 和 MCP 读写相同文件；实时预览监听已保存变化，作品检查验证同一目录并记录 revision。公共引擎和依赖从只读共享运行时复用。

后台 MP4 导出在接受任务时冻结已保存的源码、原始媒体、运行时和参数，执行器使用该快照；结果不会反向应用为日常创作源码。新建作品任务需要发布生成的内容时，在作品锁和输入指纹校验下保存源码。执行与结果保存分为两个阶段，保存失败复用原结果恢复，不重新执行任务；丢失的执行不自动重放有副作用的命令。

审片引用冻结实际显示的版本与位置，FRAME 检查报告绑定实际被检查的 revision。原生回合的历史和检查点在 T3 查看，整作品版本恢复通过 FRAME Git 历史追加提交；不沿用旧 AI 任务的结果应用或逆向撤销接口。引用与导出细节统一见 [AI 工作台](AI-WORKBENCH.md)，Git 操作见 [源代码管理](SOURCE-CONTROL.md)。

## 鉴权与数据布局

平台目前为单管理员，密码由环境变量配置；会话 Cookie 和可撤销 API/MCP 令牌用于登录。Host/Origin、TLS、CORS、浏览器安全头和入口限流由反向代理负责，见 [访问策略](ACCESS-POLICY.md)。预览使用独立 sandbox 文档，T3 通过 FRAME 同源网关沿用登录；浏览器不接收服务管理 token。

FRAME 工具凭据绑定作品与活动的原生 thread，调用时核对实际 project/cwd。原生提供商、账号和模型使用 T3 页面及 CLI 配置，配置方式见 [提供商与模型](PROVIDER-MODELS.md)。

`repos/<uuid>` 管理 Git 引用，`works/<uuid>` 保存作品 worktree，`libraries/<repo>` 保存素材分支，`runs/<task>` 保存 FRAME 隔离任务与产物。`ai/t3/` 保存原生服务数据与 CLI HOME，`runtime/<fingerprint>` 保存共享 FRAME 工具链，`tools/<provider>/<version>` 保存独立 CLI 版本；原生存储与挂载说明以 [T3 Code](T3-CODE.md) 为准。

## 发布与验收

FRAME 应用、controller 与执行器镜像必须匹配。数据库迁移带校验和并串行执行，旧程序会拒绝未知 schema；历史内容协议与降级限制见 [V5 兼容说明](V5-UPGRADE.md)。T3 更新单独验证原生协议与页面，记录明确的源码、补丁和镜像身份。

发布流程见 [服务器部署](SERVER.md)，检查要求见 [验证说明](VERIFICATION.md)。实际结果放在 `records/`；测试夹具不替代外部账号真实授权、付费模型能力或作品艺术质量审片。
