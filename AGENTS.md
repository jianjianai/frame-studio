# FRAME 动画工坊 · 后续制作约定

## 长期工作区

用户已决定：之后的动画统一制作到本项目，位置为 C:\Users\28018\Desktop\动画。用 pnpm 管理依赖；不再要求单页面、单文件 HTML。不要为每部片子重建一套播放器或另建孤立 HTML。

先阅读 README.md 和 docs/AUTHORING.md，再查看已有项目的 project.ts / scene.ts。新增故事放入 src/projects/<slug>/，通过 import.meta.glob 自动注册。保持用户已有作品和素材，不无故覆盖、不清空目录。

## 质量底线

动画承担讲解，不是装饰文字。使用角色/物体的连续运动、形变、场景演变与镜头衔接讲故事。正式影片禁止 PPT 式翻页、卡片罗列、章节页、静态图文加淡入淡出冒充动画。工作台 UI 可以用卡片，片内画面不可以用这种方式替代叙事。

先设计故事和动作因果，再写场景。先做 10–20 秒有代表性的样片，检查美术、运动、摄影机与声音，用户认可方向后再扩展。隐藏字幕后，画面仍应能表达发生了什么。原始立方体/光球/粒子只作为开发占位，不能自称正式交付效果。

Demo 也需要高标准，不以“工程演示”为理由降低音乐、美术和运镜质量。优先做有独立主题、乐句发展、动作音效与自然收束的音乐，再校准画面、表演和摄影机；不能用音量／采样率提升冒充音乐变好。保留 `production/music/` 的乐谱与许可记录，`pnpm assets` 不得覆盖已精修的配乐。

演示样片与正式影片要明确区分。不可用“渲染器更先进”推断成片达标，不可把成功构建等同于视觉验收。涉及科学与历史内容时，用官方或一手资料核实，并在作品元数据/制作文档记录事实来源。艺术示例不冒充科学模型。

## 工程协议

1. 每个场景实现 createScene({width,height,quality}) -> {canvas,render(time),dispose()}。
2. 所有动画从绝对时间计算。同一 t 重绘必须一致，支持从 25 秒回到 5 秒，不能依赖先前播放顺序。
3. GSAP timeline 必须 paused:true，统一 timeline.seek(time,true)。不要让库 ticker 自己驱动场景。
4. 不创建场景自有 requestAnimationFrame、setInterval、独立音频计时器或动画循环。不要在 render 内使用 Math.random()、Date.now() 或增量推进状态。随机数据使用 seeded() 并在初始化时生成。
5. Three.js 骨骼用 AnimationMixer.setTime(time)；需要粒子/物理时用解析解或可重置的固定步长确定性模拟，不能让回拖留下旧状态。
6. 音乐/旁白/音效先混成与项目片长匹配的本地完整音轨，由 AudioTransport 调度。字幕由统一合成器绘制，避免字幕和导出画面两套实现。
7. 使用 assetUrl() 访问 public/ 素材；保留来源和授权。无运行时 CDN 与远程字体依赖，不拷贝系统字体到项目。GLB 优先于缺少依赖文件的 glTF。
8. dispose 必须释放 GSAP timeline、WebGL、几何体、材质、纹理、事件与音频资源；共享缓存纹理不得误删。
9. 解码失败、缺少素材、GPU 不可用、音轨加载失败应明确报错，不能悄悄替换成空白画面并声称成功。
10. 保持实现简单。不要同时堆叠多个做同一件事的动画框架，不因为“将来也许会需要”增加后端、队列或数据库。

## 实际命令

```powershell
pnpm env:check
pnpm animation:new my-film "我的动画" --renderer pixi
pnpm assets:import "D:/assets/actor.png" --license "来源与授权"
pnpm dev
pnpm posters
pnpm verify
pnpm render my-film --width 1920 --fps 30
```

不要把项目命令写成 pnpm doctor 或 pnpm import；这些名称会与 pnpm 内置命令冲突。新建工具名称是 animation:new。

## 完成前必须验证

- pnpm typecheck、pnpm test、pnpm build、pnpm test:e2e；命令非零不得当成成功。
- 打开浏览器看真实画面，包括中间镜头和结束镜头，不只看封面。
- 播放、暂停、拖动、倒拖、逐帧、倍速、循环、画质切换、字幕、音量与全屏。
- 字幕关闭的画面仍可理解；无元素越界、画布拉伸、明显闪烁或运动主体丢失。
- 新项目反复进入/离开，检查控制台错误、音频重复播放和 GPU 资源泄漏。
- 正式交付前实际导出一个代表片段，ffprobe 核对尺寸、帧率、帧数、时长、音频；不能只提供一个未运行过的导出命令。
- 若仅完成工程演示，诚实标为 demo；若公网没有部署，说明只是本机/局域网浏览器工作台。

## 安全与授权

不自动打开公网端口、不提交密钥、不调用付费素材/音频/生成服务。保留已有文件。导出默认写 exports/，重名覆盖必须明确 --force。源文件、导入素材和第三方依赖的授权要清楚分开。
