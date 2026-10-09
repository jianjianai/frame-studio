# assets：素材

作品自己的素材放在作品的 `public/` 下，代码与文档中用 `films/<名称>/<public 下的路径>` 引用：`public/img/logo.png` → `films/work-1a2b3c4d/img/logo.png`。多个作品共用的素材放在素材库里，用 `materials/<素材库>/<路径>` 引用（见下）。

- 代码中：`assetUrl("films/work-1a2b3c4d/img/logo.png")`、`assetUrl("materials/品牌/logo.svg")`（`src/engine/types`）。
- visual.json / audio.json 中：直接写 `films/...` 或 `materials/...` 字符串。
- 不要写绝对网址或 `../` 路径，也不要引用其他作品的素材。

## 素材库

素材库是同一个作品库里所有作品共用的素材（例如“品牌”“音效”“通用背景”），可以有多个。作品引用素材库（`project.ts` 的 `materials`）后直接使用其中的文件，不用复制。

- `materials_list`：有哪些素材库、本作品引用了哪些；传 `library` 看其中的文件。
- `materials_link`：增加或移除本作品引用的素材库（`create` 新建一个）。
- `materials_use`：用素材库的文件前调用，锁定它们当前的版本，返回 `materials/<库>/<路径>` 地址。素材库里的文件之后再改，作品仍用锁定的版本；要用新版本时加 `update: true`。放进图层或音轨（`layers_edit`、`audio_place`）的素材库文件会自动锁定，保存版本时代码里引用的也会锁定（记录在 `materials.lock.json`，不要手改）。
- `material_write`：修改素材库，一次可以多个操作：`put` 放入文件（网址、本作品的文件或文本内容，例如 SVG、代码），同名文件会成为新版本；`edit` 精确替换修改文本；`move`、`delete` 移动和删除。`material_read` 读取文本文件（`locked: true` 读本作品锁定的版本）。素材库的每次修改都会保存为一个版本。第三方素材在 `source`、`license` 写清来源与许可，记在素材库的 README 里。

### 素材库里的代码

多个作品共用的代码（特效、转场、图表组件、工具函数、着色器）也放在素材库里，作品直接导入，不用复制：

```ts
// 作品的 scene.ts 或 scenes/*.ts
import { particles } from "@materials/特效/particles"; // 素材库「特效」的 particles.ts，扩展名可省略
import glow from "@materials/特效/glow.frag?raw";
```

- 素材库里的代码和作品代码写法一样：素材库第一层的文件用 `"../../src/engine/..."` 导入引擎，每深一层多一个 `"../"`；同一素材库里的文件用相对路径互相导入（`"./noise"`），其他素材库用 `"@materials/<库>/<路径>"`；npm 包照常导入。用到的素材写 `assetUrl("materials/<库>/<路径>")`。
- 版本同样按文件锁定：保存版本时（或 `materials_use`）锁定作品导入的代码、这些代码导入的文件和用到的素材。素材库里的代码之后再改，作品不变；`materials_use` 加 `update: true` 改用新版本（连同它导入的文件）。
- FRAME 把作品用到的版本复制到作品根目录的 `.materials/`（自动生成，不提交），预览、`work_check`、导出和你自己运行的 `tsc` 都从那里读取。不要修改 `.materials/` 里的文件，修改素材库用 `material_write`。
- 素材库里的代码要通用：参数从调用方传入，不要依赖某个作品的文件。

## 获取素材

- 用户上传或拖入的文件在 `work_context` 的 `assets` 中可以看到（含尺寸、时长）；`asset_view` 看图片、视频素材本身的样子（多个拼成一张总览图，视频按时间点抽帧），挑选和安排之前先看一眼。
- `asset_import`：从网址下载（`url`）到作品自己的 `public/`。导入时在 `license` 写清来源和许可，记录在 `production/licenses.md`。别的作品也会用到的素材，放进素材库（`material_write`）。
- 自己生成的图片（如程序生成的纹理、SVG）可以直接写进 `public/`；SVG 直接写文件（外部 AI 用 `files_batch`）。

## 格式建议

- 图片：PNG（透明）/ JPEG / WebP；大背景控制在 4K 以内。
- 视频：H.264 MP4 或 VP9 WebM。视频图层逐帧解码，长视频尽量预先裁短。
- 音频：MP3 / M4A / WAV / OGG。
- 三维：GLB（可用 Draco 压缩）。
- 字体：WOFF2，通过 `FontFace` 加载（见 `scene`）。
