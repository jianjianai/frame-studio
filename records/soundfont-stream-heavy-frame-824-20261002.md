# 8.2.4 · 采样音轨与同步慢帧的调度修复

## 问题与范围

8.2.3 生产验收的 sunny-rail 在用户第二次点击前已经自动暂停。记录显示单帧同步渲染约 855ms，报错为“音频生成未跟上播放”。此证据与先前已修的待渲染播放意图取消问题不同。

原 ScoreStream 首播仅准备 0.5 秒，原生节点初排之后异步请求 1.5 秒；Worker 已产出 PCM 也需要主线程接消息才能排入原生队列。同步画面渲染超过首播覆盖时长后，原来的严格迟到检查触发同步保护。

本次仅修改 soundfont-stream.ts、soundfont-audio.ts、专属浏览器回归和 AUDIO 使用说明。没有改作品、曲谱、Worker 的 12ms 批次、共享 Transport/Clock、欠载阈值或已发布标签。

## 实现

- 复用 AdaptiveAudioBuffer：通常初始 4 秒播放时长、持续 8 秒；初始上限 12 秒、持续上限 24 秒，按倍率和两条音轨未来 PCM 窗口预算收紧。
- 每个 voice 固定本次初始目标；ready 等实际 PCM 到达并排成原生 Web Audio 节点后才完成。既有宿主在悬停 AudioContext 中等待 ready，随后恢复共享时钟。
- 保留 Worker/节点结束即时补给，加可释放的 100ms 补给计时器；排满末尾时提前停止计时器。每个 voice 最多一个持续补给请求，Stream 合并两轨请求；pump 防止重入。
- 取消、失败和 dispose 释放请求、监听、计时器及全部本实例节点；原严格 late > 40ms 保护保持。
- 极大程序化倍率也有未来窗口硬夹紧。估算保留一半预算，0.256 秒片段取整仍有余量；此预算不声称限制历史跳转 PCM 或整个页面驻留内存。

## 实际验证

环境：frame-development 的 Node24、真实 Chromium/Vite、独立 59919 端口、自有 UUID fixture；无数据库、生产或付费模型调用。

- 原实现真实 old-fail：实际 Player + 音色库 Worker + 850ms 同步画面，在 0.830748 秒自动暂停，严格欠载错误与生产相同。日志 .cache/soundfont-824-old-target.log，SHA256 2094db1c656a5040a5f057a877876c66bbb728c43d752f46415834e3bfb1bc1e。
- 最终实际目标：2/2 PASS，0 FAIL/0 SKIP。11 次重帧，最大 854.5ms；time 8.50204 秒仍 playing，errors=[]。MediaRecorder 原生输出解码全 finite，peak 0.06833，35 个连续 200ms 窗口最小 RMS 0.01064。
- 真原生初排覆盖 6.184 秒/48 节点；自适应策略在准备完成后衰减仍保留原目标。已缓存与未缓存的 ready 取消都为 AbortError；65 节点均 stop/disconnect，计时器、对应 Worker、监听及 waiter 全为 0。
- 倍率 1/4/16/64/512 的未来窗口预算检查通过；512 倍时估算 67,108,864 bytes。离线偏移 9.25 秒、源时长 1.3 秒、倍率 1.5、44.1kHz 的输出恰为 38,220 帧且 PCM finite/nonzero。
- 真实 seek 到 9 秒、rate 1.5、pause 后时间稳定；最终 AudioContext closed、Recorder inactive、所有已追踪 Worker 为 0，捕获轨道显式停止。finally 正常关闭浏览器/Vite 并移除本 fixture。

最终日志 .cache/soundfont-824-final-owned-target.log（SHA/bytes 见下表）；最终产品代码的 tsc --noEmit exit0，日志 .cache/soundfont-824-final-bounded-types.log 为空，SHA256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855。git diff --check 通过。

中间失败如实保留：lifecycle fixture 最初忘记悬停裸 Context，严格 late 保护正确报错；随后全局 Worker 计数误把 Player 合法的后台预热算作独立 stream 泄漏。夹具改为核对原 owned Worker 身份，并在 Player dispose 后要求所有追踪 Worker 为 0。两次失败日志分别为 .cache/soundfont-824-lifecycle-target.log（dfb4c4fa9ce6b66f5ae5ade3142fa2445f92be8d8c03272dc4e5c49b42f19595）、.cache/soundfont-824-final-bounded-target.log（c0d9eae54a97b6cc1f1d4634794db7eaee902b8e304ca650fd4058e71ea0c7b5）；没有降低释放或声音断言。

## 限制与交接

历史 PCM/Worker 跳转缓存管理没有在此窄修中重构。主线程阻塞超过有界队列覆盖、极大倍率或资源不足时仍可能触发原同步保护；不承诺任意负载下无限连续播放。本次是真浏览器受控 850ms 重帧回归，生产六作品全模式验收及完整镜像门禁仍由发布流程重新执行。本代理未提交、发布、部署或清理生产。

## 冻结身份

| 文件 | SHA256 | bytes |
|---|---|---:|
| src/engine/soundfont-stream.ts | bbb789e2ec57a8026932b4165aaf22e5fce08a4a477bbc5c1837247be30b86d7 | 12133 |
| src/engine/soundfont-audio.ts | 1904896e82a3c52155884167de28e09e2d22a1d1904d7532d5a81a587952fd0a | 5712 |
| tests/server/soundfont-stream-browser.test.mjs | d351616b55ba8386af0c08e8f220fb9bed5dd5a62da52967a160de2831336616 | 13446 |
| docs/AUDIO.md | b55135c872aa5c456704acd9aa7ce9bc2b46ad8014602d18cd1de56df66ea698 | 6740 |
| .cache/soundfont-824-final-owned-target.log | 0687118e0036851277455a8d21f8d4775e272af68aef215b993bc297f62f9e27 | 2479 |
