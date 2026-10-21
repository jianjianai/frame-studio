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

- **`width`/`height` 是这次渲染的实际像素，不是作品的设计尺寸**：预览、`preview_frames`（默认 720 宽）会缩小，导出是全尺寸。所有位置、字号、线宽都按比例算，不要写死像素。最简单的写法：按作品尺寸（例如 1080×1920）设计，每帧先 `ctx.setTransform(width / 1080, 0, 0, height / 1920, 0, 0)` 再按设计坐标画。
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

## 单独画一个模块：设定图、组件、样片

人物设定图（阵容、表情、动作、走路循环）、一个道具或组件单独调、一段样片，不用放进时间轴：写一个导出 `createScene` 的模块（写法和 `scenes/*.ts` 一样），用 `preview_frames` 的 `scene` 画出来。它不在 `visual.json` 里，不影响成片和用户的预览；`work_check` 照样检查它的类型。约定放在 `sheets/` 下，`t` 可以当页码或动画时间用（0 到下面 `sample` 的 `duration`，没写就是作品时长）。用户在资源管理器里右键它选「单独播放」就能看到。

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

### 样片

用户想先看一个想法、一段效果（“做个样片”），又不想放进成片时，在 `sheets/` 下写这样一个模块，并导出 `sample` 说明它是样片：

```ts
// sheets/剪纸.ts
import type { Sample, Scene, SceneOptions } from "@frame/engine/types";

export const sample: Sample = { duration: 4.2, audioFrom: 12.04 };

export function createScene(options: SceneOptions): Scene {
  // 和 scenes/*.ts 一样；render(t) 的 t 从 0 到 4.2
}
```

- `duration`：样片的秒数（不写就是作品时长）。只写字面量数字：资源管理器不运行代码就要读出它。
- `audioFrom`（可选）：作品时间里的秒数。样片从这一刻接着放作品的声音（audio.json 的配乐、音效、配音），`@frame/engine/tempo` 的节拍（`beatAt`、`pulse`）和字幕也换算到样片的时间，和声音对齐。不写就没有声音。
- 用户在资源管理器里点开这个文件就是样片播放器：实时播放、拖动、逐帧、循环、慢放，代码保存后立即更新；可以截图发给你（消息里写明是样片的画面），也可以在「导出」里只导出这个样片。编辑区像 VS Code 一样可以分屏：把样片、成片预览或视频的标签页拖到一侧并排看，并排有两个以上能播放的东西时，「同步时间轴」以各自当前的时间对齐，之后一起播放、暂停、拖动（[FRAME] 的“用户在编辑器中打开着”会写明分屏同时显示着什么）。用户自己的视频（参考片、别处做的样片）上传到 `sheets/`：随作品保存，但不像 `public/` 那样被每个打开作品的浏览器下载。要看这些视频的内容用 `asset_view`。你自己看用 `preview_frames` 的 `scene`（不给 `times` 时在样片里均匀取样），导出用 `export_video` 的 `scene`。
- 样片本身就是给用户看的：不要把它的画面渲染成图片序列、GIF，或打包进 HTML 网页给用户看。做好后告诉用户在资源管理器里打开 `sheets/剪纸.ts`。用户确定要用时，再把代码挪进 `scenes/`、放上时间轴。
