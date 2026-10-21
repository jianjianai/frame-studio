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
| `AGENTS.md` | 这个作品的需求和约定。新确认的需求写回这里，由你来保持整洁、精练（历史、被否的方案、详细分镜可以放 `production/` 下的文档） |
| `经验.md` | 可以复用、但关联的经验库都不合适（或没有关联）的经验，等着整理进经验库（见 `experience`） |
| `production/` | 制作资料：记录、被否的方案、分镜、脚本、素材来源（`licenses.md`）。不参与运行，需要时读 |

引擎（只读，源码在作品根目录的 `src/engine/`）在任何文件里都这样导入：`import { … } from "@frame/engine/<模块>"`，例如 `"@frame/engine/types"`、`"@frame/engine/math"`、`"@frame/engine/tempo"`。作品和素材库代码写法相同，移动文件不用改导入。

## 工作循环

1. `work_context`：看作品现状、素材、用户正在看的时间点和选中的图层。
2. 用 `frame_guide <主题>` 确认接口，再修改文件。保存后用户的预览立刻更新。
3. `work_check`：类型、素材引用、真实浏览器加载。有错先修。
4. 看画面：`preview_frames`（`times` 指定时间点，`count` 均匀取样，`format: "png"` 无损，`region` 放大一块；每张有画面指纹，同一时刻指纹相同就是同样的画面）。`preview_motion` 逐帧测量画面整体的运动速度和一帧内的变化，`preview_audio` 测量响度和节拍（`listen: true` 给出试听）。`work_context` 的 `lastCheck.current` 说明上次检查的是不是现在的内容。
   报错里的 `scenes/x.ts:行:列` 是作品源码中的位置，可以直接定位。
5. 用一两句话告诉用户改了什么、在哪个时间点能看到。保存版本（`version_save`）由用户决定：用户或任务说明要求保存时再保存，否则不要自己保存。

## 工具

按要做的事列出的工具见 `tools`；每个工具的参数和返回见它自己的说明。

## 选择做法

| 要做的视频 | 用什么 | 见 |
|---|---|---|
| 以素材为主：图片、视频、配音、字幕的剪辑排版 | `visual.json` 图层 + `audio.json` | `layers`、`audio` |
| 动态图形、插画动画、数据可视化 | Canvas 2D 场景 | `scene` |
| 文字逐字出现、描边生长、形状变形、沿路径运动、复杂的动作编排 | Canvas 2D + gsap 时间线 | `gsap` |
| 粒子密集、大量精灵、模糊/置换/发光等滤镜 | PixiJS 场景 | `pixi` |
| 三维：产品展示、角色动画、三维场景 | Three.js 场景，或直接把模型放成图层 | `three`、`layers` |
| 设计师用 AE 做好的动效（图标、贴纸、转场） | Lottie 图层 | `lottie` |

以上可以混用：在 `visual.json` 里叠加多个图层，每个 scene 图层可以用不同的引擎。
- 动手画一个角色、场景、道具或效果之前，先用 `resources_search` 看素材库里有没有现成的：有就导入复用（参数不够就改素材库里的代码，所有作品受益），不要在作品里重画或拷贝一份。

## 必须遵守

- `render(time)` 只依赖 `time`：可以任意跳转、倒退、重复绘制，结果相同。不要用 `requestAnimationFrame`、`setInterval`、`Date.now()` 或动画库自己的时钟。
- 随机数用固定种子（`seeded()`，见 `tips`）。
- 不在模块加载时播放声音、请求网络或写文件。
- `dispose()` 释放自己创建的 GPU 资源、元素、监听器。
- 素材只用本作品 `public/` 中的文件；网上的素材先用 `asset_import` 导入并在 `license` 中写明来源。
