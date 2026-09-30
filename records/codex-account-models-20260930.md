# Codex 官方账号模型同步与提供商体验

日期：2026-09-30。分支：`fix/codex-account-models`。基线：`fc1bf504087ca022c27f48e11b75032b3fae9233`。
独立工作树：`/home/agentdock/AgentDock/frame-studio-codex-account-models`。

## 结果

- Codex 官方账号登录完成、检查登录及设置页缺失/超过 24 小时的目录，自动从同一账号的 CLI 读取模型和能力参数；支持手动刷新。
- 使用 `app-server` 的 `account/read` 与分页 `model/list`；按工具返回值读取模型名称、说明、推理档位、默认推理档位和输入模态，缺失规格可由公共目录精确补齐。
- 不发送推理请求、不导出账号令牌；失败保留登录和模型目录。并发请求复用，写入检查配置版本与身份代次；保留默认模型、自定义名称、启停状态和手动覆盖。
- 新增 ChatGPT 账号模板及保存后直接登录。前端区分授权、账号确认和目录同步，提供设备码复制、成功反馈和失败重试。
- 设置页展示同步状态、来源、更新时间、参数标签和推荐模型；支持快捷设置默认模型。模型选择器展示关键参数，窄屏布局无横向溢出。

## 轻量验证

均通过：

1. `node --test tests/server/codex-model-catalog.test.mjs tests/server/provider-metadata.test.mjs`：12 项通过，约 0.8 秒；覆盖协议、分页、边界、脱敏、配置保留、并发及身份变化。
2. `node scripts/check-platform.mjs`：124 个文件语法与相对导入检查。
3. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.platform.json`：平台类型检查。
4. `node node_modules/vite/bin/vite.js build --config studio/vite.config.mjs`：Studio 构建通过，约 0.6 秒。
5. 隔离的真实 Chromium 执行 `tests/server/codex-account-browser.test.mjs`：1 项通过，约 4.2 秒；覆盖自动同步、失败重试、参数查看、默认模型、账号模板与登录进度，以及 1440/390/320 像素布局，未发生页面错误。
6. `git diff --check`：通过。

浏览器测试以模拟 WebSocket 协议运行；协议测试使用 CLI 替身，并核对已安装 Codex 0.158.0 生成的原生 JSON schema。未使用真实账号、业务数据库或生产服务验收；CLI 目录可能缓存，实际推理权限仍由创作请求确认。按用户要求未运行全量测试，也未合并、推送或部署。
