# Paseo 原生工作流与提供商设置验收（2026-10-02）

## 验收范围

主开发环境的独立测试数据库和临时作品，使用实际 Frame HTTP 应用、PostgreSQL、已安装的官方 Paseo 0.10.2 daemon / 完整 WebUI，以及发布候选使用的两个受限上游补丁。测试提供商实现原生 Codex app-server 标准输入输出协议，执行本测试作品的实际文件与 Frame 工具操作；不调用付费模型。

Frame API 服务保留正常 API 提供商准入、密码登录、会话鉴权和 HMAC 作品工具授权。仅本测试的 PaseoManager / PaseoPublication 使用本机执行对象，验证 worker 为实际公共入口；独立 PostgreSQL ControllerLease 为真实控制锁。这不是生产 Docker 沙箱隔离或生产切换验收。

## 实际完整工作流

`tests/server/paseo-workflow-browser.test.mjs` 最终 attempt8，1/1 通过、0 失败、0 跳过，TAP 用时 31.58 秒。机器日志：`.cache/paseo-integration/native-workflow-attempt8.log`。

1. 真实密码登录，在当前作品打开完整官方 WebUI，使用官方当前 agent 路由和原生发送按钮。
2. 实际不可变冻结消息与只读源码参考进入原生提供商，保存精确 provider / model 选择。
3. 原生提供商会话收到本作品 Frame 工具令牌和选中的 API 凭据；未继承 Frame master key、服务数据库地址或测试数据库地址。
4. 真实 `work-tool context / assets / preview`：只能看本仓库素材，外部仓库同字节素材不泄漏；预览返回当前原生 agent 身份。
5. 实际修改主工作区源码，依次通过 scope、structure、project-tests、project-types、runtime。Runtime 使用真实画面与有限音频探测。
6. 实际 TaskPublication / ApplyProject 按候选快照发布到权威源码，源码 hash 与不可变候选一致。平台结果状态显示准确的候选 revision 摘要。
7. 官方 SDK 实际创建受管理 Git 工作树并发送原生消息，工具与实时预览精确指向其 checkout。工作树修改保持隔离，主工作区候选数不增加。
8. 实际 `works_restore` 恢复修改前 Git 版本，源码内容逐字节恢复；原生会话 timeline 仍保留此次完成记录。
9. 浏览器 `pageerror` 为空。

Frame AI dock 属于官方 compact 输入布局，Enter 按官方设计换行；测试点击真实 `Send message`，保持原生快捷键语义。

## 初次联调与资源回收

attempt1–7 的失败日志保留，不计作成功证据。初期修正仅测试夹具的全局桌面模式、createApp 返回 DTO、默认打开的 AI dock 与重复按钮定位，以及结果状态文本/原始与带执行位 hash 区别。attempt6 已完成真实五项校验与应用，attempt8 补齐工作树、撤销与原生记录验收。

夹具统一按 browser、app、实际自有 supervisor、独立数据库和临时目录顺序收尾。setup 失败遗留的 attempt1 独立数据库和精确临时目录已回收，记录位于 `.cache/paseo-integration/native-workflow-attempt1-cleanup.json`。最终只读自有资源审计见 `.cache/paseo-integration/owned-final-cleanup.json`；没有操作生产、其他测试数据库或用户作品。

## 提供商设置与旧偏好

最新 Studio 正式候选 bundle 下，provider-settings-browser 单目标 1/1 通过、0 跳过、0 失败，用时 8.54 秒。日志：`.cache/paseo-integration/provider-settings-final.log`。测试使用独立 UUID 数据库和 59487 端口，保留提供商实际发现、手工模型、同步、使用中删除阻止、旧历史保留等原有断言。旧聊天偏好控件退役后，浏览器旧 localStorage 的 defaultSelection / favorites 仍与原值深度相等，不伪造迁移或清理。

## 限制

原生模型目录清空/恢复的实际 SDK 与共享准入回归由根代理的独立目标提供。此记录不声称已实现旧 provider 原生 session 导入，也不声称物理麦克风、原生 Windows、生产切换或生产沙箱全覆盖。8.1.1 数据库独立增量迁移兼容证明见 [对应记录](paseo-additive-811-compatibility-20261002.md)。
