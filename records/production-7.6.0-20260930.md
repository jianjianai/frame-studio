# Frame Studio 7.6.0 生产发布验收

日期：2026-09-30（UTC）。生产：https://frame.nerviloom.com 。

## 发布身份与范围

- 冻结源码：`c115a225df9563d85dae5cd7e3d35fc744572e31`，标签 `v7.6.0`。
- Studio、Controller 与任务执行器统一使用 `ghcr.io/jianjianai/frame-studio/app:7.6.0@sha256:87aff79606c810a9d09a4094be58364e7be6096c1c3b92c0da636dcc4b9130d6`。
- [正式发布](https://github.com/jianjianai/frame-studio/releases/tag/v7.6.0)；[发布 CI](https://github.com/jianjianai/frame-studio/actions/runs/36727909735)。源码、Windows、统一验证、App/Speech 镜像与发布作业全部成功。
- 包含已审查合并的访问设置、作品回收站永久删除、工具版本更新、作品库交互和 Codex 账号模型列表改进。五个原分支与工作树已清理；保留无关性能工作树。
- Windows 安装包 `FrameStudio-v7.6.0-win-x64-Setup.exe`，发布校验文件 SHA-256：`5e932ef742d8327b002388bebd085cdae6655f20192fe643a079593457d79bd8`。

## 发布前验证

- 统一 CI 门禁通过。单元测试 83 项通过；服务端 220 项通过、2 项跳过、0 失败；Windows 安装与工作台验证由独立 Windows 作业完成。
- OVH 冻结源码实际 HTTP MCP、平台 CLI 和固定 Docker 执行器 Canvas / Remotion 回归：2 项通过、0 跳过，约 72.45 秒。
- 本地候选镜像严格 Remotion 回归通过；正式 GHCR 镜像 doctor 和完整 Remotion 回归再次通过，1 项、0 跳过，约 159.7 秒。
- 正式镜像验证使用断网、只读根目录、非 root、2 CPU、4 GiB、PIDs 512、64 MiB shm，涵盖 DOM/Sequence/FrameScene、反向寻帧、视频与帧率转换、混合音轨、实时播放、WebM、截图、分段导出恢复、FLAC 与分轨。

## 生产切换

切换前活动任务为 0。9 项迁移标识与校验和在旧镜像、新镜像和生产数据库之间完全一致。仅更新生产 `.env` 的 `FRAME_VERSION`，重建 Studio 和 Controller；Compose、凭据和其他配置保持一致。Speech 保持 7.3.2，PostgreSQL及两个开发服务的容器身份和启动时间均未改变。按当前约定未进行数据库转储或作品、素材、模型备份，未删除旧镜像。

Studio 和 Controller 均 healthy。公开 `/healthz` 为 7.6.0 与上述完整 revision，`/readyz` 200，未登录 `/api/me` 401。

## 线上功能验收

- 真实公开 React / WebSocket 页面：作品库列表与排序、回收站全局数量（3）、工具指定版本弹窗、提供商与模型设置、移动端访问设置均通过；移动端无横向溢出，浏览器错误为空。截图已实际查看。
- 作品元数据版本为完整 SHA-256；OAuth 列表隐藏已撤销授权。Codex 0.158.0 与 Claude Code 2.1.283 保持原安装版本，官方最新版本检查正常；未执行 CLI 升级、永久删除或账号认证更改。
- 生产 MCP 89 个工具，版本 7.6.0，包含 `frame_works_purge` 与 `frame_works_empty_trash`。临时验收令牌已撤销。
- 6 个当前作品全部刷新到 previewVersion 11 并通过真实浏览器加载、跳转、播放、暂停：`paper-wings`、`work-39d8b371`、`tiny-seed`、`work-8644ea78`、`the-learning-machine`、`sunny-rail`。
- 12 份大于 10 MiB 的素材首尾各 16 bytes Range 请求均为 206，内容与源文件一致。
- 9 条作品记录及源码校验、44 条素材记录前后一致。未新建验收作品或素材；最终活动任务为 0，验收令牌为 0，浏览器错误为空。

## 证据与清理

服务器 `/opt/frame-release-7.6.0-20260930/` 保留冻结源码、构建与拉取日志、`ci-result.json`、`candidate.json`、`candidate-doctor.json`、`candidate-features.log`（实际完整 Remotion 测试）、`candidate-features.exit`（0）、`local-regression.log/exit`（0）、`deploy-summary.json`、`migration-compatibility.json`、生产前后元数据与源码哈希快照、`production-check.json`、`production-previews.json`、`production-browser.json` 和 `final-summary.json`。

线上完整验收 session `session-e72cb8a3fc2e4184c24e1b15` 与最终核验 `session-515028f2bc40cb59c6bef2e5` 均退出 0。首次验收驱动未安装仅在 HTTP 应用注册的 OAuth 操作，返回 Unknown operation；补齐验收脚本的 OAuth 注册后重新执行通过，未改变生产代码或放宽断言，原日志保留。候选启动曾因宿主日志重定向权限失败，改为 root 范围重定向后正常运行。

本次专用 tmpfs PostgreSQL 容器 `frame-release-760-postgres` 和网络 `frame-release-760-tests` 已删除。未删除数据卷、生产数据、旧镜像或其他任务的资源。本记录为发布后的文档提交，不改变冻结生产源码。
