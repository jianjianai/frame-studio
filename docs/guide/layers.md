# layers：visual.json 图层合成

新作品默认使用图层合成：`scene.ts` 调用 `createCompositionScene(options, visual, loaders)`，`visual.json` 按时间排列图层。用户可以在时间轴上拖动、裁剪、切开、隐藏图层，所以这是人和 AI 共同编辑的部分。

```ts
// scene.ts
import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
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
                     "opacity": [{ "at": 0, "value": 0, "easing": "smooth" }, { "at": 1, "value": 1 }] } },
    { "id": "title", "source": { "kind": "scene", "module": "title", "engine": "canvas" },
      "start": 0, "duration": 10 }
  ]
}
```

## 图层字段

- `source.kind`：`image`、`video`、`lottie`（`src` 为 Lottie JSON，见 `lottie`）、`model`（三维模型，见下）、`sequence`（`frames` 图片数组 + `fps`）、`color`（`color: "#rrggbb"`）、`scene`（`module` + `engine`，engine 取 canvas/pixi/three/composition）。
- 时间：`start`、`duration`（作品时间，秒）；`offset` 素材内起点；`rate` 速度；`loop` 循环长度；`phase` 循环的错开量。图层在作品时间 `t` 播放素材的
  `offset + ((t − start) × rate + phase)`，有 `loop` 时括号部分先对 `loop` 取余。所以 `offset + loop` 不能超过素材时长；几个循环图层要错开时改 `phase`，不要改 `offset`。
- `transform`：`x, y, width, height` 是相对画面的 0–1 比例（默认铺满），`rotation` 度，`scale` 以图层中心缩放（图层框和内容一起，1 是原大小，超出画面的部分被裁掉），`opacity` 0–1。每项可以是数字或关键帧数组 `[{ at, value, easing }]`，`at` 是图层内时间，easing 为 `linear`/`hold`/`smooth`：**写在一段的起点关键帧上**，决定从它到下一个关键帧怎么变化（最后一个关键帧的 easing 不起作用）。
- 推近（照片慢慢放大）：`"transform": { "scale": [{ "at": 0, "value": 1, "easing": "smooth" }, { "at": 4, "value": 1.12 }] }`；弹出：`scale` 从 0.8 到 1 配合 `fadeIn`。不要用改 `width`/`height` 再挪 `x`/`y` 的办法做缩放。
- `fit`：`contain`（完整放进框里，可能留边）/`cover`（铺满框，多出的裁掉）/`fill`（拉伸）。
- `crop`：先从素材自己的画面里取一块，再按 `fit` 放进框：`{ "x": 0.1, "y": 0, "width": 0.8, "height": 1 }`（都是素材画面的 0–1 比例，`x + width`、`y + height` 不超过 1）。
- `blend`：`source-over`（默认）、`multiply`、`screen`、`overlay`、`darken`、`lighten`、`difference`；`destination-in` / `destination-out` 把这个图层当遮罩（只保留 / 挖掉下面图层和它重叠的部分）。
- `fadeIn`/`fadeOut` 秒；`hidden` 隐藏。
- 视频图层 `audio: { enabled: true, gain }` 会把视频原声加入混音。
- 数组顺序就是叠放顺序：越靠后越在上层。图层不能超过作品时长；`id` 唯一，字母开头。

## 修改方式

- 直接编辑 visual.json，或用 `layers_edit` 工具做原子操作（按顺序执行，全部成功才写入，失败不会写坏文件；`dryRun: true` 只校验）：

```json
{ "operations": [
  { "op": "add", "clip": { "id": "flash", "source": { "kind": "color", "color": "#ffffff" }, "start": 4.9, "duration": 0.3, "fadeOut": 0.3 } },
  { "op": "update", "id": "logo", "patch": { "start": 3, "transform": { "opacity": 0.8 } } },
  { "op": "split", "id": "bg", "at": 5, "newId": "bg_b" },
  { "op": "reorder", "id": "title", "index": 2 },
  { "op": "remove", "id": "old" }
]}
```

- `add` 可带 `index` 指定插入位置；`reorder` 的 `index` 超过图层数时放到最上面；`replace` 为 `{ "op": "replace", "document": {…} }`。
- `update` 的 `patch` 只写要改的字段：嵌套对象（`transform`、`audio`、`source`、`crop`）逐项合并，例如 `{ "transform": { "opacity": 0.8 } }` 保留原来的 `x`/`y`；数组（关键帧）整体替换；`source` 换成另一种 `kind` 时整体替换。`unset` 删除字段，可写嵌套的 `transform.opacity`、`audio.gain`、`source.parameters.<名称>`；只删除字段时不用写 `patch`：`{ "op": "update", "id": "fox", "unset": ["source.animation"] }`。
- `layers_get` 每个图层一行，省略取默认值的字段（`offset` 0、`phase` 0、`rate` 1、`fit` contain、`blend` source-over）。
- 新的 scene 模块要先在 `scene.ts` 的 loaders 中注册（`名称: () => import("./scenes/名称")`），否则会报“场景模块未注册”。
- scene 图层的模块是普通 Scene（见 `scene`），收到的 `time` 是图层内时间（已减去 start、考虑 rate/offset）。scene 图层输出透明画布即可叠加在下层之上。
- 同时活跃的图层不超过 32 个；其中三维图层（three 场景和模型图层，每个占一个 WebGL 上下文）不超过 12 个。Pixi 图层共用一个渲染器，不受这个限制。

## 三维模型图层

不写代码直接放一个模型（GLB/glTF/FBX/OBJ，作品的 `films/…` 或素材库的 `materials/…`）：模型在摄影棚光下自动取景，填满图层的框（按框的形状渲染，透明背景），有动画时播放动画。

```json
{ "id": "fox", "source": { "kind": "model", "src": "materials/三维/models/Fox.glb", "animation": "Walk", "spin": 30 },
  "start": 0, "duration": 6, "transform": { "x": 0.05, "y": 0.1, "width": 0.45, "height": 0.8 } }
```

- `animation`：动画名（`asset_view` 或素材列表里能看到），不写播放第一个；按图层时间循环。
- `spin`：每秒绕竖直轴转多少度（转台展示），转动时按任何角度都放得下来取景，所以同样的框里模型会比不转时小一些（扁长的模型尤其明显）。想让它大一些：把框放大或改成接近模型转一圈时的外形（大致方形），或者用 `transform.scale`。
- `azimuth` / `elevation`：从哪个方向看（度）：水平角 0 是正面，默认 20，范围 −360–360；俯仰默认 10，范围 −89–89。`spin` 范围 −1440–1440（度/秒）。
- `environment`：全景图作为环境光（`.hdr`、`.exr`，或普通全景 JPEG/PNG/WebP），金属、玻璃反射更真实；不写用柔和的摄影棚光。
- 写入前会检查：动画名在模型里不存在、同一时刻三维图层（模型图层和 three 场景）超过 12 个，都直接报错。
- 删除这些设置用 `layers_edit` 的 `unset`，例如 `["source.animation"]`。
- 要自己摆相机、多个模型同框、加地面和后期，写 three 场景（见 `three`）。
