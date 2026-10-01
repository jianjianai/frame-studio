# Paseo 管理与凭据独立审查

## 范围与所有权

- 审查 `server/paseo-manager.mjs`、`server/paseo-credentials.mjs`、`scripts/build-paseo.mjs`、相关 native entry/Windows bootstrap 与已安装官方 `@getpaseo/* 0.10.2` 源码。
- 本审查代理只新增 `tests/server/paseo-manager.test.mjs`、`tests/server/paseo-credentials.test.mjs`、`tests/server/process.test.mjs`、`tests/server/paseo-build.test.mjs` 和本记录；产品修复由对应文件负责人实施。
- 使用独立临时 SQLite 数据库、原生 home、草稿目录和临时端口；没有调用生产、数据库全套或公开提交。临时服务与目录由 fixture 清理。

## 已发现并复核修复的具体问题

| 问题 | 真实证据与处理 |
| --- | --- |
| 官方工作树不在主 draft 内 | 官方 `getPaseoWorktreesRoot` 默认 `paseoHome/worktrees/<project hash>`；实际 SDK 创建 `home/.paseo/worktrees/<hash>/test-native-worktree`。负责人补独立 native 路径映射、实际文件路径及 Git 双向注册校验。 |
| 主 cwd 空相对路径被拒绝 | `confinedAsync(...,'')` 触发 `Invalid path`。负责人对主根直接使用已验证的 draftRoot，保留 realpath 身份检查。 |
| 专用 Git 元数据被公共文件 helper 拒绝 | `confinedAsync(current,'.git')` 触发公共禁止 `.git` 的规则。负责人增加限定大小、regular/single-link、NOFOLLOW、inode 身份的 Git 元数据读取，没有扩大公共文件 API。 |
| FRAME 工具总是作用于主 draft | 原 work-wide token 无具体 agent/cwd。负责人改 HMAC agent credential，返回实际 checkoutRoot。真实 worktree token 的 FRAME context 指向同一 checkout，错误签名拒绝。 |
| 新工作树缺依赖 | SDK 工作树执行 `node scripts/work-tool.mjs capabilities` 实际 `ERR_MODULE_NOT_FOUND: zod`。负责人为合法注册 checkout 配精确共享依赖链接；真实目录成功输出 schemaVersion 1 与完整 items。 |
| supervisor health 先于 WS ready | 健康 200 后实际 SDK connect 报 503。负责人在同启动 deadline 内重试 SDK/openProject，并释放失败 client。实际创建、停止和重开通过。 |
| 启动失败保留 native 子进程 | 原 catch 只 dropClient/state failed。负责人按 generation 回收实际进程/容器；目标故意注册失败后 process、client、endpoint、container 全部释放。 |
| 取消启动可能写回 ready/等完整 timeout | 负责人增加 generation/state 检查与 CAS；实际 spawn 后取消约 496ms 结束，状态保持 stopped，不重新 ready。 |
| 普通终端被误当 idle | 官方 tracker 初始未知，真实持续 Node 命令 activity 为 null；原 observe/cancel 漏掉。负责人复用 terminalBusy，将未知保守视为 busy，并正确处理 idle+needs_input。真实终端被观察、阻止闲置和取消。 |
| 等许可的 profile 未被视为活跃 | 官方 idle agent 也可有 pendingPermissions；原 profile filter 只取 running ids。负责人将等待许可纳入活跃列表；同 profile busy、其他 profile不误报的回归通过。 |
| Windows 路径分隔符不兼容 | `path.relative` 生成反斜杠会被公共 helper 拒绝；Git 元数据使用 `/` 与 `path.join` 不一致。负责人补相对路径转换与注册路径规范化；仅静态复核，本次没有实际 Windows native 接受。 |

## 凭据与资源证据

