# 日光快线 · 乐谱与浏览器音频

- `score.mjs`：原有音符、乐句、配器、力度、表情和声像。
- `foley.mjs`：原有 48 kHz 双声道动作音效，固定种子与画面时间保持一致。
- [../audio.ts](../audio.ts)：两条独立音轨入口，配乐使用原 GeneralUser GS 乐器采样，动作音效由代码产生。
- [乐器采样](../public/music/GeneralUser-GS.sf2) 与 [完整许可](../public/music/GENERALUSER-LICENSE.txt)：项目自带的原版本采样库。

乐器声音继续由原 `spessasynth_core@4.3.22` 解释原乐谱。采样库为 GeneralUser GS 2.0.3，revision `684543d5e5efaef08d02be50dcda8d552478fa60`，SHA-256 `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`；加载时校验摘要，不能静默换用其他音色。

浏览器首次使用时加载本项目的乐器素材，在后台处理线程按原乐谱生成，结果留在内存。拖动、循环、变速和离线导出复用同一 AudioBuffer，无需先生成整首 WAV，也不需要音乐构建命令。已有的录音、音效或成品音乐可按 [文件音轨接口](../../../docs/AUDIO.md) 直接加载后由浏览器处理、混合与播放。

修改声音时编辑本目录或本项目 audio.ts / project.ts 并重新载入播放器。配乐和音效保留原相对音量，浏览器处理保留原高低通、均衡、首尾淡化和 -18 LUFS 响度目标；旧 WAV 报告仅对应历史文件，新实现未声明与旧文件逐采样相同。

[历史 MIDI 与乐谱快照](../records/legacy-music/README.md)。修改和验证记录放本项目 records，不写入本说明。
