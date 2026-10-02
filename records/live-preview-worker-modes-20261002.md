# 实时预览 Worker 素材模式回归修复 · 2026-10-02

## 实际问题

正式候选的 `v8-live-preview-browser-proxies.test.mjs` 发现压缩模式 Worker 的 `previewAssetUrl()` 返回原始 MP4，而不是同内容 SHA-256 的 `video/<hash>/preview`。浏览器缓存控制器在 Worker bootstrap 和更新消息中只保留“是否 cached”，将所有非缓存模式写成 original；主线程模式与服务器代理逻辑正确。

## 修改

- `src/engine/live-preview-cache.ts`：Worker bootstrap 保留完整 original/compressed/cached 模式；新建和存活 Worker 共用同一状态消息生成函数。仅 cached 模式启用 Blob 素材映射，随机控制消息标识及 opaque sandbox 保持原有边界。
- `tests/server/v8-live-preview-browser-proxies.test.mjs`：保留原有 frozen proxy、原素材、导出保护及经典 Worker 边界断言；追加同一存活 Worker compressed → original → compressed，实际请求均为 206、128 字节，代理/原素材切换保留同一内容 hash。

## 本轮验证

- frame-development 中 Node 24，原 V8 实际浏览器目标：1/1 PASS、0 skip、exit 0，总耗时 11774.97ms。证据 `.cache/paseo-integration/v8-worker-modes-target.log`、`.exit`。
- 同环境 `preview-cache-browser.test.mjs`：1/1 PASS、0 skip、exit 0，总耗时 3880.20ms。覆盖 opaque iframe 缓存持久化、Range、媒体、Worker、Worklet 及阻断网络后的版本更新。证据 `.cache/paseo-integration/worker-cache-target.log`、`.exit`。
- `pnpm typecheck`：exit 0。证据 `.cache/paseo-integration/worker-typecheck.log`、`.exit`。
- 仅本轮文件格式化与 diff whitespace 检查；未写 studio-dist、未修改 local-app 已冻结文件、发布归档或生产环境。测试自身 finally 关闭浏览器/服务并清理专属临时目录。

此验证证明当前工作区修复；旧候选归档仍不可变，发布方需据新源码建立后续候选。
