# Paseo WebUI Windows 构建修复 · 2026-10-02

## 确认的失败与修改边界

v8.2.0 的不可变源提交 `37e846faa5e6976d917a4a7ee1334fe757244fa2` 在真实 Windows CI 已完成官方 app-deps/server 编译，随后官方 `scripts/build-daemon-web-ui.mjs` 的 `spawn("npm", ..., shell:false)` 报 `spawn npm ENOENT`。失败日志 `.cache/paseo-820/windows-failed-job.log`。不移动或覆盖该标签，修复由后续 8.2.1 候选验证。

新增 `0003-windows-web-build.patch` 仅修改官方该脚本。先校验绝对路径、`npm-cli.js` 文件名与普通文件，依次采用 `npm_execpath`、Node 安装旁 npm、POSIX lib 布局和模块解析 fallback；最终直接由 `process.execPath` 执行，保留原始构建参数、cwd、环境继承及非零退出行为，不使用 shell。找不到合法 CLI 明确失败。

官方来源保持 Paseo v0.10.2、提交 `919c737c1948c5a16220307403a82e90d3e27ea0`。源码声明新增第三份补丁，README 增加用途说明。0001 和 0002 内容不变。

## 可复核的验证

### Linux Node 24.21.0

- `paseo-web-build.test.mjs` 新 3 项与原 `paseo-build.test.mjs` 2 项：5/5 PASS、0 skip、exit 0，1306.59ms。日志 `.cache/paseo-integration/windows-web-build-node24-final.log`、`.exit`。
- 新公开测试从 0003 完整上下文重建官方脚本，验证 preimage SHA-256 `772b9ced6a2d50a6a460111b67f8d06c4c02da6a9769a2270928513205fc90d4`。真实 Git fixture 验证 apply、reverse check、严格源码 proof 和调用者 index 不变；拒绝漏补丁或额外修改。fixture 自有仓库固定 `core.autocrlf=false`，保持字节校验。
- 实际 Node 执行修复后的完整脚本，使用受控 npm-cli，证明中文/空格路径、原参数和环境、gzip/Brotli 产物及失败退出；拒绝错误文件名、相对路径、目录，验证模块 fallback 与完全缺失时明确失败。
- 实际 pinned 上游 clone 对照三份补丁与当前公共插件通过严格源码校验，调用者 index 不变。日志 `.cache/paseo-integration/windows-web-build-source-proof.log`、`.exit`。初次检查如实保留 UID 导致的 Git ownership 拒绝及旧 `shared/bridge.mjs` 副本拒绝；只对该检查进程配置精确 safe.directory，并按既有构建复制规则同步这一个私有插件副本后通过，未修改公共 canonical 文件或全局 Git 配置。
- 上游该脚本 targeted lint：0 warnings、0 errors；采用官方 npm format:files 格式化。

### 实际 Windows Node 26.8.2

主代理在 Windows 本机使用 v8.2.0 的公开 build-paseo/local-tools，以及精确下载校验后的新 patch/source/test 运行公开新 3 项目标：3/3 PASS、0 skip、exit 0，2442.3185ms。覆盖实际 Git apply/reverse/index/source proof、中文/空格 Node 执行、参数/环境/非零退出及 fallback。最终日志 `.cache/paseo-windows-821-pass.log`，SHA-256 `d34562f517f992acf024d0f8ab61c7487455f6abedd12175afdbc9e457f0a15c`。

首轮 2/3 PASS 的唯一失败来自机器 `core.autocrlf=true` 导致 fixture CRLF，与执行功能无关；修复自有 fixture 的换行配置后重跑通过，保留 `.cache/paseo-windows-821-first.log`。本机自有 ignored fixture 清理遭自动批准审查阻止，未绕过删除规则；主代理保留目录和日志。

## 冻结身份与限制

- 0001 SHA-256：`f71bfdbcacf767aab488b1012698d5e2d07319362e120b659dbd20bcba01ce91`。
- 0002 SHA-256：`19cc19b7d625e65296c2000c49db01c7b94f096f290f91fd53bab8d3ec1f2d05`。
- 0003 SHA-256：`5b6970a90be5c797d800d30384cbc225875e713c68416f4da97275cca6774133`。
- source.json SHA-256：`dce4e894300895f669bcda2804450e77fcbc80a661ccc5105004b77a1c3009f0`。
- 新测试 SHA-256：`a986343f70a86c01ec5bfe76153e9c4f0e67f8742f7306e1749ddc5374e82692`。

这轮证据证明跨平台脚本与严格构建身份校验，不等于完整官方 WebUI 编译、原生应用 GUI 或新发布 CI 已通过；后续候选由发布方建立及验收。未修改已发布归档、标签或生产环境；各目标测试内部临时目录按 finally 清理，本机外层 fixture 按前述保留。
