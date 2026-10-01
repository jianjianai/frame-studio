# 官方 Paseo 集成维护

源版本、仓库及提交以 `source.json` 为准。FRAME 分发官方 WebUI 和 daemon，并通过可审查的补丁接入作品上下文，不另写原生会话、消息投递或 agent 引擎。

- `0001-frame-embed.patch`：完整官方 WebUI 的同源嵌入、路由、桥接与首次消息适配。默认构建不受 FRAME 嵌入模式影响。
- `0002-frame-session-env.patch`：Codex 使用当前 session hook 环境；原生消息回执恢复后核对 FRAME 冻结选择，并串行协调模型切换和发送。
- `frame-plugin/`：官方插件 API 的作品指令、当前 session 凭据与生命周期提示。`shared/bridge.ts` 是唯一共享契约源。
- `runtime/`：独立锁定的原生包依赖；不混入作品依赖。
- `PASEO-LICENSE`：上游版权与 Apache 2.0 许可证；第三方组件保留各自许可证。上述补丁包含 FRAME 对上游的修改。

## 构建与安装

```sh
node integrations/paseo/build-shared.mjs --check
node scripts/build-paseo.mjs
```

默认构建在本仓库 `.cache/paseo-build/` 拉取固定提交，应用声明的补丁，复制公共插件，用官方脚本构建 server 和完整 WebUI，再安装到 `.cache/paseo-runtime/`。

已有源码可用 `--source=<absolute-path>`。构建会用独立临时 Git index 对照固定提交加声明补丁，拒绝额外源码、漏掉补丁或不同插件副本；不会改该 checkout 的 Git index。

```sh
node scripts/build-paseo.mjs --bundle-only --output=<bundle-path>
node scripts/build-paseo.mjs --prebuilt=<bundle-path> --runtime=<runtime-path>
node scripts/build-paseo.mjs --prebuilt=<bundle-path> --runtime=<runtime-path> --check
```

准备包内 `source-proof.json` 记录提交、每个补丁、完整插件与依赖锁以及编译文件 SHA-256。安装与复用均核对真实编译文件内容。损坏的环境在检查时明确失败，在修复安装时重新安装。桌面安装沿用已有安装锁；运行环境按准备包身份复用，不覆盖作品的原生 home 或历史。

Docker 的 `/opt/paseo` 和桌面所选 `paseo` runtime 由相同构建入口生成。WebUI 共用静态文件，作品各自持有 daemon、草稿与原生 home。配置热更新走官方 `patchDaemonConfig`，不写正在运行的配置文件或重启回合。

用户使用方法与工作树边界见 [docs/PASEO.md](../../docs/PASEO.md)。测试与发布证据放根 `records/`。
