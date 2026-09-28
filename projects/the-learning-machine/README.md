# AI 的三道题｜从写规则到学规律

全面重制 R2，153.6 秒、16:9、30 fps。Frame Studio 作品 id 保持 `the-learning-machine`，列表显示新标题。全部改动限于本项目目录。

## 播放与导出

运行入口 `scene.ts` 转发到 `r2/scene.ts`，`audio.ts` 转发到 `r2/music.ts`。旧版场景、音乐保留作历史材料，不再被当前入口加载。浏览器支持播放、暂停、冷跳、倍速、字幕开关，以及旁白、鼓组、音乐、动作音效四轨独立控制。

```powershell
pnpm --silent film validate the-learning-machine --json
pnpm --silent film test-e2e the-learning-machine --json
pnpm --silent film playback the-learning-machine --start 86.2 --duration 4 --json
pnpm --silent film poster the-learning-machine --json
pnpm --silent film export the-learning-machine --width 1920 --fps 30 --segment-seconds 10 --json
```

正式导出规格为 1920×1080、30 fps、H.264/AAC、4608 帧。最终路径与验证证据见 `records/r2-delivery.json`；该文件只在实际导出后记录，不把旧成片或样片当作新版交付。输出与审片保存在本项目 exports 目录。变更输入后不能恢复旧版本的导出清单。

## 因果主线

同一只橘猫先被翻转，再被遮住耳朵：手工条件为什么失效？把样本送进网络，先猜、算误差、反向计算梯度、调整连接，再检验新样本。继续把特征组合成模式，从识别推进到选择，再用一句话展示信息关联。预测下一词元、指令与反馈、多模态和来源核验均以具体动作解释。结尾回到最初的猫，把提问与核验接回同一条线。

年份只作为定位，不替代机制说明。规则、学习与搜索并存。本片不是完整AI年表。网络、棋局、特征图与概率是教学示意；注意力段使用本项目自造向量的真实数值计算，不冒充模型实测。资料依据见 `production/sources.md`，重制设计见 `production/rebuild-design.md`。

## 文件组织

`r2/sets.ts`、`forms.ts` 负责原创几何与绝对时间动作；`early.ts`、`late.ts` 和 `ink.ts` 负责解释性图形与屏幕构图；`time.ts` 管理段落和切点。`voice-cues.ts` 与项目字幕保存36条实测旁白时间。

`r2/music.ts` 原创分段乐谱、鼓组与音效，使用公共AudioContext调度采样节点。悬念切分、机械节奏、学习段加密、棋局半拍、语言段回应、核验段稀疏和结尾终止式分别编排。事件对齐采样网格，实时与离线任意分段重建一致，无独立播放时钟。旁白本地文件为 `public/narration/r2-master.wav`，AI合成云希声音，不克隆参考片人物声线。播放不依赖在线语音服务。

实时预览只提前调度两秒播放时间内的乐谱，已结束节点及时断开；同一音频时钟驱动后续补充。暂停、跳转、变速和切换音轨时释放旧调度，冷跳保留该位置的延音与回声。离线导出完整调度所请求的片段，不依赖实时唤醒。

## 检查与修改

文件修改前先读完整SHA-256。测试覆盖各段任意跳转复现、36个切点、持续播放和暂停、反向跳转与倍速、尾声分段音频一致性。工程通过、媒体完整和视听审阅分别记录，不能相互代替。旧初始化脚本不是当前发布命令，不得覆盖重制元数据。

所有参考片缩略图只作研究，不进入成片，不复制其画面、台词、声音、模型或标识。公共引擎和依赖由工作台维护；本项目没有改动其他作品。
