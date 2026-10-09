# tips：动画手法、性能与常见错误

## 时间与缓动（`src/engine/math.ts`）

```ts
import { clamp, mix, phase, smooth, easeInOut, seeded, sampleKeys } from "../../src/engine/math";
const p = phase(t, 2, 3.5);         // t 在 2→3.5 秒之间从 0 线性到 1（两端截断）
const e = easeInOut(p);              // 缓入缓出；smooth 是更柔和的 smoothstep
const x = mix(-200, 0, e);           // 插值
const random = seeded(42);           // 固定种子随机数：每次 createScene 都得到同一序列
```

- 节奏：重要的出现约 0.4–0.8 秒，转场 0.3–0.6 秒；留出静止时间让观众看清文字（每秒 4–6 个汉字）。
- 让动画按 `beats`（镜头标记）组织，方便用户说“第二个镜头”。
- 有配乐时，把关键动作对齐节拍：`beat = 60 / bpm`。

## 性能

- 预览实时播放：每帧绘制预算约 16 ms。大量对象用 Pixi/Three；Canvas 2D 中缓存不变的内容（离屏 canvas）。
- 不要在 `render` 里创建大对象、加载图片或编译着色器；在 `createScene` 中准备。
- `quality === "draft"` 时可以减少粒子、关闭阴影。
- 长作品分成多个 scene 图层，只在需要的时间段活跃（不活跃的图层会被释放）。

## 常见错误

| 现象 | 原因 |
|---|---|
| 跳转后画面不对、倒放出错 | 状态在帧之间累积了；改成只依赖 `t` |
| 导出与预览不一致 | 用了 `Date.now()`、`Math.random()`、CSS/库自带时钟 |
| 素材 404 | 路径没有 `films/<名称>/` 前缀，或文件不在 `public/` |
| `project.ts 元数据无效` | 字段不是字面量，或缺少必需字段（见 `project`） |
| 声音无输出 | audio.json 没在 project.ts 声明，clip 时间超出，或生成器名字与 `module` 不一致 |
| WebGL context 创建失败 | 当前浏览器没有 GPU 加速；用 `preview_frames` 检查（软件渲染） |

## 交付前

- `work_check` 无错误；`preview_frames`（`count` 取样）检查整体节奏；`preview_audio` 检查全片响度。
- 告诉用户可以在“导出”里生成 MP4。
