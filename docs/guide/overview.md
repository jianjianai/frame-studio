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

引擎（只读，源码在作品根目录的 `src/engine/`）在任何文件里都这样导入：`import { … } from "@frame/engine/<模块>"`，例如 `"@frame/engine/types"`、`"@frame/engine/math"`、`"@frame/engine/tempo"`。作品和素材库代码写法相同，移动文件不用改导入。

## 工作循环

1. `work_context`：看作品现状、素材、用户正在看的时间点和选中的图层。
2. 用 `frame_guide <主题>` 确认接口，再修改文件。保存后用户的预览立刻更新。
3. `work_check`：类型、素材引用、真实浏览器加载。有错先修。
4. `preview_frames` 亲眼检查画面（`times` 看几个时间点，`count` 取样看整体节奏，`format: "png"` 看细节，`region` 放大一块；每张有画面指纹，同一时刻指纹相同就是同样的画面）；动作和运镜顺不顺用 `preview_motion`；有声音时用 `preview_audio`（`listen: true` 给出试听）。`work_context` 的 `lastCheck.current` 说明上次检查的是不是现在的内容。
   报错里的 `scenes/x.ts:行:列` 是作品源码中的位置，可以直接定位。
5. 用一两句话告诉用户改了什么、在哪个时间点能看到。保存版本（`version_save`）由用户决定：用户或任务说明要求保存时再保存，否则不要自己保存。

## 常用工具

| 要做的事 | 工具 |
|---|---|
| 改代码 | 内置 AI 用自己的读写工具；外部 AI 用 `files_batch`（read / write / edit / delete / move，一次可以多个） |
| 排图层 | `layers_get` / `layers_edit`（见 `layers`） |
| 配乐、音效、混音 | `audio_place`、`audio_get` / `audio_edit`，配乐节拍 `preview_audio` 的 `src` + `beats`（见 `audio`） |
| 配音和字幕 | `speech_synthesize`（`lines` + `place` + `subtitles: true` 一次完成整段旁白）、`subtitles_edit`（见 `speech`、`subtitles`） |
| 标题、时长、画面尺寸、节拍、镜头标记、字幕样式 | `work_update`（配乐节拍写进 `tempo`，见 `project`） |
| 看局部细节；不放进时间轴单独看设定图、组件 | `preview_frames` 的 `region`（放大一块）、`scene`（画作品里导出 `createScene` 的另一个模块，见 `scene`） |
| 做个样片（先看效果，不放进成片） | `sheets/<名称>.ts` 导出 `createScene` 和 `sample`（时长、从哪里接着放作品的声音，见 `scene`）；用户在资源管理器点开就能播放，`export_video` 的 `scene` 只导出它。不要做成图片序列或 HTML 网页 |
| 动作、运镜顺不顺（急起急停、跳帧、抖动、重复帧、静止太久） | `preview_motion`：一次看一个镜头或转场（2–6 秒）；整段只看节奏时 `fps` 降到 10–15 |
| 预览卡、导出慢：哪里画得慢 | `work_check` 的 `timing: true`，列出最慢的地方和那里的图层、镜头；改完再测一次对比 |
| 参考同一作品库的其他作品（故事、场景代码、画面、素材） | `works_list` 找作品，`work_read` 读它的文件，`search` 的 `scope: ["works"]` 在它们的代码里搜，`preview_frames`、`work_context` 等读取类工具填 `work` 看画面和结构，`asset_import` 的 `fromWork` 把素材复制过来；其他作品只能读，只修改当前作品 |
| 做另一个版本（竖屏版、换文案） | `work_copy` 复制整个作品（可同时改尺寸），在副本上改；`preview_frames` 的 `compare` 把两个作品同一时刻（`times` 或 `count` 取样）并排画出来对照 |
| 复用素材库里的角色、场景、效果、转场、音效（Canvas 2D、三维、Pixi） | `resources_search` 找（`engine` 可以只找三维或 Pixi 的）、`resource_view` 看详情和预览图，音效用 `audio_place` 的 `sound` 放到音轨（见 `resources`） |
| 素材 | `work_context` 的 assets、`asset_import`、`asset_view`（看素材本身：图片、视频、三维模型、Lottie、全景图、字体）；素材库 `materials_list`（库多时 `query` 查找）、`materials_link`、`materials_use`、`material_write`（见 `assets`） |
| 版本与导出 | `version_save` / `version_diff` / `version_restore`、`export_video` + `task_status`（完成时返回下载地址） |
| 发布后的复盘 | `review_import` 导入平台后台的导出，`review_read` / `review_write` 查看和记录数据、留存（和同类比）和复盘文档，`reviews_compare` 和其他作品在同一发布天数比较（见 `reviews`） |

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
