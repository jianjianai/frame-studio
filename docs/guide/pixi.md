# pixi：PixiJS 二维 WebGL

适合大量精灵、滤镜、遮罩和文字特效。`createPixiScene(options, build)` 创建一个 Pixi 场景（背景透明，不自动运行），`build(app)` 把显示对象加到 `app.stage`，返回 `update(time)`。

```ts
import { Graphics, Text, Container, BlurFilter } from "pixi.js";
import type { SceneOptions } from "@frame/engine/types";
import { createPixiScene } from "@frame/engine/scene-adapters";
import { seeded, smooth, phase } from "@frame/engine/math";

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
- 纹理：`await Assets.load(assetUrl("films/<名称>/sprite.png"))`，素材库里的图片写 `assetUrl("materials/<库>/<路径>")`。
- 作为 visual.json 的 scene 图层时，`engine` 写 `"pixi"`。
- 同一画面里所有 Pixi 场景共用一个渲染器（浏览器同时只保留约 16 个 WebGL 上下文；共用后 Pixi 图层不受这个限制，只受所有图层同时不超过 32 个的限制）：`app.stage` 是这个场景自己的，`app.renderer` 是共用的。不要 `app.destroy()`、不要改 `app.renderer` 的尺寸和设置；画面尺寸用 `options.width/height`。
- 场景结束时它的 `app.stage` 连同子对象一起销毁。自己创建的纹理（`Texture.from(canvas)` 等）和滤镜在舞台的 `destroyed` 事件里释放：先销毁滤镜，再销毁它们用到的纹理（纹理放到 `queueMicrotask` 里），否则控制台会出现「destroyed while still bound to a shader」。不要销毁 `Texture.WHITE` 这类共用纹理。
- 动作编排可以用 gsap 时间线动画显示对象的属性，在返回的函数里 `timeline.seek(t, true)`（见 `gsap`）。

## 素材库里的 Pixi 资源

粒子、光效、转场这类效果做成素材库代码，所有作品共用：导出一个创建函数（返回一个 `Container` 和 `update(time)`），再声明成资源（`engine: "pixi"`），在「素材 → 资源」里预览、调参数，AI 用 `resources_search` 找到（声明写法见 `resources`）。作品里：

```ts
import { burst } from "@materials/特效/code/burst";

export function createScene(options: SceneOptions) {
  return createPixiScene(options, (app) => {
    const fx = burst({ count: 200 });
    fx.view.position.set(options.width / 2, options.height / 2);
    app.stage.addChild(fx.view);
    return (t) => {
      fx.update(t);
    };
  });
}
```

- 资源里的尺寸按调用方给的画面算（参数或 `app.screen`），不要写死某个作品的分辨率。
