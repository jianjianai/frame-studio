# Frame Studio 7.3.2 生产发布验收

## 来源与发布

2026-09-30 拉取远端 main 至 `1ae5dac`。当前正式版本为 7.3.2，标签源提交为 `2490ae2ac9ac161d90c3cabb4dfe8bea8cc6481e`。main 相对标签仅有 CI 配置和过程记录变化，应用源码一致。本次使用正式标签的冻结快照构建，保留既有 Windows 发布，不移动标签或重新标记不同源码。

工作台与控制器从 7.1.2 升级至 7.3.2，语音服务从 4.2.0 升级至 7.3.2。

| 镜像 | 已发布标签 | 生产固定摘要 |
| --- | --- | --- |
| ghcr.io/jianjianai/frame-studio | 7.3.2、sha-2490ae2ac9ac161d90c3cabb4dfe8bea8cc6481e | sha256:702fa756c6e9dde8786592e4fa5899bcfd2037c9ef73b38cfba3d4c78d8d6f3d |
| ghcr.io/jianjianai/frame-speech | 7.3.2、sha-2490ae2ac9ac161d90c3cabb4dfe8bea8cc6481e | sha256:9592bfe0ce6c16e27e0a87cc74c0b13f3b7e569dd74f06a2aad20c70baf832cb |

GitHub Actions 的旧镜像作业因包的 Actions 权限失败，本次使用服务器现有发布凭据完成本地构建和上传，两个版本标签与提交标签均成功推送。没有复制或输出凭据。Actions 包访问权限问题未在本次修改，后续自动上传仍需处理该独立配置问题。

## 发布门禁

- 复核 [完整发布检查 36704146248](https://github.com/jianjianai/frame-studio/actions/runs/36704146248)：verify 作业成功，日志确认实际检出 2490ae2；核心 83、MCP 85、服务端 190 项通过，失败 0。Linux 的 Windows 专用用例由独立 Windows 发布工作流执行，可选 GeneralUser 音色资源用例保持明确跳过。
- [Windows 发布 36702699424](https://github.com/jianjianai/frame-studio/actions/runs/36702699424)已成功，原生 SQLite/进程模式、作品创建、预览、单帧/MP4 导出及安装器验证见[原记录](2026-09-30-runtime-downloads.md)。本次未重新构建 Windows 包。
- 本地构建镜像的只读、断网 `film doctor --json` 通过，Node 24.21.0、Chromium、FFmpeg、依赖与工具可用。Codex 0.158.0、Claude Code 2.1.283 版本实测符合冻结工具链；完整 CI 中的真实 CLI 进程使用确定性模型协议夹具，没有调用生产付费 AI。
- 生产数据库九项迁移的 id/checksum 与候选及旧工作台镜像完全一致。可回退至 7.1.2 / 1d06113，保留旧语音镜像 4.2.0。未执行数据库迁移、备份或数据归档。

## 语音模型持久化

旧语音服务的内置模型在镜像内部，原持久化 models 目录为空。若直接切换不携带权重的新镜像，三个已有模型会变成未安装。

本次仅将既有运行模型复制至新版使用的持久目录，先临时目录复制和逐文件 SHA-256 比对，再发布目录；没有覆盖已有目录、重新下载模型或删除旧镜像内容。

| 模型 | 文件数 | 字节数 | 校验 |
| --- | ---: | ---: | --- |
| Kokoro / builtin | 12 | 331,419,943 | 全部一致 |
| MeloTTS / melo | 21 | 191,246,368 | 全部一致 |
| Piper / piper | 361 | 96,544,066 | 全部一致 |

候选语音镜像在无网络条件下读取上述持久目录，三模型实际合成 WAV 成功：Kokoro 162,044 字节 / 24 kHz，MeloTTS 170,028 字节 / 44.1 kHz，Piper 68,140 字节 / 22.05 kHz。已有模型的下载请求返回 installed，未重新下载。生产界面显示三模型已安装，试听按钮可用，实际 Kokoro 中文试听生成并加载为可播放音频。

## 生产验收

- 生产地址：https://frame.nerviloom.com 。公网 /healthz、/readyz 为 200；未登录 /api/me 为 401。healthz 返回 version 7.3.2 和正确冻结提交。
- Studio、Controller、Speech 与 Postgres 四个常驻服务均 running / healthy。只切换前三项，Postgres 和开发容器身份/启动时间未变；Compose 内容及非版本配置保持原样，仅更新两项版本变量并固定摘要。Dockge 没有添加一次性检查服务。
- 7 个作品记录及源码哈希、28 项素材记录在发布前后及最终复核时一致；无剩余活动任务。
- 五个未删除作品的预览全部成功重建，previewVersion 11，当前源文件与运行时指纹一致：paper-wings、work-39d8b371、tiny-seed、the-learning-machine、sunny-rail。
- 全部五个作品通过真实生产浏览器的目标时间跳转、播放推进、暂停检查，页面运行错误为空。另核对模型选择器、素材面板、草稿保留、390px 移动端抽屉和设置页；桌面、移动端、语音结果截图已实际查看。
- 生产远程 MCP 发现 87 项工具；workspace_context 版本 7.3.2，创建默认值、工具说明、作者参考、每个作品上下文及 models_list 正常。模型下载按现有公开接口通过 API 验证，三个请求均返回 installed。临时 MCP 令牌已撤销，浏览器会话已注销。

验收脚本的初次探针错误地将 MCP 的 `{items: [...]}` 当作数组，并假设模型下载在 MCP 暴露。核对现有协议后修正探针：MCP 验证模型列表，下载使用 GUI/API 的公开接口；最终两项验收退出 0。初次失败日志保留，未修改正式源码或弱化生产断言来隐藏失败。

## 证据

宿主机证据目录：`/opt/frame-release-7.3.2-20260930/`。包括冻结 source、两镜像构建/推送日志、模型文件校验、断网合成、迁移兼容性、部署摘要、发布前后数据指纹、当前预览、MCP 与浏览器 JSON、截图和探针初次失败日志。开发仓库忽略目录中的原始 CI 日志为 `.cache/production-7.3.2-ci.log`。

候选检查容器使用 --rm，生产临时检查脚本与截图已清理。本次记录提交仅补充发布证据；生产应用始终固定上述正式标签源码和镜像摘要。
