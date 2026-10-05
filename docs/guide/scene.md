# scene：画面协议与 Canvas 2D

`scene.ts` 导出 `createScene`。播放器、截图和导出都调用同一个 `render(time)`。

> 下面的示例写在 `scene.ts` 里。放在 `scenes/` 下的模块要多一层：`"../../../src/engine/types"`。

```ts
import type { Scene, SceneOptions } from "../../src/engine/types";

export function createScene({ width, height, quality }: SceneOptions): Scene | Promise<Scene> {
  // quality: "draft" | "standard" | "high"，可据此降低粒子数量等
  return {
    canvas,                                       // 输出画面的 <canvas>
    render(time) { /* 画出 time 秒的画面 */ },   // 可以是 async
    prepareFrame: async (time, { signal }) => {}, // 可选：加载这一帧需要的异步资源
    dispose() { /* 释放资源 */ },
  };
}
```

## Canvas 2D 示例

```ts
import type { Scene, SceneOptions } from "../../src/engine/types";
import { clamp, phase, smooth, mix, seeded } from "../../src/engine/math";

export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const random = seeded(7);
  const stars = Array.from({ length: 120 }, () => ({ x: random(), y: random(), r: 0.5 + random() * 1.5 }));

  return {
    canvas,
    render(t) {
      ctx.fillStyle = "#0b1020";
      ctx.fillRect(0, 0, width, height);
      for (const star of stars) {
        ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(t * 2 + star.x * 10));
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(star.x * width, star.y * height, star.r * (height / 1080), 0, Math.PI * 2);
        ctx.fill();
      }
      const p = smooth(phase(t, 0.5, 1.7));   // 0.5s→1.7s 从 0 平滑到 1
      ctx.globalAlpha = p;
      ctx.fillStyle = "#ffd84a";
      ctx.font = `700 ${Math.round(height * 0.1)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("HELLO", width / 2, mix(height * 0.6, height * 0.5, p));
      ctx.globalAlpha = 1;
    },
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}
```

## 规则

- 所有尺寸按 `width`/`height` 比例计算：预览画质会改变实际像素尺寸（导出用 high）。
- 画面状态完全由 `t` 计算。需要累积的效果（粒子轨迹、物理）用解析公式，或在内部从 0 推进到 `t` 并缓存，倒退时重新计算。
- 异步资源（图片、字体、模型）在 `createScene` 中 `await` 加载，或放到 `prepareFrame`。图片用 `assetUrl`：

```ts
import { assetUrl } from "../../src/engine/types";
const image = new Image();
image.src = assetUrl("films/work-1a2b3c4d/bg.jpg");
await image.decode();
```

- 自定义字体：

```ts
const font = new FontFace("Brand", `url(${assetUrl("films/work-1a2b3c4d/fonts/brand.woff2")})`);
document.fonts.add(await font.load());
```

- 一个作品可以有多个场景模块：放在 `scenes/` 下，通过 `visual.json` 的 scene 图层组合（见 `layers`），或在 `scene.ts` 里自己按时间切换。
- `Scene` 还可以提供 `debug.parameters()/setParameters()` 暴露可调参数，visual.json 的 scene 图层可用 `parameters` 设置它们。
