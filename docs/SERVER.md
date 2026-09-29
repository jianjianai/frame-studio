# FRAME 作品平台部署

## 部署与更新

`deploy/compose.yaml` 是 Dockge Compose 模板。默认使用 `ghcr.io/jianjianai/frame-studio:<版本>` 与 `ghcr.io/jianjianai/frame-speech:<版本>`。服务器需要 Linux x86_64、Docker、HTTPS 反向代理；默认中文语音使用 CPU。执行器镜像与平台镜像相同，任务启动独立容器。

在栈目录 `.env` 配置 `FRAME_VERSION`、随机 `POSTGRES_PASSWORD`、64 位十六进制 `FRAME_MASTER_KEY`、至少 14 字符的 `FRAME_ADMIN_PASSWORD`。密码每次启动生效，变更后撤销旧登录；网页和 MCP 不提供修改密码入口。`FRAME_SPEECH_VERSION` 独立控制语音镜像，4.2 起默认 4.2.0，升级时同步切换才能使用新增内置引擎。主密钥必须与数据库、文件一起备份，丢失后无法恢复加密凭据。

模板使用已有 `caddy_caddy` 网络和域名 `frame.nerviloom.com`，部署到其他主机时修改域名、外部网络和 `FRAME_HOST_DATA`。后者必须是 Docker 宿主机上 `./data` 的绝对路径。数据库与语音服务不发布公网端口。

更新流程：等待当前任务完成，备份数据库、`.env` 和 `data/models` 目录，修改 `.env` 中的明确版本，执行 `docker compose pull && docker compose up -d`，检查 `docker compose ps`、`/healthz` 和一次作品预览。保留旧镜像标签供回退；数据库发生不兼容迁移时连同备份回退。数据库在线备份使用 `pg_dump`；直接复制 `postgres` 目录必须先停止数据库。不得使用 `down -v` 更新。

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

内置 Kokoro 中文（8 条声线）、MeloTTS 中英混合、Piper 英文多声线（界面提供 8 条精选声线，API 可用 0–903 speaker ID）。模型与字典随语音镜像构建下载，运行无需联网、密钥或手工添加，CPU 上同时仅保留一个模型。内置引擎由平台维护，网页和 API 均不能新增副本、修改、停用或删除。

