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

引擎（只读）在作品根目录的 `src/engine/`，按文件所在层级写相对路径：

| 文件位置 | 引擎导入写法 |
|---|---|
| `scene.ts`、`project.ts`、`audio.ts` | `"../../src/engine/types"` |
| `scenes/*.ts` | `"../../../src/engine/types"` |

写错时 `work_check` 会给出这个文件应写的路径。

## 工作循环

1. `work_context`：看作品现状、素材、用户正在看的时间点和选中的图层。
2. 用 `frame_guide <主题>` 确认接口，再修改文件。保存后用户的预览立刻更新。
3. `work_check`：类型、素材引用、真实浏览器加载。有错先修。
4. `preview_frames` 亲眼检查画面（`times` 看几个时间点，`count` 取样看整体节奏）；有声音时用 `preview_audio`。
   报错里的 `scenes/x.ts:行:列` 是作品源码中的位置，可以直接定位。
5. 用一两句话告诉用户改了什么、在哪个时间点能看到。版本由用户手动保存，除非用户要求，不要调用 `version_save`。

## 常用工具

| 要做的事 | 工具 |
|---|---|
| 改代码 | 内置 AI 用自己的读写工具；外部 AI 用 `files_batch`（read / write / edit / delete / move，一次可以多个） |
| 排图层 | `layers_get` / `layers_edit`（见 `layers`） |
| 配乐、音效、混音 | `audio_place`、`audio_get` / `audio_edit`，配乐节拍 `preview_audio` 的 `src` + `beats`（见 `audio`） |
| 配音和字幕 | `speech_synthesize`（`lines` + `place` + `subtitles: true` 一次完成整段旁白）、`subtitles_edit`（见 `speech`、`subtitles`） |
| 标题、时长、镜头标记 | `work_update` |
| 素材 | `work_context` 的 assets、`asset_import`、`asset_view`（看素材本身）；素材库 `materials_list`、`materials_link`、`materials_use`、`material_write`（见 `assets`） |
| 版本与导出 | `version_save` / `version_diff` / `version_restore`、`export_video` + `task_status`（完成时返回下载地址） |

## 选择做法

- **以素材为主**（图片、视频、配音、字幕的剪辑排版）：用 `visual.json` 图层 + `audio.json`，见 `layers`、`audio`。
- **动态图形 / 文字动画 / 数据可视化**：Canvas 2D 场景，见 `scene`。需要大量精灵、滤镜用 `pixi`。
- **三维**：`three`（或 `babylon`），可加载 GLB 模型。
- 以上可以混用：在 `visual.json` 里叠加多个 scene 图层。

## 必须遵守

- `render(time)` 只依赖 `time`：可以任意跳转、倒退、重复绘制，结果相同。不要用 `requestAnimationFrame`、`setInterval`、`Date.now()` 或动画库自己的时钟。
- 随机数用固定种子（`seeded()`，见 `tips`）。
- 不在模块加载时播放声音、请求网络或写文件。
- `dispose()` 释放自己创建的 GPU 资源、元素、监听器。
- 素材只用本作品 `public/` 中的文件；网上的素材先用 `asset_import` 导入并在 `license` 中写明来源。