- 所选连接的 API 凭据由 session env 发放；launch record 没有 API key，公开 profiles 没有 key/endpoint。此前目标只覆盖该 resolver 的凭据，未覆盖父进程环境继承；后续新增审查与修复见下文。
- Official credentials 仅复制指定 regular credential file，目标 0600；来源 symlink 被拒绝；其他用户配置不跟随复制。
- 原选定 endpoint/auth generation 变化拒绝，不静默改用其他身份；同 agent 的可用模型调整仍允许。
- Native cwd、profile、agent 和 workspace 身份不匹配拒绝；actual Git worktree、嵌套 cwd、本地与 Linux容器路径映射通过；foreign registration 与链接逃逸拒绝。
- Idle/runtime 更新保留运行 agent、等待许可、终端、active schedule、正在验证/发布的候选以及分页不完整时的不确定性。
- 已检查 Docker 的 work/generation 标签校验及 CPU、memory、PID limit 声明；本次没有运行实际 Docker daemon admission/资源压力测试。
- Windows bootstrap 在整个安装期间持有 FileShare.None install.lock；实际 portable 参数使用 bundled pnpm.exe，无须增加第二套安装锁。

## 最终目标验证

在 `frame-development` Node 24 / root 身份运行：

```sh
node --test --test-concurrency=1 tests/server/paseo-manager.test.mjs tests/server/paseo-credentials.test.mjs
```

Remote session `session-27f1e5596ddac516d011de57`，exit 0：10/10 通过、0 skip，22.53 秒。真实 SDK 链耗时 10.63 秒；启动取消 0.50 秒；故意启动失败/回收 5.60 秒。4 个并发 ensure 只创建 1 个 daemon/client 身份；官方工作树、FRAME CLI、真实持续终端/取消、停止/重开及手工 source 保留均通过。`git diff --check` 通过。

## Builder 发现项与接受限制

以下问题已提交给负责人实施产品修复，最新目标验证结果见追加章节：

1. 显式 `--source` 时未验证 declared patches 已实际应用，proof 却记录其 hash；应验证 patches，并限定或记录真实 tracked source 差异。
2. 现有 runtime reuse/check 仅看 marker fingerprint 与两个文件存在，没有检查已安装 server/web 内容；损坏文件仍可能被视为 ready。应验证已安装内容，check 失败、install 修复。

本目标使用已安装官方 runtime，证明 manager/SDK/目录与进程行为；不替代最终 patched server 的真实 fake-provider session-env 链路、官方完整 UI 接受、Docker 候选镜像门禁或生产切换。没有声称实际 Windows native、生产物理麦克风或资源压力验收已经完成。最终发布与生产接受由发布负责人执行。

## 进程执行器新增验证

本代理另新增 `tests/server/process.test.mjs`；没有修改 root 所有的 `server/process.mjs`。发现并交由负责人修复：POSIX leader 已退出时仍需取消其存活进程组，不能因 leader exitCode 已设而提前返回。

在同一 Node 24 / root 环境独立运行，remote session `session-8d35b56912b35e5a521e7922` exit 0：4/4 通过、0 skip，0.775 秒。

- 实际 Node writer 分开写 UTF-8 字符内部的字节；raw probe 证实逐块独立解码会损坏。执行器 normal stdout、combined stdout/stderr、非零退出 stderr 均正确保留中文和多字节 emoji。
- AbortSignal 取消实际自有 child/孙进程；两 PID 都已不存在，没有以 zombie 仍存在替代消失断言。
- POSIX leader 先退出、孙进程继续持有 pipe 的实际情况仍能通过取消终止并返回原始 reason。
- 预先 aborted 精确返回 reason；spawn 调用数为 0。

测试在 Windows 平台会仅运行适用的通用取消/解码断言，POSIX group 专项声明为不适用；当前证据来自 Linux，不作为 Windows native proof。

## 最新实际目录同步与组合目标

Node 24 / root，remote session `session-bd5ae2388bbfe53674bc0de0` exit 0：

```sh
node --test --test-concurrency=1 tests/server/paseo-manager.test.mjs tests/server/paseo-credentials.test.mjs tests/server/process.test.mjs
```

