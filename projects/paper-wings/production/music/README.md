# 风的邮差 · 采样配乐源文件

本目录保存本作品的 MIDI、乐谱数据、测量报告和 GeneralUser GS 许可。可编辑乐谱代码在 ../../score.mjs，动作音效在 ../../scripts/foley.mjs。

从仓库根运行 `pnpm music:build paper-wings` 可重建本作品：覆盖本目录中同名 MIDI、score.json、报告和许可，更新 ../../public/audio/paper-wings.wav 与本作品素材/波形索引，分轨和中间文件位于 ../../exports/audio，采样库缓存位于 ../../.cache/soundfonts。

采样库版本、来源 revision 与 SHA-256 记录在 render-report.json；许可证见 GENERALUSER-LICENSE.txt。正常浏览器播放不需要重建。新的多音轨与实时生成声音接口见 ../../../../docs/AUDIO.md。
