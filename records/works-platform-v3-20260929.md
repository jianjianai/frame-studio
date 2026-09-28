# FRAME 3.0.0 作品平台实现与验收（2026-09-29）

本次按用户确认的作品管理方向重构，允许破坏兼容。平台与作品各自独立仓库，移除旧工作台首页和嵌套导航。部署目标为 frame.nerviloom.com，Dockge 栈 /opt/stacks/frame，使用 GHCR 版本镜像。

## 已实现

- 作品库及统一创作页，封面、分类、状态、搜索、复制、可恢复回收站、版本快照和恢复前备份。
- 默认作品存储、多个 GitHub 内容仓库、LFS，同步素材与源码；拒绝将平台源码仓库导入为内容库。
- 全局素材上传、标签与来源、作品引用、未引用筛选；依据作品 public 文件哈希核实引用，含回收站作品。
- 本地中文 Kokoro、外部语音引擎、兼容模型上传、测试与作品配音。
- 单管理员登录、加密连接配置、API/MCP 令牌；Codex/Claude 独立升级与持久后台会话。
- 任务范围素材/语音工具；AI 在自己的副本里工作，完成后检测冲突并应用，自动生成预览。
- AI 专用浏览器 URL、FRAME_AI 控制台接口：帧、分镜、片段播放、混音、PNG/SRT/WebM 导出、进度与取消。浏览器计算不创建服务器渲染任务。

## 内容迁移

独立私有作品库：https://github.com/jianjianai/frame-works 。初始提交 `cec6bd62cd79a83b18fe9dfc61bc460fb21c0c3e`。包含 paper-wings、sunny-rail、tiny-seed、the-learning-machine。247 个作品文件已通过远程重新克隆（含 LFS）逐字节哈希比对。平台代码树删除这些内容，原始用户工作区及其 beyond-the-chat 未跟踪作品保持原样。

## 验证结果

- 原生 WSL 文件系统中，不含作品内容的干净源码：`pnpm verify` 全链通过。TypeScript、63 项单元、65 项 MCP、7 项服务端测试（真实独立 PostgreSQL，零跳过）、引擎和平台构建。
- 真实 Docker 部署 `scripts/works-smoke.mjs`：作品创建/复制/回收恢复、版本编辑恢复、素材引用、中文语音、隔离播放器、移动端、页面关闭和控制器重启后的 MP4/PNG 导出通过。
- `scripts/ai-browser-smoke.mjs`：无登录 Cookie 的私密 URL，正反向确定帧与分镜、片段播放、PNG 下载、1 秒 WebM（12 帧且含音频）、取消导出通过；任务数量保持不变。
- `scripts/agent-bridge-smoke.mjs`：使用 fixture CLI 的真实工作容器验证素材导入、中文语音、任务令牌不能调用管理员 API、完成前不修改原作品、完成后自动预览。此项没有调用外部模型。
- 容器加入 Noto CJK 字体，支持服务器导出的中文字幕。常规视口截图检查播放器及创作页布局；Chromium 对跨源 iframe 的 fullPage 截图有裁切现象，视口截图和 DOM 尺寸正常。

## 明确边界

真实 Codex/Claude 上游、外部语音 API 和任意用户上传的语音模型需配置后验证，当前没有用户服务密钥。

旧作品完整回归没有全部通过：初次 23 项浏览器回归有 8 项失败，含 WSL 软件渲染下的采样音频实时缓冲/暂停时序、旧作品独立音效和旧 R2 静态页动态 TS 导入测试。已修正播放器切换与画质保持测试；针对播放器复验 6/7 通过，剩余 sunny-rail 在高负载下暂停时序失败。没有修改或删除作品内容来掩盖这些结果。

内容相关回归移入独立 `pnpm verify:content`，需要临时复制作品仓库；平台测试使用自己的夹具，不再依赖私人作品。平台验收通过不表示所有历史作品压力回归通过。

## 发布与部署

发布标签 v3.0.0；Docker 镜像为 ghcr.io/jianjianai/frame-studio:3.0.0 和 frame-speech:3.0.0。GitHub Actions 此账户此前因计费额度拒绝启动，使用服务器从明确提交构建并推送 GHCR 的方式发布，仍保留自动镜像工作流。

切换前备份数据库、Compose、环境配置和原内容根目录；保留仓库 UUID，将其内容切换为独立 frame-works，设置默认内容库。镜像拉取后实际重建容器，再验证版本、健康、登录、作品素材、浏览器播放/客户端导出和预装中文语音。最终镜像摘要及生产检查结果以 GitHub Release 和本次交付的 production-v3.json 为准。
