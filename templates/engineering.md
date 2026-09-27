# {{PROJECT_TITLE}} · 工程说明

工程 id：`{{PROJECT_ID}}`。本项目的修改只允许发生在 `projects/{{PROJECT_ID}}/`。

- `project.ts`：静态元数据，`scene.ts`：绝对时间场景。
- `audio.ts`：可选实时生成音轨示例，在元数据配置 audioTracks 和 loadAudio 后启用。
- `public/`：运行素材，URL 为 `films/{{PROJECT_ID}}/`，assets.json 和 waveforms.json 属于本项目。
- `production/`：原始源文件、参数与来源/许可证。
- `scripts/`：专属工具；`tests/`：单元/浏览器测试。
- `exports/`、`.cache/`：忽略的生成结果和临时文件。

依赖由工作台统一维护；本工程不修改共享配置、引擎、UI 或其他工程。场景/音频接口见根 docs/AUTHORING.md。

```powershell
pnpm project:check {{PROJECT_ID}} --strict
pnpm project:scope {{PROJECT_ID}}
pnpm posters --project {{PROJECT_ID}}
pnpm render {{PROJECT_ID}} --width 1280 --fps 30
pnpm frame {{PROJECT_ID}} --frame 150
pnpm exec playwright test --project {{PROJECT_ID}}
```

检查命令只读；封面命令覆盖本工程封面，视频/单帧默认拒绝覆盖已存在输出。导出保存到本工程 exports/。新增专用脚本请在此记录输入、输出、命令与覆盖行为。
