# FRAME 作品平台部署

## 部署与更新

`deploy/compose.yaml` 是 Dockge Compose 模板。默认使用 `ghcr.io/jianjianai/frame-studio:<版本>` 与 `ghcr.io/jianjianai/frame-speech:<版本>`。服务器需要 Linux x86_64、Docker、HTTPS 反向代理；默认中文语音使用 CPU。执行器镜像与平台镜像相同，任务启动独立容器。

在栈目录 `.env` 配置 `FRAME_VERSION`、随机 `POSTGRES_PASSWORD`、64 位十六进制 `FRAME_MASTER_KEY`、至少 14 字符的 `FRAME_ADMIN_PASSWORD`。管理员密码只在空数据库首次启动时使用。部署后可在网页修改密码。主密钥必须与数据库、文件一起备份，丢失后无法恢复加密的服务密钥。

模板使用已有 `caddy_caddy` 网络和域名 `frame.nerviloom.com`，部署到其他主机时修改域名、外部网络和 `FRAME_HOST_DATA`。后者必须是 Docker 宿主机上 `./data` 的绝对路径。数据库与语音服务不发布公网端口。

更新流程：等待当前任务完成，备份数据库与 data/models 卷，修改 `.env` 中的明确版本，执行 `docker compose pull && docker compose up -d`，检查 `docker compose ps`、`/healthz` 和一次作品预览。保留旧镜像标签供回退；数据库发生不兼容迁移时连同备份回退。不得使用 `down -v` 更新。

平台容器需要 Docker socket 来启动独立执行器，因此它属于可信控制层。执行器不会挂载 socket、数据库或主密钥，只能读写自己的工作副本和会话目录。为选择的 AI 提供的 API Key 仍属于该 AI 的运行凭据；仅在可信的个人作品中执行代码。

## 平台代码与作品仓库

平台仓库 `frame-studio` 只保存平台代码；独立作品仓库 `frame-works` 保存已有作品。两个仓库分别提交与同步，禁止导入平台源码仓库作为作品库。

作品仓库结构使用 `projects/<id>/`，无需复制整个 FRAME 平台。添加 GitHub HTTPS 地址与分支；私有仓库先在设置页配置拥有所需仓库权限的令牌。本地空间可在仓库同步面板关联一个现有 GitHub 仓库。

首次使用先创建作品，再选择生成关键帧、分镜、交互预览或 MP4。每个任务复制目标作品到独立工作目录。AI 修改成功后比较源指纹并应用；源冲突时保留结果副本并报告失败，绝不覆盖新的外部修改。

同仓库写入串行。Git 拉取要求工作区干净且只允许 fast-forward；提交只包括作品与必要的内容仓库文件；推送先上传 LFS。不同仓库可使用相同作品 ID。制作版本跟随仓库 Git，平台镜像版本跟随部署标签。

## 素材

网页支持上传、搜索、作品关联、未关联筛选与回收站。素材原件按 SHA-256 存储；使用到作品时复制到该仓库 `projects/<id>/public/imports/`，在 `production/materials.json` 保存来源与哈希。作品无需依赖全局素材服务即可运行。

“未被作品引用”按作品 public 目录的实际文件哈希统计，包括回收站作品；解除旧关联后若作品文件仍在，就继续计为引用。回收站支持恢复或确认永久删除，永久删除仅释放没有其他素材共用的原始文件；作品内已复制的资源保留。备份时保留 data/blobs。导入作品和查看作品素材时，会自动将原有媒体文件纳入全局库并保留来源信息。

## 语音

内置 Kokoro 82M 中文模型与三种声线，镜像构建时下载模型与字典，运行时不需要下载。外部引擎使用 OpenAI Speech 兼容的 `POST /audio/speech`，配置基础地址、模型、声线与可选密钥。生成结果保存为素材，可直接关联到作品。

内置权重来自 [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)，固定 revision `f3ff3571791e39611d31c381e3a41a3af07b4987`，Apache-2.0 许可；模型卡和许可证随语音镜像保留。内置声线为 `zf_xiaobei`、`zf_xiaoni`、`zm_yunxi`。

模型上传支持 Kokoro 的 `config.json`、`model.pth`、`voices/<名称>.pt`；不接受任意脚本或压缩包。权重以 PyTorch `weights_only=True` 加载。添加模型后上传完整文件，再添加为语音引擎并测试。模型文件就绪不代表实际合成通过，试听结果才是运行验证。

## AI 创作与工具升级

设置页分别配置 Codex 与 Claude 的 API Key、可选基础地址和模型。会话绑定一个仓库与作品。消息提交后由服务端任务执行，关闭页面不会终止；重新进入后按任务读取持久事件。执行器失效时报告失败，不自动重复已发生的工具副作用。一个任务最长一小时。

会话目录持久保存。服务端重启后重新查询原任务容器，仍在运行的任务继续被跟踪。服务器重启导致执行容器退出时，任务不会被误判为完成。后续消息使用已保存的上游会话 ID。

设置页可以指定 Codex/Claude CLI 的明确版本，独立安装到持久 tools 目录，并切换后续任务使用版本。当前正在运行的 CLI 进程继续使用原版本；回退时指定以前的版本。平台、语音镜像和 AI 工具升级相互独立。

## MCP 与 CLI

设置页创建 API 令牌，连接 `https://frame.nerviloom.com/mcp`，传递 `Authorization: Bearer <令牌>`。令牌代表单管理员，随时可以撤销。平台 MCP 使用 Streamable HTTP；原本地 stdio MCP 继续可用于本地作品。

先调用 `frame_works_list`、`frame_works_context`，使用作品 UUID 读写文件，写入需携带 SHA-256。渲染通过 `frame_works_task` 提交，`frame_task_get` 查询，`frame_artifact_read` 回读 PNG。素材使用 `frame_upload_begin/chunk/finish` 断点上传，`frame_works_use_asset` 保存到目标仓库。

远程命令行：

```sh
export FRAME_URL=https://frame.nerviloom.com
export FRAME_TOKEN=从私密环境读取令牌
pnpm platform actions
pnpm platform works_list
pnpm platform works_context '{"id":"作品UUID"}'
FRAME_ASSET_LICENSE=原创 pnpm platform upload ./image.png
```

网页 API 与 MCP、CLI 共用业务操作。大文件优先 HTTP/CLI 上传，MCP 分块上限 768 KiB。所有作品文件、素材下载和任务结果要求鉴权；交互预览使用一小时有效的随机能力地址与 sandbox iframe，地址也应视为私密链接。
