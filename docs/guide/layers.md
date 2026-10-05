# layers：visual.json 图层合成

新作品默认使用图层合成：`scene.ts` 调用 `createCompositionScene(options, visual, loaders)`，`visual.json` 按时间排列图层。用户可以在时间轴上拖动、裁剪、切开、隐藏图层，所以这是人和 AI 共同编辑的部分。

```ts
// scene.ts
import type { SceneOptions } from "../../src/engine/types";
import { createCompositionScene } from "../../src/engine/compositor";
import visual from "./visual.json";

export function createScene(options: SceneOptions) {
  return createCompositionScene(options, visual, {
    title: () => import("./scenes/title"),      // scene 图层的 module 名称
    particles: () => import("./scenes/particles"),
  });
}
```

```json
{
  "schemaVersion": 1,
  "background": "#101418",
  "clips": [
    { "id": "bg", "name": "背景视频", "source": { "kind": "video", "src": "films/work-1a2b3c4d/sea.mp4" },
      "start": 0, "duration": 10, "fit": "cover", "audio": { "enabled": true, "gain": 0.5 } },
    { "id": "logo", "source": { "kind": "image", "src": "films/work-1a2b3c4d/logo.png" },
      "start": 2, "duration": 8, "fadeIn": 0.5,
      "transform": { "x": 0.35, "y": 0.1, "width": 0.3, "height": 0.2,
                     "opacity": [{ "at": 0, "value": 0 }, { "at": 1, "value": 1, "easing": "smooth" }] } },
    { "id": "title", "source": { "kind": "scene", "module": "title", "engine": "canvas" },
      "start": 0, "duration": 10 }
  ]
}
```

## 图层字段

- `source.kind`：`image`、`video`、`lottie`（`src` 为 Lottie JSON）、`sequence`（`frames` 图片数组 + `fps`）、`color`（`color: "#rrggbb"`）、`scene`（`module` + `engine`，engine 取 canvas/pixi/three/babylon/composition）。
- 时间：`start`、`duration`（作品时间，秒）；`offset` 素材内起点；`rate` 速度；`loop` 循环长度；`phase`。
- `transform`：`x, y, width, height` 是相对画面的 0–1 比例（默认铺满），`rotation` 度，`opacity` 0–1。每项可以是数字或关键帧数组 `[{ at, value, easing }]`，`at` 是图层内时间，easing 为 `linear`/`hold`/`smooth`。
- `fit`：`contain`/`cover`/`fill`；`crop`：0–1 比例裁剪；`blend`：混合模式；`fadeIn`/`fadeOut` 秒；`hidden` 隐藏。
- 视频图层 `audio: { enabled: true, gain }` 会把视频原声加入混音。
- 数组顺序就是叠放顺序：越靠后越在上层。图层不能超过作品时长；`id` 唯一，字母开头。

## 修改方式

- 直接编辑 visual.json，或用 `layers_edit` 工具做原子操作（按顺序执行，全部成功才写入，失败不会写坏文件；`dryRun: true` 只校验）：

```json
{ "operations": [
  { "op": "add", "clip": { "id": "flash", "source": { "kind": "color", "color": "#ffffff" }, "start": 4.9, "duration": 0.3, "fadeOut": 0.3 } },
  { "op": "update", "id": "logo", "patch": { "start": 3 } },
  { "op": "split", "id": "bg", "at": 5, "newId": "bg_b" },
  { "op": "reorder", "id": "title", "index": 2 },
  { "op": "remove", "id": "old" }
]}
```

- `add` 可带 `index` 指定插入位置；`update` 的 `patch` 只写要改的字段，`unset` 列出要删除的可选字段；`replace` 为 `{ "op": "replace", "document": {…} }`。
- 新的 scene 模块要先在 `scene.ts` 的 loaders 中注册（`名称: () => import("./scenes/名称")`），否则会报“场景模块未注册”。
- scene 图层的模块是普通 Scene（见 `scene`），收到的 `time` 是图层内时间（已减去 start、考虑 rate/offset）。scene 图层输出透明画布即可叠加在下层之上。
- 同时活跃的图层不超过 32 个。
