# 7.3.2：按需安装与依赖复用

## 实现

- Windows 主程序包包含应用、前端、托盘和锁文件；工具与 Python 运行环境在首次启动时下载并进行 SHA-256 校验。
- Node 依赖由客户端 pnpm 12.4.2 按锁文件安装，使用持久化 pnpm store；没有 node_modules 发布归档。依赖标识包含锁文件、声明、安装配置及 Node/pnpm 版本，排除应用版本号。
- 同依赖更新直接复用已安装目录；依赖变化使用新目录并复用 store。未成功安装不写完成标记，失败重试由 pnpm 修复。托盘退出终止自己启动的安装进程树。
- Windows 与服务器语音镜像不携带模型权重。推荐模型提供主动下载、进度、失败重试、安装完成后试听及移除；自定义 Kokoro 上传保留。模型放在持久化 models 目录。
- 服务器部署模板更新到 7.3.2；工作台与语音服务需一起升级，旧语音服务没有下载接口。本记录不代表生产服务器已切换。

## 新执行的验证

- 空 pnpm store 真实安装：resolved 380、reused 0、downloaded 380、added 381，pnpm 12.4.2 成功结束。另一份应用目录再次启动直接复用工具、Python 和 pnpm 安装目录。
- pnpm 安装集成测试通过：本机临时下载源返回 404 时安装失败且不写完成标记；恢复后成功；仅更新应用版本不访问下载源；新增开发依赖显示 reused 1 / downloaded 1，保留旧版安装。测试显式设置 production=true，确认工作台需要的开发依赖仍安装。
- Windows PowerShell 5.1 安装器测试通过：工具归档安装、依赖联接、删除下载源后缓存复用、损坏 SHA-256 拒绝安装。
- 从轻量包与新安装的 pnpm 依赖执行原生工作台测试，3/3 通过：SQLite 状态、免密码与同源保护、作品创建、单帧渲染、MP4 导出、预览构建、推荐模型 API。
- Edge 浏览器模型列表测试 1/1 通过：不自动下载、未安装时禁止试听、点击下载、进度刷新、完成后试听可用、移除后恢复下载按钮。
- Python 模型测试 3/3 通过：空模型启动、自定义 Kokoro 上传、下载失败与重试、文件校验失败清理、推荐模型移除。
- 从独立缓存的 Python 启动包内语音服务通过：初始三个模型均未安装，合成返回 409，启动不需要权重。
- 真实 Piper 可选下载：下载并校验 82,038,311 字节归档，完成后生成 108,588 字节 WAV；重启后模型仍就绪。
- 前端构建、平台类型检查、C# 托盘编译、git diff --check 通过。

## 公共检查与限制

- 已执行 pnpm verify：核心 Vitest 93/93 通过；MCP 83 通过、2 失败、1 跳过。失败为 Windows 文件符号链接权限 EPERM，以及弱网测试出现 62 次重复缓冲。原始日志：.cache/verify-7.3.0.log。
- 停止并发安装后单独复查弱网测试，2/2 通过：stallSamples=0、duplicates=0；断网冻结后恢复、freezeDrift=0、errors=[]。日志：.cache/verify-7.3.0-preview-network.log。未据此改写首次全量检查结果。
- Windows 符号链接权限问题仍使该次全量检查未通过，后续 PostgreSQL 全量检查未运行。Windows 专项检查与包内原生运行检查已通过。
- 本次没有实点 Windows 托盘菜单，也没有调用真实付费 AI 生成；没有切换生产服务器。Kokoro/Melo 没有重新执行完整真实下载与合成，Piper 已验证真实链路。

## 独立 Windows 环境发现的问题

7.3.0 标签的 GitHub Windows 检查发现原生执行器停在 Edge 版本探测：Windows GUI 浏览器的 `--version` 可能启动并保持浏览器进程，导致首次渲染卡住。本机已有浏览器进程时未复现该问题。7.3.1 改为读取 Windows 可执行文件的 ProductVersion，不启动浏览器，并为探测设置 15 秒上限。保留失败标签，使用新的修订版本发布。

## 发布环境与验证补充

