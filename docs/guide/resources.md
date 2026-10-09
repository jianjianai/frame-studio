# resources：素材库里的可复用资源

角色、物品、场景、界面、效果、转场、文字（歌词）和音效写在素材库的代码里，所有作品直接导入使用。把它们声明成资源后，用户在「素材 → 资源」里能看到缩略图、打开预览、调参数、把音效拖到音轨；AI 用 `resources_search` / `resource_view` 查找和查看，不需要读经验库或整个源文件。

## 找和用

- `resources_search`：`query` 写关键词（「下雨 街道」「手机 聊天」「甩镜」），`kind` 限定类别（`character` 角色、`prop` 物品、`set` 场景、`ui` 界面、`effect` 效果、`transition` 转场、`text` 文字、`sound` 音效、`code` 素材库代码导出的函数和类型）。不给 `query` 列出全部资源的目录。
- `resource_view`：`id` 是 `<素材库>/<文件>#<名称>`，例如 `s0rrow/code/kid.ts#kid`。返回用法、导入语句、参数（类型、取值、默认值、说明）、预设，并按作品的节拍和素材版本渲染预览图；`preset` / `params` 换参数，`times` 看动画的几个时刻。只写 `<素材库>/<文件>` 看整个模块：说明、全部资源和导出的函数。
- 在作品代码里导入后调用，写法看资源的「用法」：

```ts
import { drawKid } from "@materials/s0rrow/code/kid";
import { bedroom } from "@materials/s0rrow/code/sets";
```

- 音效用 `audio_place` 的 `sound: "<素材库>/<文件>#<名称>"` 放到音轨（见 `audio`）。
- 导入的代码和用到的素材在保存版本时按文件锁定（见 `assets`），`resource_view` 显示作品实际用的版本。
- 资源不完全合适时，给素材库里的函数加参数（带默认值，不影响已有的作品），用 `material_write` 修改；不要把文件拷进作品再改。

## 声明资源

一个文件导出一个 `resources`，键是资源的名称：

```ts
// 素材库「示例」的 code/ball.ts
import { z } from "zod";
import { defineResources, resource } from "@frame/engine/resources";
import { pulse } from "@frame/engine/tempo";

export const ballOptions = z.object({
  color: z.enum(["#e55", "#5a5", "#55e"]).default("#e55").describe("颜色"),
  r: z.number().min(10).max(200).default(80).describe("半径（设计单位）"),
});
export type BallOptions = z.input<typeof ballOptions>;

/** 跟着作品节拍弹起的球；(x, y) 是落地点。 */
export function ball(ctx: CanvasRenderingContext2D, x: number, y: number, time: number, options: BallOptions = {}) {
  const { color, r } = ballOptions.parse(options);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - r - pulse(time, 6) * 60, r, 0, Math.PI * 2);
  ctx.fill();
}

export const resources = defineResources({
  ball: resource({
    kind: "prop",
    title: "弹跳的球",
    description: "跟着作品节拍弹起的球。节拍来自作品的 tempo。",
    tags: ["球", "节拍"],
    usage: "ball(ctx, x, y, abs, { color, r })",
    params: ballOptions,
    presets: { 大绿球: { color: "#5a5", r: 160 } },
    preview: { width: 600, height: 600, duration: 2, draw: (ctx, t, p) => ball(ctx, 300, 560, t, p) },
  }),
});
```

- `kind`、`title`、`description`、`tags`、`usage`、`presets`、预览尺寸要写成字面量：FRAME 不运行代码就能读出它们（列表、搜索、给 AI 的说明都来自这里）。
- `params` 是 zod 对象：每个字段写 `.describe("…")`（预览里的说明，也给 AI 看），数值写 `.min()` / `.max()`（预览里是滑块），可选值用 `z.enum`，默认值用 `.default()`。函数的参数类型写成 `z.input<typeof 选项>`，参数说明和类型只有一份。
- `preview.draw(ctx, time, params)` 在 `width`×`height`（`draw` 用的单位）的画布上画这个资源，`params` 已经合并了预设和默认值；有 `duration` 时预览带时间轴可以播放，`time` 是缩略图用的时刻（默认 `duration` 的一半）；`background` 是底色；`prepare()` 在第一帧前加载字体、图片。
- 角色画一个有代表性的姿势，预设放常用的造型和表情；场景画整幅；效果画在一张示例画面上；转场在 `duration` 里从一个示例画面转到另一个；文字（歌词）用示例数据。
- 预览和作品用同一段代码：预览在作品的环境里运行（作品的 `tempo`、作品锁定的素材版本），所以跟着节拍动的资源在不同作品里各自对上拍子。
- 节拍、时间都在画的时候读（`beatAt()`、`pulse()`），不要在模块加载时算成常量，也不要写死某首歌、某个作品的东西（字体目录、文案、BPM）：这些从作品传进来，或者作为参数。
- 字体放在素材库里，放完整的字体文件，在 `prepare()` 里用 `FontFace` + `assetUrl("materials/<库>/fonts/<文件>")` 加载。

## 音效

```ts
// 素材库「示例」的 code/sfx.ts
import { defineSounds } from "@frame/engine/resources";
import type { StereoPcm } from "@frame/engine/procedural-audio";

const SR = 48000;
function slam(): StereoPcm {
  /* 用固定种子合成，返回两个等长的 Float32Array */
}

export default defineSounds(SR, {
  slam: { title: "摔门", duration: 0.62, hit: 0.02, tags: ["门"], description: "木门用力关上", make: slam },
});
```

- 每个音效写 `title`、`duration`（秒，放上音轨时的片段长度）、`hit`（主要的那一下在第几秒，用来卡点）、`make()`（返回 `[left, right]`，采样率是第一个参数）。合成要确定：同样的输入得到同样的声音（固定种子）。
- 一个文件 `export default defineSounds(…)` 一个音效库；作品只生成它实际放了的音效。
- 用户在资源预览里能试听、看波形，并把音效拖到音轨上。
