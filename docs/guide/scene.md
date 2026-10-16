# scene：画面协议与 Canvas 2D

`scene.ts` 导出 `createScene`。播放器、截图和导出都调用同一个 `render(time)`。

```ts
import type { Scene, SceneOptions } from "@frame/engine/types";

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
import type { Scene, SceneOptions } from "@frame/engine/types";
import { clamp, phase, smooth, mix, seeded } from "@frame/engine/math";

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

- **`width`/`height` 是这次渲染的实际像素，不是作品的设计尺寸**：预览、`preview_frames`（默认 960 宽）会缩小，导出是全尺寸。所有位置、字号、线宽都按比例算，不要写死像素。最简单的写法：按作品尺寸（例如 1080×1920）设计，每帧先 `ctx.setTransform(width / 1080, 0, 0, height / 1920, 0, 0)` 再按设计坐标画。
- 画面状态完全由 `t` 计算。需要累积的效果（粒子轨迹、物理）用解析公式，或在内部从 0 推进到 `t` 并缓存，倒退时重新计算。
- 异步资源（图片、字体、模型）在 `createScene` 中 `await` 加载，或放到 `prepareFrame`。图片用 `assetUrl`：

```ts
import { assetUrl } from "@frame/engine/types";
const image = new Image();
image.src = assetUrl("films/work-1a2b3c4d/bg.jpg");
await image.decode();
```

- 自定义字体：

```ts
const font = new FontFace("Brand", `url(${assetUrl("films/work-1a2b3c4d/fonts/brand.woff2")})`);
document.fonts.add(await font.load());
```

- 一个作品可以有多个场景模块：放在 `scenes/` 下，通过 `visual.json` 的 scene 图层组合（见 `layers`），或在 `scene.ts` 里自己按时间切换。模块的名称在三处要一致：文件 `scenes/<名称>.ts`、`scene.ts` 里 `createCompositionScene` 的第三个参数（`<名称>: () => import("./scenes/<名称>")`）、图层的 `source.module`。新作品自带的 `title` 模块可以直接改内容，改名要三处一起改。
- `Scene` 还可以提供 `debug.parameters()/setParameters()` 暴露可调参数，visual.json 的 scene 图层可用 `parameters` 设置它们。

## 单独画一个模块：设定图、组件

人物设定图（阵容、表情、动作、走路循环）、一个道具或组件单独调，不用放进时间轴：写一个导出 `createScene` 的模块（写法和 `scenes/*.ts` 一样），用 `preview_frames` 的 `scene` 画出来。它不在 `visual.json` 里，不影响成片和用户的预览；`work_check` 照样检查它的类型。约定放在 `sheets/` 下，`t` 可以当页码或动画时间用（不能超过作品时长）。

```ts
// sheets/人物.ts：preview_frames { scene: "sheets/人物.ts", times: [0, 1] }
import type { Scene, SceneOptions } from "@frame/engine/types";
import { drawPerson } from "../scenes/people"; // 作品里画人物的函数（举例）

export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    canvas,
    render(t) {
      ctx.setTransform(width / 1080, 0, 0, height / 1920, 0, 0);
      ctx.fillStyle = "#f3e6e6";
      ctx.fillRect(0, 0, 1080, 1920);
      const page = Math.floor(t); // 0：阵容，1：表情
      ["hero", "friend", "elder"].forEach((kind, i) => drawPerson(ctx, { kind, x: 200 + i * 340, y: 900, mood: page ? "cry" : "calm" }));
    },
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}
```

- 看细节（脸、手、发丝、小字）用 `region` 放大一块：`[x, y, 宽, 高]` 按作品画面像素，`scale` 是倍数（最多到画面长边 3840 像素，1080×1920 的作品是 2 倍）。
- 不要为了看设定图去改 `scene.ts`、往 `visual.json` 里加临时图层，也不要自己另起浏览器渲染。
