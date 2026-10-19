# tips：动画手法、性能与常见错误

## 时间与缓动（`src/engine/math.ts`）

```ts
import { clamp, mix, phase, smooth, easeInOut, seeded, sampleKeys } from "@frame/engine/math";
const p = phase(t, 2, 3.5);         // t 在 2→3.5 秒之间从 0 线性到 1（两端截断）
const e = easeInOut(p);              // 缓入缓出；smooth 是更柔和的 smoothstep
const x = mix(-200, 0, e);           // 插值
const random = seeded(42);           // 固定种子随机数：每次 createScene 都得到同一序列
```

- 让动画按 `beats`（镜头标记）组织，方便用户说“第二个镜头”。
- 有配乐时，把关键动作对齐节拍：`beat = 60 / bpm`。

## 性能

- 预览实时播放：每帧绘制预算约 16 ms。大量对象用 Pixi/Three；Canvas 2D 中缓存不变的内容（离屏 canvas）。
- 画一帧的耗时：`work_check` 的 `timing: true` 按工作台预览的尺寸和画质测全片，列出耗时是中位 2 倍以上的地方和那里的图层、镜头（用户电脑上开着 FRAME 时在那里用显卡测，接近实际速度；否则在服务器上软件渲染，数值比一般电脑慢）；`preview_frames` 也给出每张画了多少毫秒。
- 不要在 `render` 里创建大对象、加载图片或编译着色器；在 `createScene` 中准备。
- `createScene` 也不能长时间占住页面：作品的代码都在浏览器的一个主线程上运行，它在算东西（生成地形、解析模型、量带骨骼模型的尺寸、在画布上画大贴图）时，画面和声音都停，预览显示「缓冲中」，显卡再好也没用。图层在出现前约 3 秒提前创建，这时同样会卡住正在播放的画面。`work_check` 的 `timing` 列出创建时卡住页面的图层和卡了多久。改法：
  - 每次都一样的结果只算一次：放在模块级的变量里，几个场景共用（地形、程序生成的几何体、离屏画好的贴图）。
  - 模型用 GLB（FBX 解压、解析慢得多）；带骨骼的模型量尺寸不要用 `Box3.setFromObject`（逐个顶点算骨骼变形），用各 `geometry.boundingBox` 合并，或者量一次记下来。
  - 剩下的重计算拆成小段，段与段之间 `await nextTask()`（`@frame/engine/scheduling`），让播放插进来；纯计算（噪声、网格数据）可以放进 Web Worker，用上电脑的其他 CPU 核心。
  - 物体第一次出现在画面里时才编译着色器、上传贴图，会卡 0.1–0.3 秒：自己建渲染器的场景，建好后调用 `await prewarmScene(renderer, scene, camera)`（`@frame/engine/three-assets`）；`createThreeScene` 和模型图层已经自动这样做。
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
| WebGL context 创建失败 | 当前浏览器没有 GPU 加速（浏览器设置里关了硬件加速）；用 `preview_frames` 检查 |

## 交付前

- `work_check` 无错误。
- 告诉用户可以在“导出”里生成 MP4。