- [Windows 自动发布](https://github.com/jianjianai/frame-studio/actions/runs/36699200079)通过：原生工作台测试 3/3、安装器与 pnpm 增量安装检查均成功；已自动上传 v7.3.1 ZIP 和校验文件。实际下载复核 SHA-256 为 `028f19297ad9c040dc4549588634eeae2387a0bd6f9ba698467c3d99961f7bfc`，大小 2,272,920 字节。
- 首次 Linux 发布检查：核心单测 83 通过，MCP 85 通过、0 失败；服务器 186 通过、1 失败、5 跳过。唯一失败为无 GPU runner 的 Three.js WebGL 上下文创建，日志 `.cache/ci-server-7.3.1.log`。模型下载与 PostgreSQL 语音检查已通过。
- CI 使用 [Chromium 官方支持的 SwiftShader CPU 驱动](https://chromium.googlesource.com/chromium/src/+/e102d7cb9bd8a6b610ca361cd9f07a7d434e9af6/docs/gpu/swiftshader.md)重新运行相同图形检查，参数仅进入 CI 浏览器启动脚本。
- 第一次 SwiftShader 重跑仍无法创建 WebGL 上下文（运行 36700575690）；随后为可信测试夹具显式启用软件 WebGL 回退，并在完整检查前新增 WebGL2 创建预检，失败时记录渲染器与上下文错误。没有跳过或降低混合引擎验收断言。
- 7.3.2 修正发布检查的环境配置：Linux runner 安装与候选镜像相同版本的 Codex 0.158.0、Claude Code 2.1.283，原生 CLI 对接本机模型协议夹具，无需生产账号。Linux 只允许额外跳过具名的 Windows 原生工作台用例，该用例在 Windows 发布工作流强制执行；所有服务器集成用例缺少条件仍拒绝发布。
- [7.3.2 Windows 自动发布](https://github.com/jianjianai/frame-studio/actions/runs/36702699424)通过；下载正式 ZIP 复核大小 2,275,034 字节，SHA-256 `f1a937d779ad241b67f40187a87c7ac7337380e7905bab1e0b0ad86fcc412bc2`。确认无 node_modules、Python、工具或模型目录，依赖标识仍为 `pnpm-dependencies-win-x64-be8a53c82596ba9d289f`，工具与 Python 组件摘要没有变化。
- WebGL 定向诊断记录：普通 runner 用户预检通过，root 运行混合用例时 Vulkan 初始化报错（36702959194）。CI 改为生产执行器相同的 UID/GID 1000，工作区和测试 HOME 使用该身份；单独授予公共浏览器路径读取权限，结束后恢复 Actions checkout 所有权。第一次切换用户因 runner 父目录缺少穿越权限失败（36703306263），该权限已在 CI 准备阶段显式设置。
- 为测试用户设置独立 XDG 配置、缓存与运行目录后，[混合图形定向验收](https://github.com/jianjianai/frame-studio/actions/runs/36703898735)通过：60 秒、720 帧、6 个混合图层、链接音频、逆向跳转、取消、浏览器 WebM 与 CLI MP4。两种导出的画面平均绝对差 2.058125，音频 RMS 0.020872 / 0.020828；没有修改图形测试或降低断言。此前缺少可写浏览器配置目录导致 Crashpad 启动失败的运行 36703556940 也保留。
- [7.3.2 完整发布检查](https://github.com/jianjianai/frame-studio/actions/runs/36704146248)的 verify 作业通过：核心单测 83/83；MCP 85 通过、0 失败、1 个可选采样内容跳过；服务器 190 通过、0 失败，仅跳过 Windows 专用用例和可选 GeneralUser 音色资源用例。Windows 专用用例已由独立 Windows 作业验证。Codex 0.158.0 与 Claude Code 2.1.283 真实进程通过双向提问、同回合继续执行和会话续接，工作台原生 CLI → 人工回答 → 实际构建/发布 → 通知与 diff 的链路也通过。应用检出固定标签 v7.3.2，提交 `2490ae2ac9ac161d90c3cabb4dfe8bea8cc6481e`。日志 `.cache/ci-release-7.3.2.log`。
- 服务器镜像上传尚未完成：同一运行的 speech 镜像构建成功，GHCR 推送返回 `permission_denied: read_package`；矩阵的 studio 上传随之取消。GitHub API 显示两个已有私有包的 repository 关联均为空，需要在包设置的 Manage Actions access 中授予 `jianjianai/frame-studio` Write 权限。浏览器工具两次返回 request-header policy 加载失败，无法代为进入该设置；已请用户完成此一步。权限设置完成后可仅重跑失败作业，复用成功的验收作业。未切换生产服务器。
- 用户提供凭据后的实测：细粒度 GitHub 令牌身份接口返回 200，但两个包的 API 与 GHCR tags/list 均返回 403（令牌交换 200 不代表已获包权限）。当前 gh 登录凭据可读取旧镜像配置，确认两包早已有正确的 `org.opencontainers.image.source` 标签；因此不能靠重复添加来源标签解决既有包的 Actions 授权。仍需上述包权限设置。凭据没有写入仓库、发布包或 Actions secrets。
- 手工重跑镜像发布时，验证与构建均检出请求版本对应的标签，校验 package.json 版本，并使用该标签实际提交的 revision 标注镜像；CI 配置修复不会把新 main 代码错误标为已有版本。
- 旧测试缓存的批量清理被自动审批策略拦截，仅返回 blocked by policy，未提供具体理由；缓存已保留。
