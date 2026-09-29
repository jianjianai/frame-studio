# {{PROJECT_TITLE}} · 工程说明

工程 id：`{{PROJECT_ID}}`。文件修改范围：`projects/{{PROJECT_ID}}/`。

默认工程是空白合成，不预选 2D 或 3D 引擎。可以按需求选择已安装框架、组合素材，或使用项目内的程序化场景。本文只说明工程结构、接口与工具。

| 路径 | 用途 |
|---|---|
| `project.ts` | 静态元数据、尺寸、时长、音轨与加载入口 |
| `scene.ts` | 绝对时间场景入口，可注册项目内多个场景模块 |
| `visual.json` | 默认合成的权威片段数据；通过 loadVisual 加载；显式引擎模板可无此文件 |
| `audio.ts` | 可选生成音轨，在 audioTracks/loadAudio 配置后启用 |
| `public/` | 运行素材，URL 为 films/{{PROJECT_ID}}/；assets.json、waveforms.json 属于本项目 |
| `production/` | 原始材料、参数、来源和许可；brief.md 保存需求 |
| `records/` | 修改记录、验证报告、审查结论 |
| `scripts/`、`tests/` | 本项目的工具和测试 |
| `exports/`、`.cache/` | 忽略的导出结果和临时文件 |

可以使用共享依赖和公共引擎接口：Canvas、PixiJS、Three.js、Babylon.js，视频/图片/图像序列、Lottie，GLB/glTF 加载、后处理，多轨文件音频与 Web Audio 生成音频。完整能力以 `pnpm film composition engines --json` 为准。复杂逻辑可保留在项目代码中；公开参数可接入合成片段。不修改共享引擎、UI、配置、依赖或其他项目；缺少公共能力时提出维护需求。

场景可同步或异步初始化；提供 canvas、render(time)、dispose()，可选 prepareFrame(time,{signal})。公共播放器负责绝对时间和取消；初始化失败及退出释放本实例资源。参数与时间映射见根 [docs/COMPOSITION.md](../../docs/COMPOSITION.md)，音频、资源和输出接口见 [docs/AUTHORING.md](../../docs/AUTHORING.md)。这些接口要求不限定创作方法或风格。

```sh
pnpm --silent film context {{PROJECT_ID}} --json
pnpm film composition {{PROJECT_ID}} --json
pnpm film composition engines --json
pnpm film check {{PROJECT_ID}} --strict
pnpm film scope {{PROJECT_ID}}
pnpm film dev {{PROJECT_ID}}
pnpm film frame {{PROJECT_ID}} --time 0
pnpm film storyboard {{PROJECT_ID}}
pnpm film render {{PROJECT_ID}} --width 1280
```

GUI、CLI、MCP 对合成数据使用同一套编辑操作与 SHA-256 版本检查；冲突时重新读取。检查只读；封面命令更新本项目封面；视频/单帧默认拒绝覆盖，输出保存在本项目 exports/。浏览器导出使用当前混音，命令导出使用元数据音轨设置。

更多工具见 [docs/AI-WORKFLOW.md](../../docs/AI-WORKFLOW.md)。语音提供商、项目内配置、私有凭据位置及接口见 [docs/SPEECH.md](../../docs/SPEECH.md)。
