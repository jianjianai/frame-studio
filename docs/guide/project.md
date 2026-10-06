# project.ts：作品元数据

平台在不执行代码的情况下读取 `project.ts`，所以字段只能是字面量（字符串、数字、数组、对象）或同文件里的常量，加载入口必须写成 `() => import("./文件")`。

```ts
import type { AnimationProject } from "../../src/engine/types";

const project: AnimationProject = {
  id: "work-1a2b3c4d",            // 等于文件夹名，不要修改
  title: "夏日海报",
  subtitle: "",
  description: "15 秒竖屏促销短片",
  renderer: "composition",         // composition | canvas | pixi | three | babylon | remotion
  engineProtocol: 1,
  composition: { width: 1080, height: 1920 },
  duration: 15,                    // 秒，最长 3600
  fps: 30,                         // 12–60
  accent: "#f5a524",
  poster: "films/work-1a2b3c4d/poster.svg",
  tags: [],
  status: "draft",
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

- `renderer` 只是说明主要技术，真正的画面由 `load` 指向的 `scene.ts` 决定。Remotion 作品还要 `loadRemotion: () => import("./composition")`。
- `beats` 是镜头标记，显示在时间轴上，方便用户和 AI 指代片段；可加唯一 `id`。
- `subtitles` 由播放器绘制在画面底部（导出时可选择烧录）。用户也会在时间轴上编辑字幕。用 `subtitles_edit` 修改（见 `subtitles`）。
- 修改时长、标题、镜头标记等字段用 `work_update` 工具；它只替换字段值，保留文件其余格式。
- `experiences` 是作品关联的经验库名称列表，由用户在「经验」面板中勾选，不要自己修改。
- `materials` 是作品引用的素材库名称列表，用 `materials_link` 修改；用到的素材文件版本记录在 `materials.lock.json`（不要手改，见 `assets`）。
- `publishedAt` 由 FRAME Studio 在用户发布作品时写入。有这个字段的作品已发布、只能查看，工具会拒绝修改；不要自己添加或删除它。
- 改变 `duration` 后检查 `visual.json` 和 `audio.json` 中超出时长的片段（`work_check` 会报错）。
