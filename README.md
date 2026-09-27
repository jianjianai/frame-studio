# FRAME · 动画工坊

一个长期复用的、代码驱动的浏览器实时动画工作台。使用 pnpm 管理依赖；不再将每个故事压成独立的单文件 HTML。

本项目目录：C:\Users\28018\Desktop\动画。

## 打开工作台

双击 **启动工作台.cmd**。或者在此目录打开终端：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

浏览器访问 **http://127.0.0.1:5173**。关闭运行终端会停止开发服务器。已经启动时可直接打开该地址，不必重复启动。端口被其他程序占用时会明确报错，不会静默换端口。

当前是本机浏览器工作台，不是已部署的公网网站。依赖安装完成后，示例的画面、字体、配乐与模型解码器均不需要运行时 CDN。首次安装依赖需要网络。

## 内置作品

| 作品           | 片长  | 渲染方式                   | 验证重点                                         |
| -------------- | ----- | -------------------------- | ------------------------------------------------ |
| 风的邮差       | 32 秒 | PixiJS + GSAP              | 分层插画、纸飞机路径、视差跟拍、遮挡、灯塔抵达   |
| 日光快线       | 36 秒 | Three.js                   | 微缩岛屿、列车、车轮、风车、柔和阴影与摄影机轨迹 |
| 一颗种子的四季 | 36 秒 | Canvas 2D + GSAP + Flubber | 矢量形变、根系与茎叶生长、花朵与蜜蜂动作         |

这些是工程演示和风格样片，不是已经完成的 3–8 分钟正式科普影片。故事与场景为原创艺术表达，并不作为植物学等学科的精确模型。

## 已打通的能力

- 作品列表、搜索、渲染类型筛选；每个动画一个目录，自动注册。
- 通用播放器：播放/暂停、任意拖动、逐帧、0.5–2 倍速、循环、音量/静音、中文字幕、全屏、360p/720p/1080p 预览。
- 同一个音频时钟驱动画面。所有动画按绝对时间重绘，支持反向拖动，不依赖前面播放了多少帧。
- PixiJS 2D 分层场景；Three.js 三维模型/灯光/摄影机；Canvas + Flubber 矢量形变；GSAP 受控时间轴。
- 本地 GLB/glTF、Draco、Meshopt、KTX2 模型加载工具，骨骼动画绝对时间求值与可选后处理链。
- 素材库、图片与 SVG 优化、音乐预览、字幕 SRT、PNG 当前帧、WebM 实时录制。
- Playwright + FFmpeg 离线逐帧 MP4，分辨率最高 3840×2160，帧率 12–60；实际导出耗时取决于场景和机器。
- Vitest 单元测试、Playwright 浏览器测试、环境自检、新项目脚手架。

这里没有伪造的“上传成功”“导出完成”按钮，也没有安装却未接入的远程服务。右侧镜头信息和轨道是检查/导航工具，不是关键帧拖放编辑器。镜头、角色和故事通过项目源码制作。

## 日常命令

```powershell
pnpm env:check                          # 检查 Node、依赖、浏览器、FFmpeg、素材
pnpm dev                               # 开发预览，热更新
pnpm animation:new my-film "我的动画" --renderer pixi
pnpm assets:import "D:/assets/character.png" --license "作者/授权来源"
pnpm audio:mix mix.json                 # 配乐、旁白、音效偏移/增益/裁切/淡入淡出混音
pnpm posters                           # 从动画实际画面重新生成封面
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e                          # 自动启动构建产物的预览服务器
pnpm verify                            # 类型、单元、构建、浏览器验收
pnpm format                            # 格式化源码与文档
```

注意：pnpm 本身也有 doctor/import 等内置命令，因此项目自检、导入工具分别使用 env:check 与 assets:import，避免同名命令被覆盖。

pnpm assets 会重新生成演示插画、音乐、波形与模型解码器，不会删除后续导入素材的索引。正常使用已提交的素材即可，不必每次重建。

## 输出视频

播放器的“导出作品”提供 PNG、SRT、浏览器 WebM。WebM 从头实时录制，包含当前音量与静音设置，录制时必须保持页面可见；切换后台会取消录制，避免误交付缺帧视频。

