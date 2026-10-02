# Paseo 完整界面嵌入与 Frame 前端迁移验证（2026-10-02）

## 范围与来源

- 目标版本：Frame Studio 8.2.0。此记录是前端与官方嵌入层的交付证据；正式镜像、整栈与生产验收由发布流程另行记录。
- 上游：getpaseo/paseo，稳定版 0.10.2，提交 `919c737c1948c5a16220307403a82e90d3e27ea0`。
- `0001-frame-embed.patch`：42 个官方应用源文件，SHA-256 `f71bfdbcacf767aab488b1012698d5e2d07319362e120b659dbd20bcba01ce91`。不包含服务器补丁 0002、Frame 官方插件的单独复制源或私有测试夹具。
- 完整官方 WebUI 保留模型选择器、时间线、权限、用户问题、终端、Git、原生工作树与自身偏好界面。Frame 提供作品范围 bootstrap、父页面作品上下文和业务校验/应用状态。

## 行为

- 统一构建供所有作品使用；同源 `/paseo/<workId>/` 下连接 HTTP/WS、下载与深层路由。连接失效不能改连其他主机。用户与作品共同隔离客户端持久化命名空间。
- MessagePort 仅接收绑定 iframe WindowProxy、父页面同源、作品 ID 与 nonce 均正确的连接，限制消息尺寸、并发和生命周期；替换、退出时关闭旧 port 并取消未完成调用。
- 现有对话与新对话的首条发送均冻结原生 messageId、模型/提供商、输入、附件与画面引用，随后使用官方消息收据。重试保留原冻结内容；模型选择的服务器原子检查和收据恢复由服务器补丁处理。
- 当前对话可选择工作区预览；原生工作树明确显示需合并回主工作区后应用。主工作区的校验结果、失败原因、重试与应用使用服务器候选证明，发送确认本身不代表已应用。
- 素材与配音建议附加到原生输入框，不自动发送；引用保留画面时间、范围和对应源码版本。Paseo 的作品工具入口定位真实校验/应用区域，不跳到旧记录。
- Frame 旧记录保持只读，包括旧结果、诊断、Markdown 与版本恢复入口；未验证导入的旧 provider session 不伪装成可继续的原生会话。用户可把旧记录摘要附加到新的原生对话。
- 删除旧自研聊天、搜索、模型选择与专用偏好控件。保留真实提供商配置和默认模型卡片。旧 localStorage 偏好数据没有删除，也没有声称自动迁移到 Paseo。
- Frame 主色与作品工具保留；隐藏/工具切换不卸载原生 iframe。窄屏关闭入口、焦点约束、展开/恢复、素材按钮最小 44px，引用区有高度上限和滚动，避免多素材挤掉原生内容。

## 实际验证

| 范围 | 结果 | 证据（忽略目录） |
| --- | --- | --- |
| 官方应用单元目标 | 7 文件 / 70 项通过 | `.cache/paseo-integration/tests-embed.log/.exit` |
| 官方应用类型与 owned lint | 均 exit 0，lint 0 warnings/errors | `typecheck-embed.log/.exit`、`lint-embed.log/.exit` |
| 官方完整 WebUI 导出 | exit 0 | `web-export.log/.exit`；主包 `index-20170cd3f3462fbaa74b1e37b13719de.js` |
| 公开 maintainer runner | 真实运行 1/1 通过，exit 0 | `maintainer-embed.log/.exit`、`official-embed/results.json` |
| 公开 runner 的真实官方 iframe | 现有对话与新对话各恰好 1 个模型 turn，均收到冻结画面附件；错误数组、越界请求数组为空；深层刷新、离线重连、390px、外来 iframe/wrong nonce 拒绝 | `official-embed/official-iframe-desktop.png`、`official-embed/official-iframe-mobile.png` |
| Frame 生产父桥 | 1/1 通过 | `parent-targets.log` 中独立 Paseo bridge 子测试（该次组合运行的旧 live fixture 失败已修，下一行记录修后目标） |
| Frame live Creation | 修后 1/1、exit 0 | `live-creation-target.log/.exit` |
| Frame 作品 UI | 28/28、exit 0、errors [] | `workspace-host-final.log/.exit`、`workspace-host-final/results.json` |
| Canonical bridge 与目标 JS 语法 | generated schema check / node --check 通过；模板 6 个精确导入映射全部命中 | 最终只读检查输出 |

