# assets：素材

素材放在作品的 `public/` 下，代码与文档中用 `films/<名称>/<public 下的路径>` 引用：`public/img/logo.png` → `films/work-1a2b3c4d/img/logo.png`。

- 代码中：`assetUrl("films/work-1a2b3c4d/img/logo.png")`（`src/engine/types`）。
- visual.json / audio.json 中：直接写 `films/...` 字符串。
- 不要写绝对网址或 `../` 路径，也不要引用其他作品的素材。

## 获取素材

- 用户上传或拖入的文件在 `assets_list` 中可以看到（含尺寸、时长）。
- `asset_import`：从网址下载（`url`）、复制共享素材库中的文件（`libraryId`，先用 `library_list` 查看）。导入时在 `license` 写清来源和许可，记录在 `production/licenses.md`。
- 自己生成的图片（如程序生成的纹理、SVG）可以直接写进 `public/`；SVG 用 `file_write`。

## 格式建议

- 图片：PNG（透明）/ JPEG / WebP；大背景控制在 4K 以内。
- 视频：H.264 MP4 或 VP9 WebM。视频图层逐帧解码，长视频尽量预先裁短。
- 音频：MP3 / M4A / WAV / OGG。
- 三维：GLB（可用 Draco 压缩）。
- 字体：WOFF2，通过 `FontFace` 加载（见 `scene`）。
