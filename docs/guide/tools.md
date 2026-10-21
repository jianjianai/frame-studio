# 工具一览：要做的事和对应的工具

按要做的事列出 FRAME 的工具，括号里是讲细节的指南主题；每个工具的参数和返回见它自己的说明。

| 要做的事 | 工具 |
|---|---|
| 改代码 | 内置 AI 用自己的读写工具；外部 AI 用 `files_batch`（read / write / edit / delete / move，一次可以多个） |
| 排图层 | `layers_get` / `layers_edit`（见 `layers`） |
| 配乐、音效、混音 | `audio_place`、`audio_get` / `audio_edit`，配乐节拍 `preview_audio` 的 `src` + `beats`（见 `audio`） |
| 配音和字幕 | `speech_synthesize`（`lines` + `place` + `subtitles: true` 一次完成整段旁白）、`subtitles_edit`（见 `speech`、`subtitles`） |
| 标题、时长、画面尺寸、节拍、镜头标记、字幕样式 | `work_update`（配乐节拍写进 `tempo`，见 `project`） |
| 看局部细节；不放进时间轴单独看设定图、组件 | `preview_frames` 的 `region`（放大一块）、`scene`（画作品里导出 `createScene` 的另一个模块，见 `scene`） |
| 做个样片（先看效果，不放进成片） | `sheets/<名称>.ts` 导出 `createScene` 和 `sample`（时长、从哪里接着放作品的声音，见 `scene`）；用户在资源管理器点开就能播放，`export_video` 的 `scene` 只导出它。不要做成图片序列或 HTML 网页 |
| 逐帧测量画面运动：整体的平移、推拉、旋转速度，切换，一帧内的位移和局部变化，重复帧，没有变化的时段 | `preview_motion`（一次最多 240 帧） |
| 测全片各处画一帧的耗时 | `work_check` 的 `timing: true`：耗时高的地方和那里的图层、镜头，创建时占住页面的图层 |
| 参考同一作品库的其他作品（故事、场景代码、画面、素材） | `works_list` 找作品，`work_read` 读它的文件，`search` 的 `scope: ["works"]` 在它们的代码里搜，`preview_frames`、`work_context` 等读取类工具填 `work` 看画面和结构，`asset_import` 的 `fromWork` 把素材复制过来；其他作品只能读，只修改当前作品 |
| 做另一个版本（竖屏版、换文案） | `work_copy` 复制整个作品（可同时改尺寸），在副本上改；`preview_frames` 的 `compare` 把两个作品同一时刻（`times` 或 `count` 取样）并排画出来对照 |
| 复用素材库里的角色、场景、效果、转场、音效（Canvas 2D、三维、Pixi） | `resources_search` 找（`engine` 可以只找三维或 Pixi 的）、`resource_view` 看详情和预览图，音效用 `audio_place` 的 `sound` 放到音轨（见 `resources`） |
| 素材 | `work_context` 的 assets、`asset_import`、`asset_view`（看素材本身：图片、视频、三维模型、Lottie、全景图、字体）；素材库 `materials_list`（库多时 `query` 查找）、`materials_link`、`materials_use`、`material_write`（见 `assets`） |
| 要登录的网站：下载要账号、网站拦着服务器（YouTube、Sketchfab、B 站） | `browser_open` / `browser_read` / `browser_act`，`browser_login` 请用户登录，`browser_download` 下载进作品，`browser_cookies` 给 yt-dlp（见 `browser`） |
| 三维镜头在用户电脑上的 Blender 里调（abt-scene 技能做的 `abt/<镜头>.json`），用那台电脑的显卡渲染一帧 | `blender_status`、`blender_open`、`blender_run`、`blender_view`（见 `blender`） |
| 版本与导出 | `version_save` / `version_diff` / `version_restore`、`export_video` + `task_status`（完成时返回下载地址） |
| 发布后的复盘 | `review_import` 导入平台后台的导出，`review_read` / `review_write` 查看和记录数据、留存（和同类比）和复盘文档，`reviews_compare` 和其他作品在同一发布天数比较（见 `reviews`） |