Kokoro 来自 [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)，固定 revision `f3ff3571791e39611d31c381e3a41a3af07b4987`，Apache-2.0。MeloTTS 来自 [MyShell 中文模型](https://huggingface.co/myshell-ai/MeloTTS-Chinese)，MIT；通过 sherpa-onnx 推理，英文读音受词典覆盖限制。Piper 使用 [LibriTTS-R 模型](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/libritts_r/medium/MODEL_CARD)，MIT / 训练数据 CC BY 4.0。ONNX 下载归档固定 SHA-256，来源与模型卡随镜像保留。

设置页分内置与自定义两类，每个引擎通过“试听”弹窗选声线、语速、文字。“添加自定义引擎”可接入兼容 OpenAI Speech 的 API，或上传 Kokoro 的 `config.json`、`model.pth`、`voices/<名称>.pt`。上传可分批继续，完整文件就绪后保存为引擎；不接受任意脚本或压缩包，PyTorch 文件使用 `weights_only=True` 加载。未完成的模型可以继续上传或删除；已被引擎引用的模型需先删除对应自定义引擎。模型文件就绪不代表合成成功，应先试听。

`speech_test` 只接受引擎、文字、声线和语速，始终生成 24 小时临时文件，不进入素材库，不修改作品；传入仓库参数会被拒绝。`works_speech` 才将正式配音保存到作品和对应仓库素材库。外部服务可返回 WAV 或 MP3，文件类型经内容验证。原 `speech_test` 附带 repo/project 的旧调用应改用 `works_speech`（平台内部为 `speech_generate`）。

远程 MCP 提供 `frame_engines_list/save/delete/local`、`frame_models_list` 和 `frame_speech_test`；短试听直接返回 MCP 音频，超过 8 MiB 返回临时下载信息。API 令牌和 CLI 使用相同操作。引擎列表隐藏密钥。容器 AI 使用 `node scripts/work-tool.mjs engines|engine_add|engine_test|speech`；`engine_add` 只添加新自定义配置，不能覆盖已有配置；`engine_test` 将试听放在当前任务作品的 `.cache/speech/`，`speech` 才生成素材。后台 AI 不获得管理员 API 或其他任务文件权限。

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

作品预览在构建时生成压缩分段音频，首播与冷跳转按需加载当前位置；原始文件、SF2 音色与生成器仅用于正式导出和原始模式。服务端继续支持 Range、条件缓存和文本压缩。

成功导出保留 7 天，失败任务产物保留 14 天，可手动删除；最新有效预览、有效审片链接、下载和 Releases 上传期间的文件受保护。清理每分钟执行有界批次，导出不会自动进入素材库。Releases 标签绑定导出所用的源提交，需先把该提交推送到作品分支。浏览器本地 WebM 导出需保持标签页打开，服务器 MP4 导出可后台继续。

## ChatGPT 的 MCP OAuth

ChatGPT 添加远程 MCP `https://frame.nerviloom.com/mcp`，认证选择 OAuth，客户端 ID/密钥留空。通过动态客户端注册（DCR）和授权码 + S256 PKCE，跳转 FRAME 输入管理员密码并明确授权。访问令牌仅用于 MCP，一小时过期；刷新令牌旋转，授权最长 30 天。可以在「设置 → 访问设置 → OAuth 连接」撤销。

元数据：`/.well-known/oauth-protected-resource/mcp` 与 `/.well-known/oauth-authorization-server`。`resource` 必须精确为本站 `/mcp` URL。DCR 仅接受 ChatGPT 的 HTTPS 回调（稳定回调与 connector/oauth 的专属回调），不允许任意重定向。授权表单保留同源 Origin 校验，Referrer-Policy 使用 same-origin，CSP 只允许本站与当前已登记回调，避免浏览器将合法提交或回跳拦截。服务器保存令牌散列，拒绝代码重放、错误 PKCE、错误 audience、过期或撤销令牌；刷新令牌重复使用会撤销同一授权。修改环境变量中的管理员密码会撤销现有 OAuth 授权。原有 Bearer API Token 接入继续可用。

接口实现按 [OpenAI 官方认证文档](https://developers.openai.com/plugins/build/auth)；ChatGPT 账号侧最终添加连接需要用户在自己的 ChatGPT 界面完成。

## 4.1 预览与工作台状态

新预览使用构建期生成的压缩音频片段，构建可能比以前耗时，但只在修改后准备一次。生成进度由执行器写入独占工作目录，再持久化为任务状态并经 WebSocket 推送。已有作品升级后需要重新构建预览（运行时版本 6），源码及原始音频不变。开发时可设 `FRAME_PREVIEW_AUDIO=0` 验证原始生成器；线上默认开启。

语音引擎可单独删除配置；模型文件、已生成配音不随之删除。内置配置仅首次初始化，删除后重启不会重新创建，可在模型列表再次「添加为引擎」。GitHub 设备登录兼容镜像自带的 gh，待授权进程保持运行至完成或 15 分钟超时。

Dockge 的持久目录均在项目内：`./data` 为作品与运行目录，`./postgres` 为 PostgreSQL 18 数据，`./models` 为语音模型。升级旧部署需停止写入后完整复制原 named volume，保留所有权与权限，校验复制内容再切换挂载；不要用空目录直接替换现有数据库。

## 可靠性与运行状态

新增的部署参数示例在 deploy/.env.example；升级只补充缺少的项，不能覆盖现有 FRAME_MASTER_KEY。FRAME_DOMAIN、FRAME_PUBLIC_URL、FRAME_HOST_DATA 和 FRAME_PROXY_NETWORK 可配置，默认保留原部署。FRAME_HOST_DATA 必须与宿主机 data 挂载真实路径一致。

FRAME_TASK_CONCURRENCY 默认 2，允许 1–8；每个执行器仍受 4 GiB/2 CPU 限制，应根据主机容量配置。当前部署按单个控制器运行，不把多个 studio 副本当作水平扩容方式。FRAME_MIN_FREE_BYTES 默认 1 GiB，低于阈值时暂停新任务出队；不会清理作品、终止已有任务或将排队任务记为失败。设为 0 可关闭剩余空间阈值，但读取容量失败仍保守暂停。

设置 → 运行状态显示 Docker、语音服务、排队与最长等待、待恢复发布、磁盘容量和迁移版本；统计缓存 30 秒。目录统计有时间/条目上限，未完成会显示“至少”，不把逻辑文件大小冒充实际磁盘占用。/healthz 保持轻量存活检查；/readyz 分别检查执行依赖及空间，只返回 ready/degraded，不公开内部详情。

数据库在 HTTP 服务启动前执行 server/migrations 中的版本化事务迁移，通过数据库锁串行执行并保存 SHA-256。已应用脚本被修改或数据库版本高于应用时拒绝启动。以后增加迁移文件，不改历史文件；已有旧数据库先以幂等基线纳入版本管理。迁移或回退仍须先备份，不能仅凭语法检查宣称生产迁移通过。

执行完成与结果发布分开：publishing 表示正在保存，连续发布失败进入 publish_failed。正式工作区与恢复副本不会自动清理，同作品继续修改会被阻止。处理错误后在后台任务中点“重试保存结果”，或调用 task_retry_publish；该操作复用原结果，不重新请求 AI。

备份创建、完整性校验和只读恢复检查见 [备份与恢复](BACKUP-RESTORE.md)。统一测试入口与发布门禁见 [验证说明](VERIFICATION.md)。
