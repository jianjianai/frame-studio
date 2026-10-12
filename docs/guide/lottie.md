# lottie：Lottie 动画

设计师用 After Effects 导出的 Lottie（JSON）直接作为图层播放。文件放在作品的 `public/` 或素材库里，在「素材」里有缩略图、可以单击播放，拖到时间轴上就是一个 Lottie 图层：

```json
{ "id": "confetti", "source": { "kind": "lottie", "src": "films/work-1a2b3c4d/confetti.json" },
  "start": 3, "duration": 2.5, "fit": "contain" }
```

- 图层按动画自己的宽高比绘制（以作品画面能放下的最大尺寸）；`fit` 决定动画在框里的摆法，`crop` 按动画自己的画面裁剪。方形贴纸放进方形的框就正好填满。
- 图层时间按 Lottie 的帧率换算成帧，可配合 `offset`、`rate`、`loop`、`phase` 使用（`loop` 写 Lottie 的时长就能循环；几个图层错开循环用 `phase`，见 `layers` 的时间公式）。播放超出动画时长的时刻会报错，指出图层和时长。
- `asset_view` 能看 Lottie 的几个时刻，并给出尺寸、帧率、时长；素材列表里也有这些信息。
- 网上的 Lottie 文件先用 `asset_import` 导入（或 `material_write` 放进素材库），在 license 中记录来源与许可。

## 能播放什么

FRAME 用 Lottie 的 Canvas 播放器（不执行表达式）：

- 图片要内嵌（导出时勾选把图片内嵌为 PNG/JPEG/WebP），不能引用外部图片文件。
- **不执行表达式**：表达式是可以运行的代码，从网上下载的文件不应在工作台里运行代码。用了表达式（`loopOut`、`wiggle`、弹性等）的部分会不动或画错；素材列表、`work_context` 和 `asset_view` 会提示「含有表达式」。请设计师把表达式烘焙成关键帧（AE 里「将表达式转换为关键帧」）后再导出。
- 文字图层要转成形状再导出，否则字体可能不一致。
- `.lottie`（dotLottie 压缩包）不能直接用，先解压出里面的 JSON。

## 在代码中使用

```ts
import { createLottieScene } from "@frame/engine/lottie-adapter";
import { assetUrl, type SceneOptions } from "@frame/engine/types";

export const createScene = (options: SceneOptions) => createLottieScene(options, assetUrl("films/work-1a2b3c4d/intro.json"));
```

返回的 Scene 按 `render(time)` 跳到对应帧，可以作为 scene 图层，或在自己的 Canvas 场景里 `drawImage(scene.canvas, …)` 合成。
