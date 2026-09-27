# 一颗种子的四季 · 工程说明

工程 id：`tiny-seed`。视频制作仅修改 `projects/tiny-seed/` 内的文件。

- `project.ts` 和 `scene.ts`：静态元数据、绝对时间场景。
- `public/audio/tiny-seed.wav`、`public/poster.webp`：现有配乐与封面，迁移时保留原字节。
- `public/assets.json`、`public/waveforms.json`：独立素材和波形索引；浏览器路径为 `films/tiny-seed/...`。
- `score.mjs`：本作品的可编辑乐谱；`scripts/foley.mjs`：本作品动作音效。
- `production/music/`：MIDI、乐谱数据、测量报告、采样许可；`production/ASSET-LICENSES.md`：素材来源。
- `tests/`：后续工程专属测试自动发现；现有跨作品回归在根 `tests/` 中。
- `exports/`、`.cache/`：本项目输出、临时文件，不提交。


依赖由根 package.json / pnpm-lock.yaml 管理，本项目不能修改共享引擎、播放器或其他项目。场景和多音轨接口见 [AUTHORING](../../docs/AUTHORING.md)。现有配乐保留兼容单音频字段；需要分轨时只在本项目元数据添加 audioTracks，代码音轨通过本项目 audio.ts 提供。

`pnpm project:check tiny-seed --strict` 和 `pnpm project:scope tiny-seed` 是只读检查。`pnpm posters --project tiny-seed` 覆盖本项目封面；`pnpm music:build tiny-seed` 可选重建本项目采样配乐及其 MIDI、许可、报告和索引，中间文件在本项目 exports/audio，采样缓存位于本项目 .cache/soundfonts。

`pnpm render tiny-seed --width 1280` 导出 MP4；`pnpm frame tiny-seed --frame 150` 导出从 0 开始的第 150 帧 PNG。结果保存在本项目 exports/，默认拒绝覆盖，明确 --force 才替换。
