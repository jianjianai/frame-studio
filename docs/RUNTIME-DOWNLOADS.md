# 安装依赖与可选语音模型

Windows Setup.exe 只嵌入原生控制中心、安装向导、程序源码、前端和锁文件，工作台在默认浏览器打开。安装时自动从 GitHub 的 `windows-runtimes` Release 下载缺少的工具与 Python 运行环境，校验 SHA-256，再安装到 `%LOCALAPPDATA%\FRAME Studio\runtimes\<组件版本>`。下载使用持久化的 `.part` 文件续传，中断自动重试，完整安装包缓存于数据目录的 `downloads`。向导或控制中心显示下载量、速度与当前阶段，暂停后可继续。依赖检查通过后才安装应用和切换快捷方式。更新工作台复用相同组件版本；卸载程序保留缓存和用户数据。

工具组件包含 Node、Git、FFmpeg、pnpm，语音运行环境包含 Python 与语音依赖。构建时只发布不存在的版本化组件，已有组件不可覆盖。程序包中的 `desktop/runtime-manifest.json` 固定各组件的下载地址和摘要。

发布任务使用 `desktop/runtime-assets.ps1` 解析已发布组件的元数据。已有组件无需下载 ZIP 或准备 Python/FFmpeg 构建环境；组件版本变化时才安装所需构建工具并生成新组件。GitHub 元数据读取失败会明确终止，避免误判为组件缺失而重复构建。

GitHub 账号的浏览器授权需要 GitHub CLI。优先使用电脑上的可用 `gh.exe`，缺失时独立下载固定版本的官方 Windows ZIP 并验证 SHA-256，保存在数据目录的 runtimes 中。它与已有工具组件分别缓存，补齐 GitHub 授权工具不重下 Node、Git、FFmpeg 或 Python。

Node 依赖由客户端 pnpm 按 `pnpm-lock.yaml` 执行 `install --frozen-lockfile --prefer-offline`，不发布或下载 node_modules 压缩包。包缓存保存在数据目录的 `pnpm-store`，安装目录根据锁文件、依赖声明、安装配置及 Node/pnpm 版本生成标识。仅修改程序代码或程序版本时直接复用安装目录；依赖变化时在新目录安装，通过共享 store 复用已有包，只下载新增或变化的包。安装失败不写完成标记，重试时交给 pnpm 修复；旧版安装目录保留。

客户端需要完整的运行与开发依赖来编译作品、检查源码和导出。pnpm 使用 hoisted 布局，使多个任务通过目录联接共享同一份依赖。依赖安装遵循锁文件完整性校验和工作区已有的构建脚本许可，缓存目录与程序目录独立。安装向导会实际运行工具版本检查与 Python 导入检查；损坏组件重新下载安装，正常组件复用。不自动安装 Codex/Claude CLI，也不要求用户预装 Node、Python、Git、FFmpeg 或 pnpm。

服务器语音镜像与 Windows 程序均不包含语音权重。推荐模型在设置的语音引擎列表中按需下载，校验固定来源后原子安装到持久化模型目录。未下载的模型不可试听；下载失败显示原因并允许重试。已经安装的模型在升级程序或镜像后继续使用。自定义 Kokoro 模型仍可上传 config.json、model.pth 与声线张量并创建自定义引擎。

语音模型下载是用户主动发起的后台操作；启动工作台、健康检查和普通更新不会下载语音权重。