正式输出推荐逐帧 MP4：

```powershell
pnpm render sunny-rail --width 1920 --fps 30
pnpm render tiny-seed --start 20 --end 26 --width 1280 --fps 24
pnpm render paper-wings --width 1920 --fps 30 --no-subtitles
pnpm render my-film --out exports/my-film.mp4
```

- 默认输出 exports/，同目录写入 .render.json 验证报告。
- 使用独立的本地渲染服务与浏览器，逐帧 PNG 输入 FFmpeg。即使实时预览只有 15 FPS，离线仍可输出正确的 30 FPS 视频，只会渲染更久。
- H.264 + AAC，检查帧数、画面尺寸与音频流，不把空文件当成功。
- 默认拒绝覆盖指定名称的已有文件，确需替换时添加 --force。
- --start / --end 是项目时间（秒）。音轨按相同位置裁切，最后输出帧率可能向上补齐到完整一帧。
- 宽度要求 320–3840、16 的倍数；画面保持 16:9。帧率 12–60。
- 默认使用系统 FFmpeg/FFprobe，可用 FFMPEG_PATH / FFPROBE_PATH 指定其他路径。浏览器可用 FRAME_BROWSER 指定。
- 没有可用 Chromium 时：pnpm exec playwright install chromium。

## 目录

```text
src/
  engine/                  主时钟、声音、字幕、渲染器、模型与输出辅助
  projects/
    paper-wings/           project.ts 元数据 + scene.ts 场景
    sunny-rail/
    tiny-seed/
  ui/                      通用播放器、渲染入口
  App.tsx                  作品库、素材库、制作指南
public/
  art/ audio/ posters/     随项目保存的原创演示素材
  imports/                 后续导入素材；保留原始源文件不修改
  vendor/                  Three.js 附带的模型解码器和许可证
  assets.json              素材索引
  waveforms.json           从实际 WAV 计算的波形
scripts/                   创建、导入、资产重建、自检、逐帧输出
scripts/browser.mjs        共用自动化浏览器选择
scripts/render.mjs         可验证的离线 MP4 与封面渲染
scripts/new-animation.mjs  安全的新建工程脚本
templates/                 三种渲染器的最小起步模板
tests/unit/ tests/e2e/     自动化测试
exports/                  本地生成视频，不加入源码版本管理
docs/AUTHORING.md          场景与时间轴协议
AGENTS.md                  后续 AI 制作必须阅读的项目约定
```

## 部署

pnpm build 输出 dist/。将其部署到普通 HTTP 静态站点即可在线播放，不需要数据库或服务端账号。pnpm preview 是本地验收工具，不是生产服务器。Hash 路由不需要服务器 rewrite。

默认只监听 127.0.0.1。需要局域网访问时，明确使用 pnpm dev --host 0.0.0.0，并自行确认 Windows 防火墙范围。不要把 Vite 开发服务器直接暴露到公网。

## 制作边界

这套工程解决“每次重新搭底层”和“单文件无法组织复杂作品”的问题，不自动解决美术和导演问题。正式影片仍需要分镜、角色设计、优质素材、运动表演、镜头节奏和音效设计。先制作 10–20 秒样片，关闭字幕验收动作叙事，再扩成完整短片。

尚未做成 AE/Blender 一样的可视化制作软件：没有拖放关键帧编辑、多人协作、云端渲染队列、内置生成式素材服务或 AI 配音账号。此项目使用代码制作，浏览器播放/验收；后续按真实需要添加，不为“全家桶”堆叠闲置依赖。

当前演示配乐为离线合成的完整音轨，不是播放时独立运行的蜂鸣器。正式影片可直接替换经过授权的配乐、旁白和音效混音。素材来源参见 public/ASSET-LICENSES.md。

## 官方参考

- Vite：https://vite.dev/guide/
- PixiJS Application：https://pixijs.com/8.x/guides/components/application
- Three.js GLTFLoader：https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- GSAP timeline seek：https://gsap.com/docs/v3/GSAP/Timeline/seek()/
- Web Audio start：https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start
- Playwright：https://playwright.dev/docs/intro
- FFmpeg：https://ffmpeg.org/documentation.html
