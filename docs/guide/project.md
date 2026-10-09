# project.ts：作品元数据

平台在不执行代码的情况下读取 `project.ts`，所以字段只能是字面量（字符串、数字、数组、对象）或同文件里的常量，加载入口必须写成 `() => import("./文件")`。

```ts
import type { AnimationProject } from "@frame/engine/types";

const project: AnimationProject = {
  id: "work-1a2b3c4d",            // 等于文件夹名，不要修改
  title: "夏日海报",
  subtitle: "",
  description: "15 秒竖屏促销短片",
  renderer: "composition",         // composition | canvas | pixi | three | babylon
  engineProtocol: 1,
  composition: { width: 1080, height: 1920 },
  duration: 15,                    // 秒，最长 3600
  fps: 30,                         // 12–60
  accent: "#f5a524",
  posterTime: 6.5,                 // 封面用这一秒的画面（可选）
  tags: [],
  status: "draft",
  tempo: { bpm: 118.12, firstBeat: 0.035, beatsPerBar: 4 },   // 配乐的节拍（可选）
  beats: [{ at: 0, title: "开场", detail: "标题从下方升起" }],
  subtitles: [{ start: 1, end: 3.5, text: "夏天，就该这样过" }],
  credits: [],
  load: () => import("./scene"),
  loadVisual: () => import("./visual.json"),          // 使用图层时
  loadAudioDocument: () => import("./audio.json"),    // 使用混音文档时
  loadAudio: () => import("./audio"),                 // 有代码生成的声音时
};
export default project;
```

- `renderer` 只是说明主要技术，真正的画面由 `load` 指向的 `scene.ts` 决定。
- `tempo` 是配乐的节拍网格：`bpm`、`firstBeat`（作品时间里第一小节第一拍的秒数）、`beatsPerBar`（默认 4）。用 `preview_audio` 的 `src` + `beats: true` 分析配乐，再用 `work_update` 写进来。代码（包括素材库里的资源）用 `@frame/engine/tempo` 按它卡点：`beatAt(k)` 第 k 拍的时间（`beatAt(2.5)` 是第 2 拍后的反拍）、`barAt(n)` 第 n 小节第一拍、`pulse(t)` 每拍跳一下的 0–1 包络、`sinceBeat(t)`、`beatLength()`。不写 `tempo` 时按 120 BPM、从 0 秒开始。改了 `tempo` 预览会整页重新加载。
- `beats` 是镜头标记，显示在时间轴上，方便用户和 AI 指代片段；可加唯一 `id`。
- `subtitles` 由播放器绘制在画面底部（导出时可选择烧录）。用户也会在时间轴上编辑字幕。用 `subtitles_edit` 修改（见 `subtitles`）。
- 修改时长、标题、镜头标记等字段用 `work_update` 工具；它只替换字段值，保留文件其余格式。
- `experiences` 是作品关联的经验库名称列表，用户在「经验」面板中勾选；用户要求时用 `experience_link` 修改，不要手改。
- `materials` 是作品关联的素材库名称列表，用户要求时用 `materials_link` 修改；用到的素材文件版本记录在 `materials.lock.json`（不要手改，见 `assets`）。
- 封面：默认是作品自己的一帧画面，FRAME 在作品变化后重新截取（`posterTime` 指定用哪一秒，不写时自动挑一个画面饱满的时刻）。`poster: "films/<名称>/poster.webp"` 指定一张 `public/` 里的图片作为封面，有它时不再截取。用户在预览栏「设为封面」或在属性中上传图片时，FRAME 会写入这两个字段。
- `publishedAt` 由 FRAME Studio 在用户发布作品时写入。有这个字段的作品已发布、只能查看，工具会拒绝修改；不要自己添加或删除它。
- 改变 `duration` 后检查 `visual.json` 和 `audio.json` 中超出时长的片段（`work_check` 会报错）。
