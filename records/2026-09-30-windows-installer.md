# Windows 安装程序与统一标签发布 · 7.4.1

## 要求与实现

- 正式 Windows 交付改为 `FrameStudio-v7.4.1-win-x64-Setup.exe`，不再以应用 ZIP 作为安装入口。
- 使用 NSIS 3.12，编译器从官方来源获取并校验固定 SHA-256。评估过的 Inno 7.1 二进制带商业使用许可限制，因此未采用。
- 每用户安装，无需管理员权限；安装向导显示依赖进度，创建开始菜单和 Windows 卸载入口，完成页可直接启动托盘。
- 安装时自动准备工具/Python、使用客户端 pnpm 按锁文件安装 Node 依赖、检查浏览器。缺少 Edge/Chrome 时安装专用 Chromium。
- 组件缓存、pnpm store、用户数据与程序版本目录独立；正常更新复用缓存，工具/Python 检查失败时定向修复。Python 的 stderr 警告不等同于失败，使用进程退出码判断。
- 依赖准备失败不切换旧版快捷方式和注册信息；程序运行期间禁止安装/卸载。卸载只移除程序，对依赖目录联接仅移除链接，保留缓存和用户数据。
- 本机 AI CLI 仍由用户安装和登录；未安装显示不可用。没有自动安装 AI CLI、下载语音模型或引入 Docker 本地运行依赖。

## 自动发布

`.github/workflows/release.yml` 为唯一 `v*` 标签入口，固定标签源码提交并核对 package 版本。Windows 构建/真实安装测试与完整服务端门禁通过后，调用 images.yml 发布镜像，再发布 GitHub Release 的 EXE 与 SHA-256。

新镜像采用仓库命名空间 `ghcr.io/jianjianai/frame-studio/app`、`ghcr.io/jianjianai/frame-studio/speech`，由仓库 GITHUB_TOKEN 首次创建和关联权限。历史独立包的 read_package 拒绝与用户提供的 fine-grained PAT 权限限制不通过写入个人令牌来规避；旧包、旧镜像与生产栈保留。新路径同步到 Compose 和文档。

## 本地验证

- `tests/desktop/bootstrap.test.ps1`：工具安装、单组件修复、无源归档缓存复用、SHA-256 错误拒绝通过。
- `node --test tests/desktop/dependencies.test.mjs`：实际 pnpm 安装失败重试、版本更新复用、仅拉取新增包通过。
- `pnpm typecheck:platform` 与前端/托盘/NSIS 构建通过。
- 安装测试使用独立应用目录和测试数据目录；不覆盖用户正式安装。验证真实安装、已安装工作台、失败安装/修复、注册/快捷方式、正常修复不下载、不重装 pnpm 依赖、卸载保留数据。
- 实测发现 Windows PowerShell 5.1 在重定向时会将 Python stderr 警告转为 ErrorRecord；已改为直接读取子进程输出并判断退出码，避免误报与多余下载。

## 发布状态

`v7.4.0` 标签触发 [36709639900](https://github.com/jianjianai/frame-studio/actions/runs/36709639900)。Windows 编译成功，空缓存真实安装发现从 pwsh 继承的 PSModulePath 导致 Windows PowerShell 5.1 无法找到 Get-FileHash，因此门禁失败，未创建正式 Release、未发布镜像。终止失去发布用途的剩余作业。保留失败标签，不移动到修复提交。

7.4.1 的安装/卸载/启动依赖准备脚本显式使用当前 PowerShell 自带模块目录；本地人为清空调用者模块路径后，5.1 实际依赖准备与 SHA-256 命令通过。安装器回归测试也加入错误调用者模块路径，保证该环境差异持续覆盖。

待记录本次标签触发的 GitHub Actions、实际 Release 资产摘要及两个镜像摘要。当前记录不能作为远端发布成功或生产切换证明。
