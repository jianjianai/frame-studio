# FRAME · 动画工坊

代码驱动的浏览器动画工作台，使用 pnpm 管理依赖。工作区：`C:\Users\28018\Desktop\动画`。

服务器版本支持登录、内容仓库、素材库、中文语音、MCP/CLI 与持续运行的 AI 会话。Docker / Dockge 部署、GHCR 更新和首次配置见 [服务器工作台](docs/SERVER.md)。原有本地制作与播放流程继续可用。

先读 [工程规范](docs/NEW-PROJECT-STANDARD.md) 和 [接口说明](docs/AUTHORING.md)。当前三个作品已迁移到独立目录，画面与既有配乐保持原样。

## 打开工作台

使用与接口文档保留在 `docs/`；修改记录、验证报告和审查文档独立归档到 [records/](records/README.md)。视频专属记录位于各自的 `projects/<id>/records/`。

双击 **启动工作台.cmd**，或运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

访问 **http://127.0.0.1:5173**。默认仅监听本机，端口冲突会报错。首次安装需要网络，安装后现有作品播放使用本地资源。

启动直接读取各作品 `public/` 中的现有素材，不需要生成公共素材索引。`pnpm assets --project paper-wings` 仅用于手动重建该作品插画，不是启动步骤。

## 每个作品只修改自己的目录

```text
projects/
  paper-wings/            风的邮差 · 32 秒 · PixiJS
  sunny-rail/             日光快线 · 36 秒 · Three.js
  tiny-seed/              一颗种子的四季 · 36 秒 · Canvas
    AGENTS.md README.md
    project.ts scene.ts  元数据与场景
    audio.ts             可选的浏览器音频生成器
    music/               本项目的程序乐谱、音色与音效源码
    public/              音轨、封面、素材、项目索引
    production/          原始材料、MIDI、参数、来源与许可
    records/             本视频修改记录、报告和审查
    scripts/ tests/      项目专属脚本和测试
    exports/ .cache/     忽略的输出与临时文件
src/engine/              公共时钟、声音、字幕、渲染器
src/ui/                  通用播放器与导出入口
scripts/ templates/      公共工具与模板
public/                  公共字体与模型解码器
docs/                    使用指南、接口与工程规范
records/                 公共维护记录、报告和审查
```

视频制作任务只能改 `projects/<id>/`。根配置、共享依赖、公共 UI 与引擎由工作台维护任务修改。`pnpm project:scope <id>` 检查修改边界；生成工具限制写入目标目录并检查路径穿越和符号链接。它不改变外部编辑器的系统文件权限。

项目通过 `projects/*/project.ts` 自动注册；运行素材在项目的 public 下，URL 为 `films/<id>/...`。素材库只读汇总各项目索引，不需要项目修改公共文件。项目测试也自动发现。

## 音轨和播放

每个作品可以独立使用 Edge、OpenAI/兼容接口、Azure 或自己的语音合成器，支持角色声线、逐句缓存和字幕。运行 `pnpm film speech <id> init --provider edge` 后即可用 `pnpm film speech <id> say --text "你好"` 试听；完整 CLI/MCP 用法见 [项目语音合成](docs/SPEECH.md)。

支持多条配乐、旁白、音效以及代码音轨，每轨有起始时间、源偏移、长度、音量和静音。所有音轨与画面共用一个时钟，支持暂停、拖动、逐帧、变速和循环。

代码音轨通过项目 `audio.ts` 在浏览器直接生成播放，不要求预先合成 WAV。视频导出复用同一生成器。旧单音频字段继续兼容，三个现有 Demo 保留其原配乐；新建模板带有可启用的生成音轨示例。接口及示例见 [音频说明](docs/AUDIO.md)。

播放器还提供字幕、全屏、360p/720p/1080p 预览，以及每轨音量/静音控制。场景统一实现绝对时间 `render(time)`，允许直接定位和倒放定位。

## 视频和单帧导出

浏览器点“导出作品”：当前帧 PNG、中文字幕 SRT、含混音的 WebM。WebM 使用固定帧时间逐帧渲染、编码和封装，声音离线混合；可选分辨率和帧率，默认 1080p / 项目帧率，预览画质和播放卡顿不影响输出帧数。显示完成帧数并支持取消，采用当前每轨和总音量/静音。

```powershell
pnpm render sunny-rail --width 1920 --fps 30
pnpm render tiny-seed --start 20 --end 26 --width 1280 --fps 24
pnpm render paper-wings --no-subtitles
pnpm frame tiny-seed --frame 150 --width 1280
pnpm frame tiny-seed --time 5.5
pnpm render tiny-seed --frame 150
```

