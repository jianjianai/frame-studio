# gsap：时间线编排、文字、描边与形状变形

GSAP 适合编排很多元素的先后动作：缓动丰富，`stagger` 让一组东西依次动，时间线可以嵌套。FRAME 的画面按绝对时间绘制，所以**时间线建成暂停的，每帧跳到这一刻**：

```ts
import type { Scene, SceneOptions } from "@frame/engine/types";
import { gsap } from "@frame/engine/gsap";

export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const box = { x: 0.1, rotation: 0, alpha: 0 };
  const timeline = gsap
    .timeline({ paused: true })
    .to(box, { alpha: 1, duration: 0.4 })
    .to(box, { x: 0.8, rotation: Math.PI, duration: 1.2, ease: "power3.inOut" }, 0.2);

  return {
    canvas,
    render(t) {
      timeline.seek(t, true);        // true：跳转时不触发回调
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = box.alpha;
      ctx.save();
      ctx.translate(box.x * width, height / 2);
      ctx.rotate(box.rotation);
      ctx.fillStyle = "#4f7cff";
      ctx.fillRect(-60, -60, 120, 120);
      ctx.restore();
    },
    dispose() {
      timeline.kill();
    },
  };
}
```

- 从 `@frame/engine/gsap` 导入 `gsap`：插件已注册（CustomEase、CustomBounce、CustomWiggle、MorphSVG、MotionPath、Physics2D），全局时钟已停：没有 `seek` 的动画不会自己动。
- 动画的是普通对象的数值（位置、透明度、颜色字符串也可以），画的时候读出来。不要用 `gsap.ticker`、`delayedCall`、`onUpdate` 去画。
- 时间线在 `createScene` 里建一次；依赖参数时按参数缓存（素材库资源的 `draw` 每帧都会调用）。
- `repeat`、`yoyo`、嵌套时间线都可以，`seek` 到任何时刻结果都一样。

## 画布上的插件替代（`@frame/engine/gsap`）

GSAP 的 SplitText、DrawSVG、MorphSVG 操作网页里的元素；FRAME 画在画布上，用下面这些：

| 函数 | 作用 |
|---|---|
| `splitText(ctx, text, { x, y, align, lineHeight, letterSpacing, maxWidth })` | 按当前字体把文字拆成一个个字（保留字距，`\n` 换行，`maxWidth` 自动换行：中文按字、西文按词），每个字有 `x`、`y`、`alpha`、`scale`、`rotation` 可以动画，`index`、`word`、`line` 用来分组 |
| `drawGlyphs(ctx, glyphs)` | 按每个字的 `alpha`、`scale`、`rotation`（绕字的中心）画出来 |
| `strokePath(ctx, d, end, start = 0)` | 画出 SVG 路径的一段（长度比例 `start`–`end`）：会自己画出来的线 |
| `pathLength(d)` | SVG 路径的长度 |
| `morphPath(from, to, { shapeIndex, type, map })` | 一个形状变成另一个：返回 `progress → 路径数据`，`new Path2D(…)` 画出来（点数不同的形状也可以） |

```ts
import { gsap, splitText, drawGlyphs, strokePath, morphPath } from "@frame/engine/gsap";

ctx.font = "700 96px sans-serif";
const glyphs = splitText(ctx, "逐字出现的标题", { x: width / 2, y: height * 0.45, align: "center" });
const state = { line: 0, shape: 0 };
const morph = morphPath(CIRCLE, STAR);              // 两个 SVG 路径字符串
const timeline = gsap
  .timeline({ paused: true })
  .from(glyphs, { y: "+=60", alpha: 0, scale: 0.6, duration: 0.5, ease: "back.out(2)", stagger: 0.05 })
  .to(state, { line: 1, duration: 0.8, ease: "power2.inOut" }, 0.3)
  .to(state, { shape: 1, duration: 1, ease: "elastic.out(1, 0.5)" }, 0.6);

// render(t)：
timeline.seek(t, true);
ctx.font = "700 96px sans-serif";
ctx.fillStyle = "#fff";
drawGlyphs(ctx, glyphs);
strokePath(ctx, UNDERLINE, state.line);
ctx.fill(new Path2D(morph(state.shape)));
```

- 沿路径运动：`gsap.to(point, { motionPath: { path: "M0,0 C…", autoRotate: true } })`，`point` 是 `{ x, y, rotation }` 普通对象。
- 自定义缓动：`CustomEase.create("hop", "M0,0 C0.3,1.4 0.6,1 1,1")`，之后写 `ease: "hop"`。
- 字体先加载好（`FontFace`，见 `scene`）再 `splitText`，否则量出来的宽度是后备字体的。
- 文字用的字体放在素材库里时，同样按 `assetUrl("materials/<库>/fonts/…")` 加载。

## 和其他引擎一起用

gsap 只负责数值随时间变化，和画在哪里无关：Pixi 场景里动画显示对象的 `x`、`alpha`，three 场景里动画 `mesh.position`、`material.opacity`，都在 `update(t)` 里 `timeline.seek(t, true)`。