作品 UI 检查使用真实 Frame UI、播放器和浏览器 WebM 导出，加显式 API/MessagePort 边界夹具；它不声称替代完整官方原生界面的测试。原生界面由上述 maintainer runner 实测；安装后的正式整栈 Frame/Paseo 浏览器门禁由独立测试负责。

## 构建映射

公共 `integrations/paseo/frame-plugin/**` 精确复制到 pinned 上游 `plugin-examples/frame/**`；补丁应用于 exact upstream commit。上游构建依次使用 `npm run build:app-deps`、`npm run build:server` 与 `PASEO_FRAME_EMBED=1 CI=1 npm run build:daemon-web-ui`。完整 WebUI 输出为 `packages/server/dist/server/web-ui`，服务器入口为 `packages/server/dist/scripts/supervisor-entrypoint.js`。公开 maintainer 命令：`node scripts/test-paseo-embed.mjs --source <pinned-patched-source>`；仅创建并最终清除自己的 UUID ignored `.cache` 测试目录，不常驻依赖私有 clone 路径。

## 前端文件

- `studio/paseo-chat.jsx`
- `studio/paseo-chat.css`
- `studio/paseo-bridge.js`
- `studio/work-history.jsx`
- `studio/work-dock.jsx`
- `studio/accounts.jsx`
- `studio/model-settings.jsx`
- `studio/creation.jsx`
- `studio/preview-session.js`
- `studio/live-preview-session.mjs`
- `studio/agent/AgentTurn.jsx`
- `studio/agent/AgentQuestion.jsx`
- `studio/agent/agent-navigation.js`
- `tests/ui/review-flows.mjs`
- `tests/ui/review-layout.mjs`
- `tests/ui/review-fixture.mjs`
- `tests/ui/review-persistence.mjs`
- `tests/ui/review-work-tools.mjs`
- `tests/ui/review-timeline.mjs`
- `tests/ui/workspace-review.mjs`
- `tests/ui/paseo-boundary-fixture.mjs`
- `tests/server/paseo-bridge-browser.test.mjs`
- `tests/server/live-preview-creation-browser.test.mjs`
- `scripts/test-paseo-embed.mjs`
- `integrations/paseo/tests/official-embed.test.ts`
- `integrations/paseo/build-shared.mjs`
- `integrations/paseo/frame-plugin/client/bridge.ts`
- `integrations/paseo/frame-plugin/client/main.tsx`
- `integrations/paseo/frame-plugin/index.client.tsx`
- `integrations/paseo/frame-plugin/shared/bridge.ts`
- `integrations/paseo/frame-plugin/shared/bridge.mjs`
- `integrations/paseo/patches/0001-frame-embed.patch`

### 删除

- `studio/work-chat.jsx`
- `studio/agent/AgentSearch.jsx`
- `studio/model-picker.jsx`
- `studio/ai-preferences.js`
- `tests/server/agent-reading-browser.test.mjs`
- `tests/server/agent-workbench-browser.test.mjs`
- `tests/server/ai-workbench-browser.test.mjs`
- `tests/server/chat-retry-browser.test.mjs`
- `tests/server/v5-workflow-browser.test.mjs`

## 正式候选门禁发现：桌面返回对象契约（2026-10-02）

正式候选的 `local-desktop.test.mjs` 暴露真实产品错误：`createApp` 返回的原生服务位于 `paseo.manager`，桌面入口却访问不存在的顶层 `paseoManager`，导致状态与退出保护返回 500。此测试使用真实 `startLocalApp` 和 SQLite，不是缺少 fake services 的夹具问题。最小修复仅把 `server/local-app.mjs` 的活动读取改为 `services.paseo.manager.active()`，保留原生活动保护。

在原三项桌面测试中增加实际创建 manager 的退出断言；一次捕获真实 manager 时委托原 `active` 并立即恢复，然后仅在该实例的方法模拟原生 Agent、终端、待确认权限与未知活动。每一种都要求状态 active=1、unsaved=0、退出返回 409，恢复空活动后原先正常退出和发布失败恢复断言仍成立；不跳过、不降低任何原有门槛。

实际 Node `v24.21.0` 在 `frame-development` 执行 `node --test --test-concurrency=1 tests/server/local-desktop.test.mjs`：3/3 通过、0 skip、exit 0，总时长 2393.06ms。日志 `.cache/paseo-integration/local-desktop-node24.log`、`.exit`。本次仅修改桌面入口这一处、该目标测试和本记录，没有改源归档、发布脚本或生产。
