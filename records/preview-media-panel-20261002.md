# 素材模式右侧面板改造与验证（2026-10-02）

## 范围与协作

基线为主远程 main `61719e317ef507d14ded6db07345867a61eacfc2`。与聊天「说明项目预览工作方式」协调，素材模式 UI 与音频修复共同进入待冻结的 8.2.4。此记录仅证明界面实现和本次聚焦验证，发布、完整门禁及生产接受由该聊天统一完成，不能据此认定本次 UI 已上线。

## 用户可见行为

- 工作台左侧功能区新增「素材模式」，在共享右侧工作面板展开；窄屏经「工具」菜单进入。
- 三种模式为原生单选卡片，提供适用说明、明确的当前选择与键盘导航。
- 完整缓存显示字节/文件进度、持久保存数量、剩余存储、未完成文件、警告及错误。下载完成、播放准备、真正就绪沿用引擎已有语义。
- 取消、继续缓存/重试播放准备、清理持久缓存位于面板；清理提供二步确认、默认保留及 Escape 返回。
- 导出与未结束的操作锁定变更；切换模式/收起面板沿用同一 iframe。独立预览仍有原模式工具栏。
- 低高度左栏可滚动；手机打开面板优先聚焦当前选择，关闭返回触发入口，模式操作临时禁用后恢复失去的键盘焦点。

## 状态与生命周期

`src/ui/preview-media-bridge.ts` 从现有预览 client 读取权威状态及执行操作，没有复制缓存状态机。工作台通过 `studio/preview-media-session.js` 订阅和发送操作。

双方校验当前窗口来源、每次 iframe 附着/加载的 channel 及请求 ID；旧响应不能更新新连接。安装后的 ready 通知弥补 React effect 晚于 iframe load 的情况，无常驻轮询。进度快照每 250ms 最多发送一次，命令与导出状态立即通知。异步操作锁保留到原操作结束，清理监听器及定时器不影响其他预览。

## 本次验证

在既有隔离 `frame-development` 容器执行，未使用生产数据库、生产素材、麦克风或付费模型：

| 验证 | 本次结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| studio Vite production build，自有 `.cache/frontend-validation/preview-media/studio-dist` 输出 | 通过，最终构建 2536 modules |
| `preview-media-bridge-browser.test.mjs` | 6/6 通过，无 skip |
| `preview-media-panel-browser.test.mjs` | 1/1 通过，无 skip |
| 原有 `live-preview-creation-browser.test.mjs` | 1/1 通过，无 skip |
| 新测试语法、指定文件格式化、`git diff --check` | 通过 |

桥接测试使用真实 opaque sandbox iframe 和真实 live-preview shell，覆盖窗口/通道隔离、导出期间四类操作拒绝、异步清理并发拒绝、节流、dispose、首次完整缓存尚未创建 Player 的握手/取消、工作台隐藏顶栏及独立页保留控件。

面板测试使用真实 Creation、生产消息桥及真实浏览器；后端与缓存 client 是受控夹具。覆盖桥延迟 300ms 安装、Player-ready 前的控制、命令延迟 150ms 的连续键盘导航、缓存准备/取消/重试/清理、偏好保存、iframe 身份保持、导出锁定、旧 channel/非当前窗口消息、AI 草稿切换、手机 focus trap/Escape 和短屏滚动。原有 Creation 测试进一步确认实时修订与草稿切换保留播放时间及控制状态。

测试夹具开发中修复了过宽路由、Vite 二次依赖优化引发的重载，以及检查焦点环前未等待节流状态的问题；最终有效运行全部通过。没有将这些失败轮或历史结果当作新的成功证据。

## 视觉检查

已实际查看本次生成的截图：

- `.cache/frontend-validation/preview-media/desktop-ready-1440.png`
- `.cache/frontend-validation/preview-media/desktop-1440.png`
- `.cache/frontend-validation/preview-media/desktop-1440x500.png`
- `.cache/frontend-validation/preview-media/mobile-390.png`
- `.cache/frontend-validation/preview-media/mobile-274.png`

桌面保留左栏/右面板结构；390px 与 274px 无横向溢出；长路径和诊断可折行；500px 高度左栏入口可达、面板可滚动至缓存操作。截图中心画面为受控测试占位，不能作为真实作品画面或生产部署证据。

测试服务与浏览器已关闭，自有测试 Vite 缓存已清理；截图和本次隔离构建保留在忽略目录供发布审查。未使用 WSL、未进行备份或生产切换。
