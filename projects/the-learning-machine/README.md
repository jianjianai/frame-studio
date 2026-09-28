# 不是突然变聪明｜AI 的七十年

当前运行版本为 R3，156秒、16:9、30fps。Frame Studio 工程 id 保持 `the-learning-machine`。全部源码、素材、声音、审片和导出都位于本项目目录。

## 播放与交付

`scene.ts` 转发到 `r3/scene.ts`。当前元数据使用三条文件音轨：解说、配乐和少量动作声音；没有加载 R2 程序乐谱。播放、暂停、任意定位、倍速和音轨独立控制由工作台统一处理。

```powershell
pnpm --silent film validate the-learning-machine --json
pnpm --silent film test-e2e the-learning-machine --json
pnpm --silent film playback the-learning-machine --start 39.126 --duration 5 --json
pnpm --silent film poster the-learning-machine --json
pnpm --silent film export the-learning-machine --width 1920 --fps 30 --segment-seconds 10 --json
```

正式导出为1920×1080、30fps、H.264/AAC，156秒对应4680帧。最终输出目录与源指纹以实际生成的 `records/r3-delivery.json` 为准，不把R2文件或R3样片当作正式成片。R3交付包包含MP4、中文字幕、封面、播放页、配乐署名和验证文件。发布影片时保留配乐署名。

## 叙事和画面

主线是人工智能为何发展多年、却像突然爆发。轨道计算和手写数字形成任务反差；规则遇到笔迹例外，转向带标签的样本、误差和参数调整；数据与并行计算推动深度视觉；决策、注意力、词元预测和人机协作依次展开。结尾区分能力与可靠性，把核验、权限和人的责任带回值得解决的问题。

本版不用橘猫问答，不将年份当作章节停顿。原理以原创工业三维模型、笔迹、帆船图像、线路和有因果先后的物体运动演示。图像特征、棋盘、候选和网络都属于教学示意，非真实模型实验结果。不同研究路线长期并存；影片不是完整年表。史实与原论文见 `production/r3-sources.md`。

## 配乐与旁白

配乐为 Scott Buckley 已发布的 **Emergent**，不是本项目原创曲目。根据叙事使用三个原曲区间，做交叉淡化、分段音量、旁白避让和风险段短暂停顿，没有再铺R2的鼓点循环。

**发布时使用的署名：**

> 'Emergent' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au

曲目来源：https://www.scottbuckley.com.au/library/emergent/

许可证：https://creativecommons.org/licenses/by/4.0/

本片对音乐做了节选、剪接、淡化和混音；同样的说明和署名进入片尾与交付包。旁白为AI合成普通话 `zh-CN-YunyangNeural`，不是某位真人声音克隆。语音合成后保存在项目中，播放不再访问在线语音服务。

## 代码与制作材料

`r3/timeline.ts` 保存32组实测旁白时间及九段机制空间；`math.ts` 负责确定性运动；`geometry.ts` 负责原创几何、文本和纹理；三个 `acts-*.ts` 负责场景动作；`scene.ts` 负责灯光、受控泛光、摄影、文字安全区和资源释放。

`production/r3-narration.json` 是逐句语音源；`production/r3-direction.md` 是稳定制作说明。`scripts/r3-build-audio.mjs` 在本项目内处理原始音轨并生成 `public/audio-r3/` 的三个156秒文件。`scripts/activate-r3.mjs` 是初次元数据接入脚本，要求旧文件SHA；后期修改不能未经核对直接重跑覆盖。

## 保留版本与检查

R1、R2源码及历史报告保留，用于追溯，不被当前画面入口调用。接手前已有的R2实时音频修复保持不变：提前两秒调度、结束节点断开、音频时钟唤醒、暂停/跳转/倍速释放、离线片段独立调度。R2调度器单元测试仍保留；新版本的浏览器输出测量回归适配为三条文件音轨，不删除此前问题的验证逻辑。

测试区分当前R3行为和保留版本回归。最终报告记录严格结构检查、类型、所有测试、浏览器实际音频输出、声画长度、全片解码与源指纹。艺术评价不能由这些数字代替。实际查看的镜头和未完成的主观听觉审阅分别记在 `records/`。
