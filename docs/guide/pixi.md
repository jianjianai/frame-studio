# pixi：PixiJS 二维 WebGL

适合大量精灵、滤镜、遮罩和文字特效。`createPixiScene(options, build)` 创建不自动运行的 Pixi Application（背景透明），`build(app)` 返回 `update(time)`。

```ts
import { Graphics, Text, Container, BlurFilter } from "pixi.js";
import type { SceneOptions } from "../../src/engine/types";
import { createPixiScene } from "../../src/engine/scene-adapters";
import { seeded, smooth, phase } from "../../src/engine/math";

export function createScene(options: SceneOptions) {
  return createPixiScene(options, (app) => {
    const { width, height } = options;
    const random = seeded(3);
    const dots = new Container();
    const items = Array.from({ length: 300 }, () => {
      const dot = new Graphics().circle(0, 0, 2 + random() * 6).fill({ color: 0x7c93ff, alpha: 0.8 });
      dots.addChild(dot);
      return { dot, x: random(), y: random(), speed: 0.2 + random() };
    });
    const title = new Text({ text: "PIXI", style: { fill: 0xffffff, fontSize: height * 0.12, fontWeight: "700" } });
    title.anchor.set(0.5);
    title.position.set(width / 2, height / 2);
    title.filters = [new BlurFilter()];
    app.stage.addChild(dots, title);

    return (t) => {
      for (const item of items) item.dot.position.set(item.x * width, ((item.y + t * 0.05 * item.speed) % 1) * height);
      const p = smooth(phase(t, 0.3, 1.5));
      title.alpha = p;
      (title.filters![0] as BlurFilter).strength = (1 - p) * 20;
    };
  });
}
```

- 不要使用 `app.ticker`、`Ticker.shared`；所有状态在返回的函数中按 `t` 设置。
- 纹理：`await Assets.load(assetUrl("films/<名称>/sprite.png"))`。
- 作为 visual.json 的 scene 图层时，`engine` 写 `"pixi"`。
