# 总览：FRAME 作品是什么

FRAME 作品是一个用 TypeScript 按“绝对时间”绘制的视频：播放器给出时间 `t`（秒），作品画出这一刻的画面；声音由多轨混音文档和可选的代码生成器提供。同一份代码用于实时预览、截图检查和导出 MP4。

## 作品目录 `projects/<名称>/`

| 文件 | 作用 |
|---|---|
| `project.ts` | 元数据：标题、尺寸、时长、帧率、字幕、镜头标记、加载入口。只能写字面量（平台会静态读取它） |
| `scene.ts` | 画面入口，导出 `createScene(options) -> Scene` |
| `visual.json` | 图层时间轴（图片、视频、颜色、Lottie、scene 模块），人工也会在时间轴上编辑 |
| `scenes/*.ts` | 在 visual.json 中以 `scene` 图层使用的场景模块 |
| `audio.json` | 多轨混音：素材、音轨、片段、总线、效果 |
| `audio.ts` | 可选：代码生成的声音（合成器、采样、程序化音效） |
| `public/` | 素材。代码中写 `assetUrl("films/<名称>/文件名")` |
| `AGENTS.md` | 这个作品的需求和约定。新确认的需求写回这里 |

`../../src/engine/` 是引擎（只读），可以直接 import 其中的公开模块。

## 工作循环

1. `work_context`：看作品现状、素材、用户正在看的时间点和选中的图层。
2. 用 `frame_guide <主题>` 确认接口，再修改文件。保存后用户的预览立刻更新。
3. `work_check`：类型、素材引用、真实浏览器加载。有错先修。
4. `preview_frames`（几个时间点）或 `storyboard`（整体节奏）亲眼检查画面；有声音时用 `preview_audio`。
5. 用一两句话告诉用户改了什么、在哪个时间点能看到。每轮结束平台自动保存版本，用户可以一键撤销。

## 选择做法

- **以素材为主**（图片、视频、配音、字幕的剪辑排版）：用 `visual.json` 图层 + `audio.json`，见 `layers`、`audio`。
- **动态图形 / 文字动画 / 数据可视化**：Canvas 2D 场景，见 `scene`、`canvas`。需要大量精灵、滤镜用 `pixi`。
- **三维**：`three`（或 `babylon`），可加载 GLB 模型。
- **React / CSS / SVG 排版**：`remotion`。
- 以上可以混用：在 `visual.json` 里叠加多个 scene 图层，或在 Remotion 中用 `FrameScene` 嵌入 Canvas/WebGL 场景。

## 必须遵守

- `render(time)` 只依赖 `time`：可以任意跳转、倒退、重复绘制，结果相同。不要用 `requestAnimationFrame`、`setInterval`、`Date.now()` 或动画库自己的时钟。
- 随机数用固定种子（`seeded()`，见 `tips`）。
- 不在模块加载时播放声音、请求网络或写文件。
- `dispose()` 释放自己创建的 GPU 资源、元素、监听器。
- 素材只用本作品 `public/` 中的文件；网上的素材先用 `asset_import` 导入并在 `license` 中写明来源。
