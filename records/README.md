# 修改记录、报告与审查

本目录集中保存仓库公共维护的过程文档。使用指南、接口与工程规范见 [docs/](../docs/)，工程说明见各视频 README。

| 记录 | 内容 |
| --- | --- |
| [2026-09-28-mcp-usability.md](2026-09-28-mcp-usability.md) | 结构化检查、操作锁反馈与恢复、图片兼容回读、完整项目权限 |
| [2026-09-28-mcp-launcher.md](2026-09-28-mcp-launcher.md) | Windows 双击启动 MCP、首次配置与真实启动验证 |
| [2026-09-28-remote-mcp.md](2026-09-28-remote-mcp.md) | 远程 HTTP、内置 OAuth/Bearer 授权、环境配置与 Cloudflare 命名隧道 |
| [2026-09-28-ai-production.md](2026-09-28-ai-production.md) | 单项目隔离、冻结导出、CLI/MCP 共用编辑/审片/验收、Worker PCM 与旁白流程 |
| [2026-09-28-animation-mcp.md](2026-09-28-animation-mcp.md) | 本地 MCP 编辑服务、项目边界、事务恢复、预览与导出任务验证 |
| [2026-09-28-audio-seek-optimization.md](2026-09-28-audio-seek-optimization.md) | 后段预加载、过期请求撤销和分批状态推进；未运行回归 |
| [2026-09-28-streaming-audio.md](2026-09-28-streaming-audio.md) | 首次播放改为按需分段生成配乐，保留原采样与混音设置；未运行回归 |
| [2026-09-28-browser-audio-migration.md](2026-09-28-browser-audio-migration.md) | 原采样接入浏览器、音乐目录迁移与首页封面修复；按要求未运行最终回归 |
| [VERIFICATION.md](VERIFICATION.md) | 初始工作台交付验证 |
| [DEMO-POLISH.md](DEMO-POLISH.md) | 三个 Demo 的精修修改记录 |
| [DEMO-DELIVERY-VERIFICATION.json](DEMO-DELIVERY-VERIFICATION.json) | Demo 视频交付的机器核验结果 |
| [PROJECT-AUDIT-2026-09-28.md](PROJECT-AUDIT-2026-09-28.md) | 工程代码与文件操作审查 |
| [BROWSER-EXPORT-VERIFICATION.md](BROWSER-EXPORT-VERIFICATION.md) | 逐帧浏览器导出与 AI 工具验证 |
| [music-render-report.json](music-render-report.json) | 目录迁移前的历史配乐测量汇总 |
| [legacy-music/](legacy-music/README.md) | 旧公共采样许可与素材归属 |
| [MUSIC-PRODUCTION.md](MUSIC-PRODUCTION.md) | 旧版采样配乐制作记录 |

这些文件记录各自当时的状态，历史结论、路径和检查数量不代表当前版本。

视频专属记录存放在本项目的 records 中，继续遵守项目目录边界：

- [风的邮差](../projects/paper-wings/records/README.md)
- [日光快线](../projects/sunny-rail/records/README.md)
- [一颗种子的四季](../projects/tiny-seed/records/README.md)

新过程文档建议按 `YYYY-MM-DD-topic.md` 命名。项目 README 只提供入口，不重复粘贴修改日志、验证结果和审查结论。未提交的导出附属 JSON、测试截图等仍保存在原有忽略的输出目录，需长期保留的结论再整理到 records。