15/15 通过、0 skip，31.28 秒。新增真实官方 SDK 动态目录专项耗时 7.22 秒：启用 profile 的新增、更名、模型替换、清空、禁用与删除均即时反映到官方 daemon config / model catalog；非 FRAME 的原生自定义 profile 保留。全过程 daemon PID、generation、serverID 和 SDK client 身份相同，没有重启；公开配置不含 API key 或私有 endpoint。其余管理、凭据和进程目标一并重新通过。

## Builder 源码与安装完整性目标

新增 `tests/server/paseo-build.test.mjs`，不调用 npm install。负责人已实施临时 Git index 的严格源码验证与安装内容 SHA 校验。

源码目标 remote session `session-4f1eb012444e03627128e887` exit 0：1/1 通过、0 skip，0.286 秒。使用真实临时 Git 仓库及真实 binary patch，验证合法 patched source、新增文件和复制的 plugin bytes；缺 patch、额外 tracked 改动、未声明 source、plugin 改动及错误 commit 都被拒绝；调用方 Git index 字节保持原样。

另一个安装目标已写入同文件，构造合法 source-proof / marker / server / web tree，随后验证同长度内容损坏、额外文件、缺失文件以及 prepared bundle 损坏必须拒绝，并 mock spawn 断言 check-only 从不调用安装。`0001-frame-embed.patch` 最终落盘后已运行完整 builder 目标，结果见下文。

最终 builder remote session `session-07e8f19db6bb5e436ab55d5d` exit 0：2/2 通过、0 skip，0.379 秒。匹配 marker 的合法 fixture 可复用；同字节长度 compiled server 损坏、额外或缺失 web 文件都被拒绝，恢复后可复用；prepared bundle 本身损坏也被拒绝。整个 check-only 目标 spawn 为 0，没有 npm 安装、公开 source 改动或 clone 改动。当前公共 patch `0001-frame-embed.patch` SHA-256 为 `f71bfdbcacf767aab488b1012698d5e2d07319362e120b659dbd20bcba01ce91`。

本轮管理/凭据/进程组合 15 项与 builder 2 项均通过，0 skip；四个新增测试文件语法检查与实际仓库 `git diff --check` 通过。以上是独立目标证据；最终公共 verify、patched daemon/UI 全链路、Docker 镜像门禁及生产接受仍由发布负责人执行。

## 后续父环境隔离与本机官方 CLI 认证复核

后续审查发现：local daemon spawn 原先继承整个 `process.env`，可能带入 FRAME master key、DB URL、其他 provider key 与 NODE_OPTIONS。负责人在 `server/paseo-manager.mjs` 改为 system/runtime allowlist，只保留 PATH、locale、Windows 系统路径、临时路径、proxy/CA 等运行配置，再显式提供作品专用 HOME、PASEO 控制与路径；平台服务和 provider 凭据不继承。

同时补充 `server/paseo-credentials.mjs` 的本机 official profile：只为选中的 Codex 或 Claude 会话发放该工具的本机环境认证，不给 daemon 或另一 provider；本机 key/endpoint 的身份 SHA 写入私有 launch record，内容不落盘，变化后 resume/refresh 拒绝并要求新会话。无本机 key 时保持原定向 official credential file 路径和 regular-file/0600校验，远端 Docker session 不采用桌面父环境认证。

独立读取 `.cache/paseo-integration/native-environment-target.log`：本轮 Node 24 manager/credentials **13/13 通过、0 skip，23.664 秒**。包括真实 SDK daemon、worktree/CLI、终端取消、generation重开、启动失败释放、动态profile和新增两项环境目标。它是新一轮批次，与先前 manager/credentials/process 的15项和builder2项分开记录，不能相加冒充一次完整suite。

本轮仅只读复核产品源码与测试/log并追加本记录，没有修改 manager/credentials，没有实际 Windows native或生产CLI账户登录验证。allowlist/本机官方环境目标证明已覆盖的代码和Linux测试范围，不声称支持任意未列入的CLI环境变量。
