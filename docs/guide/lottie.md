# lottie：Lottie 动画

Lottie JSON 放在 `public/`，最简单的用法是 visual.json 图层：

```json
{ "id": "confetti", "source": { "kind": "lottie", "src": "films/work-1a2b3c4d/confetti.json" },
  "start": 3, "duration": 2.5, "fit": "contain" }
```

图层时间按 Lottie 的帧率换算成帧，可配合 `offset`、`rate`、`loop` 使用。只支持 Canvas 渲染器能绘制的特性（无表达式、无外部图片以外的资源）。

在代码中使用：

```ts
import { createLottieScene } from "@frame/engine/lottie-adapter";
import { assetUrl, type SceneOptions } from "@frame/engine/types";

export const createScene = (options: SceneOptions) => createLottieScene(options, assetUrl("films/work-1a2b3c4d/intro.json"));
```

网上的 Lottie 文件先用 `asset_import` 导入，并在 license 中记录来源与许可。