- 命令视频输出 H.264 + AAC MP4，逐帧渲染，与预览实时帧率无关；FFprobe 验证帧数、尺寸与音频流。
- 帧编号从 **0** 开始，按项目 fps 换算；可用 `--fps` 覆盖。`--time` 指定秒数，与 `--frame` 互斥。
- 单帧输出 PNG，不需要 FFmpeg。视频需要 FFmpeg 和 FFprobe。
- 默认输出 `projects/<id>/exports/`，视频旁写 `.render.json` 报告。
- `--out projects/<id>/exports/name.mp4` 指定路径，必须在目标项目目录内；默认拒绝覆盖，明确加 `--force` 才替换。
- 视频音轨使用项目元数据中的每轨设置，总增益为 1；浏览器临时调音不会写回元数据。
- 宽度 320–3840，32 的倍数，保持 16:9 和编码所需的偶数尺寸；帧率 12–60。
- 支持 `FFMPEG_PATH`、`FFPROBE_PATH`、`FRAME_BROWSER`。没有 Chromium 时执行 `pnpm exec playwright install chromium`。

## AI 制作入口

AI 客户端可通过 [FRAME MCP 服务](docs/MCP.md)直接读取项目、按文件版本批量编辑、查看分镜图片并启动/取消导出。运行 pnpm --silent film mcp；可用 --project 限定项目，--read-only 提供只读接入。

外部 AI 可通过 [远程 MCP](docs/MCP-REMOTE.md) 接入，支持内置 OAuth、Bearer token 和 `.env` 配置的 Cloudflare Tunnel。先运行 `pnpm film mcp-remote init`，填写自己的域名、项目范围、回调和隧道凭据，再执行 `check` 和 `serve`。

Windows 可直接双击 **`启动MCP.cmd`**，自动检查配置并启动远程服务；首次缺少配置时会生成 `.env` 并提示填写。

统一入口是 `pnpm film help`，完整用法见 [AI 工具工作流](docs/AI-WORKFLOW.md)。原命令继续兼容。

```powershell
pnpm --silent film list --json
pnpm --silent film context tiny-seed --json
pnpm film new my-film "我的动画" --renderer canvas --duration 12 --fps 24 --audio generated
pnpm film storyboard tiny-seed --times "0,5,12" --width 480
pnpm film check my-film --strict --json
pnpm film scope my-film
```

context 只读输出项目入口、音轨、素材和修改边界。storyboard 生成带帧号/秒数的拼图及 JSON 清单，默认取镜头标记和首尾帧，只写本项目 exports。脚手架可以直接启用代码音频，并提供项目制作记录。封面时间由项目可选 posterTime 定义。

浏览器编码依赖 WebCodecs；不支持时明确报错，不降级为实时录屏。浏览器编码文件缓存上限 256 MiB，大型成片使用命令导出。代码音频在浏览器与命令导出时都使用离线混音。

## 常用命令

AI 制作的完整命令流程见 [AI-PRODUCTION](docs/AI-PRODUCTION.md)：局部修改与撤销、单项目验证、声画审片、正式分段导出、后台任务及旁白。无需 MCP 也可使用全部主要制作能力。

```powershell
pnpm animation:new my-film "我的动画" --renderer pixi
pnpm assets:import my-film "D:/assets/character.png" --license "来源与许可"
pnpm posters --project my-film
pnpm posters --all                      # 显式全量覆盖封面
pnpm audio:mix my-film projects/my-film/production/mix.json
pnpm assets --project paper-wings       # 可选，只重建该项目插画
pnpm project:check my-film --strict
pnpm project:scope my-film
pnpm project:scope my-film --base <基线提交>
pnpm env:check
pnpm typecheck
pnpm test
pnpm build
$env:FRAME_TEST_PORT="4181"
pnpm test:e2e
pnpm verify
```

检查命令只读，导入/生成/导出命令写入目标项目。普通播放不需执行音频重建。新工程测试写在本工程 `tests/`；公共测试写在根 `tests/`。`pnpm verify` 包括工程检查、类型、单元、构建与浏览器回归。

## 依赖与部署

已接入 PixiJS、Three.js、GSAP、Flubber、Web Audio、模型加载/解码、字幕、PNG、WebM、逐帧 MP4 和测试工具。当前是本机代码制作工作台，不含拖放关键帧编辑、多人服务、云渲染或配音账户。

`pnpm build` 输出 `dist/`，包含各工程运行资源，可部署为静态站点。`pnpm preview` 用于本机验收。源码、锁文件和必要素材纳入 Git；依赖、构建、视频和缓存不提交。

三个 Demo 均使用原采样配乐与动作音效两条音轨，源码在各自 `music/`。原乐器素材和许可在本项目 `public/music/`，由浏览器加载处理，无需预合成整首 WAV；已有音频素材可直接作为文件音轨播放。原 MIDI、乐谱快照归档在各项目 `records/legacy-music/`，历史测量报告在 `records/`。GitHub 私有仓库：[jianjianai/frame-studio](https://github.com/jianjianai/frame-studio)。历史验收记录中的旧路径只代表当时布局，现行入口以本页及各项目 README 为准。
