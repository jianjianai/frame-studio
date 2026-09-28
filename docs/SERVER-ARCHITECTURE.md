# FRAME 2 服务端平台

平台继续使用现有 FRAME 场景、多音轨、CLI 和导出协议。内容仓库只需包含 projects/<id>；平台运行文件由固定版本镜像提供，升级平台不修改作品源码。

## 服务与持久数据

- studio：React 管理页面、Fastify API、MCP 和持久任务调度；PostgreSQL 保存账号、令牌、仓库、素材、语音配置、会话、任务及事件。
- executor：每个任务启动独立容器，只有本任务工作副本和专用 AI 会话目录。无 Docker socket、数据库或平台主密钥。固定资源限额，非 root，丢弃 capabilities。
- speech：独立 CPU Kokoro 中文语音服务；模型与声线支持网页上传，外部 OpenAI Speech 兼容服务也可接入。
- proxy：复用部署环境的 Caddy；所有管理、素材、下载、MCP 接口要求登录或令牌。

任务与 HTTP/MCP 连接无关。容器 ID 与任务关联，重启调度器重新连接仍存活的执行容器；丢失的执行标记 interrupted，不重放有副作用的命令。会话继续使用持久化的上游 session ID。任务日志有序持久化，浏览器按游标增量读取。

## 工作副本与引用

每个任务只复制目标项目，注入当前镜像的公共工具。任务完成时在仓库锁下比较原始输入指纹，源发生变化即保留冲突副本，不覆盖。每个仓库同时只运行一个写任务。Git 拉取仅允许干净工作区和 fast-forward；推送前检查 LFS，绝不强推。

素材原件按内容哈希存储；关联项目时复制进对应内容仓库 projects/<id>/public/imports。数据库记录项目关联，项目清单记录显式引用。无关联的全局素材可进入回收站；动态代码引用无法完全证明未使用，项目内清理不能仅凭字符串扫描。

## 鉴权与配置

单管理员，初始化随机密码，scrypt 密码摘要，服务端会话，HttpOnly/Secure/SameSite Cookie，写请求校验 Origin。API/MCP 使用可撤销随机令牌。外部服务凭据使用独立主密钥加密，不进入 Git、响应、日志或任务参数。预览使用带 sandbox 的 iframe 和受限内容策略。

## 发布和验收

GitHub Actions 发布 ghcr.io/jianjianai/frame-studio 与 frame-speech 镜像，版本标签和提交 SHA 可追溯。Dockge 项目 /opt/stacks/frame 使用镜像部署，数据保存在独立 volumes。更新先备份数据库与文件，拉取明确版本并健康检查；不自动覆盖正在执行任务的工具版本。

验收包括原有 pnpm verify、平台认证/路径/冲突/任务恢复测试、真实浏览器管理流程、断开页面后任务继续、HTTPS 未登录保护、本地中文语音合成、镜像身份和服务器健康。外部 AI/私有仓库凭据未配置时明确标记未验证。
