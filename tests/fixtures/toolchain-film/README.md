# 一束光的旅程：真实工具链验收工程

这是平台维护的可复现视频夹具，不是用户作品库。画面和两条生成音轨均为原创程序代码，没有外部媒体下载、付费模型请求或第三方素材。24 秒影片使用同一光点穿过发射源、透镜、分岔电路与轨道星群，镜头连续移动；中文字幕和 120 BPM 节奏使用同一绝对时间。

## 本地创建与完整导出

从仓库根目录执行，替换 `toolchain-signal` 为尚不存在的项目 ID。创建器明确拒绝覆盖旧目录。

```sh
node tests/fixtures/toolchain-film/create.mjs toolchain-signal
pnpm --silent film validate toolchain-signal --json
pnpm --silent film storyboard toolchain-signal --times 1,7,13,20,23 --width 640
pnpm --silent film render toolchain-signal --width 1280 --fps 30 --out projects/toolchain-signal/exports/signal-journey.mp4
```

源码只写入 `projects/<id>/`，海报、生产约定、README 和测试由现有脚手架生成。该目录按平台约定被 Git 忽略，复现所需的公共夹具在此目录跟踪。`sources.mjs` 同时供真实平台验收使用，避免本地与远程各自复制一份测试场景。

## 平台 MCP → CLI → Docker 执行器

`tests/server/toolchain-real-executor.test.mjs` 创建独立测试仓库，经真实 HTTP MCP 创建作品、按哈希读取并事务写入三份源码，再通过真实 HTTP CLI 上传一个原创 SVG、挂接到素材库。然后由 Docker 执行器输出帧与视频，CLI 持续等待、下载产物，FFprobe 解码计数并检查音轨。帧输出还经 MCP 验证为原生图像内容；最终创建版本检查点。

```sh
node --test --test-reporter=tap tests/server/toolchain-real-executor.test.mjs
```

必须使用**独立测试环境**：`FRAME_TEST_DATABASE_URL` 的数据库名包含 `frame_test`，测试会清空其中的数据；还需 `FRAME_TEST_EXECUTOR=1`、可访问 Docker 的隔离控制容器、`FRAME_TEST_HOST_ROOT` 和本次源码构建的 `FRAME_EXECUTOR_IMAGE`。不能使用生产数据库或现有业务数据目录。测试清理自己创建的执行容器与临时仓库，保留 `.cache/real-film/platform-acceptance.json` 和 `.cache/toolchain-real-film/<run-id>/` 下下载的媒体作为证据。

发布门禁 `pnpm test:server:release` 会自动运行该测试，并拒绝跳过真实执行器用例。普通 `pnpm verify` 不要求 Docker 控制权限，因此会明确跳过真实执行器；普通验证通过不能代替发布级门禁。

## 浏览器审片与浏览器导出

先在平台安装同一份影片源码，调用 `works_browser`，取得持续更新的临时预览 URL，并在页面等待 `FRAME_AI.ready()`。在本地创建与该远程作品相同目录 ID 的夹具；例如远程作品目录为 `work-xxxxxxxx`，本地也使用该 ID。

```sh
FRAME_PREVIEW_URL='<works_browser 返回的临时私有地址>' \
  node tests/fixtures/toolchain-film/review-browser.mjs work-xxxxxxxx
```

临时 URL 只通过环境传入，不提交到仓库或公开记录。脚本执行实际 Chromium 页面，检查 `FRAME_AI.ready/help`、五个时间点的画面、冷跳与反向跳转一致、2 倍速播放、暂停稳定性、音轨控制、错误音轨拒绝、浏览器 WebM 导出与下载、SRT 导出、运行中取消，以及 Blob URL 释放。输出位于本工程 `exports/toolchain-browser/`。

## 媒体技术验收

完整 MP4 和上述浏览器 WebM 都生成后执行：

```sh
node tests/fixtures/toolchain-film/review-media.mjs work-xxxxxxxx
```

脚本在真实离线渲染页核对帧确定性、字幕开关、两条独立音轨非静音、PCM 峰值、切片音频与完整混音的一致性、分轨相加与混音一致性；再解码 MP4/WebM 计帧，核对分辨率、帧率、时长、声道和采样率，并测量响度、真峰值与静音段。

默认要求 MP4 为 24 秒、1280×720、30 fps、720 帧；浏览器片段为 12–14 秒、640×360、30 fps、60 帧。音频容器时长允许少量编码填充。报告在 `exports/toolchain-media/review.json`；图像需要另外打开检查。

这些检查证明工具链与媒体的技术行为，不证明主观音乐品质。报告明确标注未经过人工听审，不能把测量值当作“已经听过整片”。本次任务的实际发现、验证结果和边界统一放在根 `records/`。
