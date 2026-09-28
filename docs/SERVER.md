# FRAME 作品平台部署

## 部署与更新

`deploy/compose.yaml` 是 Dockge Compose 模板。默认使用 `ghcr.io/jianjianai/frame-studio:<版本>` 与 `ghcr.io/jianjianai/frame-speech:<版本>`。服务器需要 Linux x86_64、Docker、HTTPS 反向代理；默认中文语音使用 CPU。执行器镜像与平台镜像相同，任务启动独立容器。

在栈目录 `.env` 配置 `FRAME_VERSION`、随机 `POSTGRES_PASSWORD`、64 位十六进制 `FRAME_MASTER_KEY`、至少 14 字符的 `FRAME_ADMIN_PASSWORD`。密码每次启动生效，变更后撤销旧登录；网页和 MCP 不提供修改密码入口。`FRAME_SPEECH_VERSION` 独立控制语音镜像，默认保留 3.0.0。主密钥必须与数据库、文件一起备份，丢失后无法恢复加密凭据。

模板使用已有 `caddy_caddy` 网络和域名 `frame.nerviloom.com`，部署到其他主机时修改域名、外部网络和 `FRAME_HOST_DATA`。后者必须是 Docker 宿主机上 `./data` 的绝对路径。数据库与语音服务不发布公网端口。

更新流程：等待当前任务完成，备份数据库与 data/models 卷，修改 `.env` 中的明确版本，执行 `docker compose pull && docker compose up -d`，检查 `docker compose ps`、`/healthz` 和一次作品预览。保留旧镜像标签供回退；数据库发生不兼容迁移时连同备份回退。不得使用 `down -v` 更新。

平台容器需要 Docker socket 来启动独立执行器，因此它属于可信控制层。执行器不会挂载 socket、数据库或主密钥，只能读写自己的工作副本和会话目录。为选择的 AI 提供的 API Key 仍属于该 AI 的运行凭据；仅在可信的个人作品中执行代码。

## 平台代码与作品仓库

平台仓库 `frame-studio` 只保存平台代码；独立作品仓库 `frame-works` 保存已有作品。两个仓库分别提交与同步，禁止导入平台源码仓库作为作品库。

一个作品独占 `works/<slug>` 分支，分支内使用 `projects/<slug>/`，无需复制平台代码。共享素材库单独使用 `frame/materials` 分支。仓库列表可以选择 GitHub 账号创建或添加仓库，支持多个账号的设备授权及过期重登，也支持私密访问令牌。作品名称可更改，UUID 和分支保持稳定。

首次使用先创建作品，再选择生成关键帧、分镜、交互预览或 MP4。每个任务复制目标作品到独立工作目录。AI 修改成功后比较源指纹并应用；源冲突时保留结果副本并报告失败，绝不覆盖新的外部修改。

每个作品独立 Git worktree 和锁；同作品修改串行，同仓其他作品不受影响。Git 拉取要求当前分支干净且可 fast-forward；推送先上传 LFS。作品页面显示本分支领先、落后、未保存变化和检查时间。AI 修改与命名版本均记录到作品 Git 历史，恢复产生新提交，历史随普通 push 同步。

从 3.x 升级时，启动索引将已有作品复制到独立分支，原默认分支保留。升级前停止新任务并等待当前任务结束，备份数据库和整个数据目录；首次启动完成分支迁移后再接入流量。为各作品执行推送，为素材库单独推送。迁移前本地快照继续可恢复。

## 素材

网页支持上传、搜索、作品关联、未关联筛选与回收站。素材原件按 SHA-256 存储；使用到作品时复制到该仓库 `projects/<id>/public/imports/`，在 `production/materials.json` 保存来源与哈希。作品无需依赖全局素材服务即可运行。

“未被作品引用”按作品 public 目录的实际文件哈希统计，包括回收站作品；解除旧关联后若作品文件仍在，就继续计为引用。回收站支持恢复或确认永久删除，永久删除仅释放没有其他素材共用的原始文件；作品内已复制的资源保留。备份时保留 data/blobs。导入作品和查看作品素材时，会自动将原有媒体文件纳入全局库并保留来源信息。

## 语音

内置 Kokoro 82M 中文模型与三种声线，镜像构建时下载模型与字典，运行时不需要下载。外部引擎使用 OpenAI Speech 兼容的 `POST /audio/speech`，配置基础地址、模型、声线与可选密钥。设置中的试听保存为 24 小时临时文件，作品配音才保存为仓库素材并复制进作品。

内置权重来自 [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)，固定 revision `f3ff3571791e39611d31c381e3a41a3af07b4987`，Apache-2.0 许可；模型卡和许可证随语音镜像保留。内置声线为 `zf_xiaobei`、`zf_xiaoni`、`zm_yunxi`。

模型上传支持 Kokoro 的 `config.json`、`model.pth`、`voices/<名称>.pt`；不接受任意脚本或压缩包。权重以 PyTorch `weights_only=True` 加载。添加模型后上传完整文件，再添加为语音引擎并测试。模型文件就绪不代表实际合成通过，试听结果才是运行验证。

## AI 创作与工具升级

每个 Codex/Claude 工具可配置多个命名提供商：API 模式保存密钥、基础地址和模型，官方模式使用工具的官方授权流程。Codex 设备码登录需账号先启用该选项，Claude 支持网页返回验证码。对话绑定一个连接，不会自动换账号。提供商页面可发起模型请求测试或检查官方登录状态。

消息先持久化再调度，幂等键避免重试重复创建；结构化事件按游标读取，旧对话分页加载。关闭页面或重启平台进程不会终止执行容器。默认任务上限 6 小时，`FRAME_TASK_TIMEOUT_SECONDS` 可设 600–604800 秒；到期保留隔离产物并明确失败，不自动重放副作用。

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

上传前设置 `FRAME_REPOSITORY=<仓库 UUID>`；MCP 的 `upload_begin` 传入 `repo`。创建作品传入 `repo` 和 `title`。`repositories_page`、`works_page` 支持有上限的分页。

## 播放与临时文件

文件音轨按需加载，服务端支持 Range、条件缓存和文本压缩。大 SF2 音色库在构建时生成无损乐器包，支持的乐谱仅下载所需乐器；特殊 Bank/SysEx 配置回退原始库。首次冷跳转的合成仍受乐谱复杂度影响，不能承诺零等待。

成功导出保留 7 天，失败任务产物保留 14 天，可手动删除；最新有效预览、有效审片链接、下载和 Releases 上传期间的文件受保护。清理每分钟执行有界批次，导出不会自动进入素材库。Releases 标签绑定导出所用的源提交，需先把该提交推送到作品分支。浏览器本地 WebM 导出需保持标签页打开，服务器 MP4 导出可后台继续。
