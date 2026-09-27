# 风的邮差 · 工程说明

工程 id：`paper-wings`。视频制作仅修改 `projects/paper-wings/` 内的文件。

- `project.ts` 和 `scene.ts`：静态元数据、绝对时间场景。
- `public/poster.webp`：本作品封面。
- `public/assets.json`、`public/waveforms.json`：独立素材和波形索引；浏览器路径为 `films/paper-wings/...`。
- `audio.ts`：两条生成音轨入口；[`music/`](music/README.md) 保存可编辑乐谱与动作音效。
- `production/ASSET-LICENSES.md`：当前素材来源；旧版采样音乐的 MIDI、事件快照与许可归档在 `records/legacy-music/`。
- [records/](records/README.md)：修改记录、验证报告和审查文档；旧采样母带测量报告为 records/music-render-report.json，不能代替当前浏览器实现的实测结果。
- `tests/`：后续工程专属测试自动发现；现有跨作品回归在根 `tests/` 中。
- `exports/`、`.cache/`：本项目输出、临时文件，不提交。

本项目插画在 `public/art/`，专用重建脚本为 `scripts/prepare-art.mjs`。

依赖由根 package.json / pnpm-lock.yaml 管理，本项目不能修改共享引擎、播放器或其他项目。场景和多音轨接口见 [AUTHORING](../../docs/AUTHORING.md)。本项目使用 `audioTracks` 的 `music`（原采样配乐）和 `foley`（动作音效）两条生成音轨，可以分别调节增益或静音。浏览器首次使用时在内存生成，随后跳转、重播和导出复用；乐器素材在 public/music，已有音频素材可直接配置文件音轨，无需重建整首配乐。

`pnpm project:check paper-wings --strict` 和 `pnpm project:scope paper-wings` 是只读检查。`pnpm posters --project paper-wings` 覆盖本项目封面。 `pnpm assets --project paper-wings` 只覆盖本作品生成插画及相关索引。

`pnpm render paper-wings --width 1280` 导出 MP4；`pnpm frame paper-wings --frame 150` 导出从 0 开始的第 150 帧 PNG。结果保存在本项目 exports/，默认拒绝覆盖，明确 --force 才替换。
