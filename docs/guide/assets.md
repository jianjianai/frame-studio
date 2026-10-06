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
- `material_write`：把文件放进素材库（网址、本作品的文件或文本内容，例如 SVG），同名文件会成为新版本；`material_move`、`material_delete` 移动和删除。素材库的每次修改都会保存为一个版本。第三方素材在 `source`、`license` 写清来源与许可，记在素材库的 README 里。

## 获取素材

- 用户上传或拖入的文件在 `assets_list` 中可以看到（含尺寸、时长）。
- `asset_import`：从网址下载（`url`）到作品自己的 `public/`。导入时在 `license` 写清来源和许可，记录在 `production/licenses.md`。别的作品也会用到的素材，放进素材库（`material_write`）。
- 自己生成的图片（如程序生成的纹理、SVG）可以直接写进 `public/`；SVG 用 `file_write`。

## 格式建议

- 图片：PNG（透明）/ JPEG / WebP；大背景控制在 4K 以内。
- 视频：H.264 MP4 或 VP9 WebM。视频图层逐帧解码，长视频尽量预先裁短。
- 音频：MP3 / M4A / WAV / OGG。
- 三维：GLB（可用 Draco 压缩）。
- 字体：WOFF2，通过 `FontFace` 加载（见 `scene`）。
