# 架构

FRAME Studio 是一个 Node 进程。它同时提供工作台界面、JSON API 与 WebSocket、编译作品的 Vite 开发服务器、MCP 端点，并管理 AI 代理进程和无界面浏览器。

```
浏览器 ─┬─ 工作台界面 (web/)  ──HTTP/WS──┐
        └─ 预览舞台 iframe (src/preview/stage) ─┤
                                              ▼
                                   server/ (单进程)
         ┌───────────┬─────────────┬─────────┴──────┬─────────────┬───────────┐
       works/repos  preview(Vite)  tools ─ MCP /mcp   ai (ACP)      render      speech
       Git 分支     编译作品+热更新   CLI / 内置 AI     Claude/Codex  Chromium    Edge/OpenAI/
                                                       代理进程      +ffmpeg     sherpa-onnx
```

## 数据目录（`FRAME_HOME`，默认 `~/.frame-studio`）

```
settings.json, secrets.json(0600)   设置与密钥（API Key、GitHub 令牌）
repos/<库>/                          作品库：裸 Git 仓库（local = 本地库，其余为 GitHub 克隆）
works/<库>/<作品>/                   作品工作目录 = works/<作品> 分支的 worktree
   projects/<名称>/                  作品文件（这才是作品内容）
   src → 引擎, node_modules → 依赖, docs → 文档     （链接，不提交）
   AGENTS.md, CLAUDE.md, tsconfig.json             （平台生成，不提交；AGENTS.md 是 AI 的会话说明）
   .claude/skills, .agents/skills                  作品库技能文件夹的链接（AI 会话开始时建立，不提交）
   .materials/<素材库>/<路径>                        作品导入的素材库代码（@materials/…）在作品所用版本的副本（平台生成，不提交）
libraries/<库>/<id>/                 素材库：每个库是分支 materials/<id>，各自一个 worktree（作品在 project.ts 的 materials 中按 id 引用，用到的文件版本锁定在作品的 materials.lock.json）；.trash/<名称>/ 是回收站里的素材库（分支 materials-trash/<名称>，附 .trashed.json）
experience/<库>/<id>/                经验库：每个库是分支 experience/<id>，各自一个 worktree（作品在 project.ts 的 experiences 中按 id 关联）；.trash/ 同上（experience-trash/<名称>）
reviews/<库>/                        frame/reviews 分支的 worktree：作品发布后的复盘（每个作品一个文件夹 <作品 id>/：review.json、复盘文档、raw/ 原始文件）
skills/<库>/                         frame/skills 分支的 worktree：作品库的 AI 技能（每个技能一个文件夹，入口 SKILL.md）；还没有技能时是普通文件夹
exports/<库>/<作品>/                  导出的视频
models/speech/                       下载的语音模型
models/beat-this/                    节拍分析模型（本机运行时第一次分析下载；Docker 镜像自带）
ai/sessions/                         AI 对话记录（JSONL）、图片、AI 上一轮结束时的作品文件快照
browser/<库>/profile/                每个作品库的登录状态浏览器的用户数据（网站的登录、缓存）；session-cookies.json(0600) 是浏览器关闭时没有有效期的 cookie，下次启动时放回
tmp/                                 导出快照、Vite 缓存；library/<库>/.materials/ 是资源预览运行的素材库代码副本（素材库现在的版本，不属于任何作品）
cache/covers/<库>/<作品>.webp|.json   首页封面（作品画面或封面图片的缩略图）及其来源版本
```

一个作品 = 一个分支，所以各作品的历史、推送、拉取互不影响。素材库和经验库也一样，每个库一个分支（`server/library-branches.mjs`）：库的 id 就是分支名的最后一段，新建后不再改变，作品的引用、素材地址和锁定都按 id；显示的名称是 README 的第一个「# 」标题，改名只改它。列出库时检出本机还没有的库分支（另一台设备新建的，取 GitHub 之后），GitHub 上已经删除或移到回收站的本机分支在没有只属于本机的内容时删掉。回收站也是分支名：移到回收站把 `works/<id>` 改名为 `trash/<id>`（本机和 GitHub 一起改，GitHub 上的改名是带 `--force-with-lease` 的原子推送）。「释放本地空间」删除已同步作品的本地分支和工作目录，再删除没有本地分支引用的 LFS 文件并 `git gc`。打开作品时检出到唯一的工作目录：编辑器、预览、AI、CLI、MCP 都读写这里的同一份文件。

「迁移」把本地作品库（没有 GitHub）里的一个作品移到另一个作品库，作品 id 不变（`routes/works.mjs` 编排，`works.move` 处理分支）：先把未保存的修改存为一个版本；作品用到、目标库没有的素材库和经验库按现在的样子复制过去，各保存为一个版本（目标库有同 id 的库时用目标库的）；再把分支所有版本引用的 LFS 文件链接到目标库的 LFS 存储，`git fetch` 分支，确认两边相同后删除原工作目录和分支，在目标库检出。素材锁定的是原库的 Git blob，迁移后改锁目标库现在的版本（目标库没有的文件去掉锁定），存为一个版本，已发布的作品也一样。复盘文件夹在两个复盘分支上各存一个版本；导出的视频、封面缓存、最近打开、AI 请求删除的标记跟着改；AI 对话改到新作品库，正在连接的代理会话先 `session/close`，下一条消息在新目录恢复，Claude 的会话记录（`~/.claude/projects/<目录名>/`）一起移到新目录名下。浏览器里没完成的本机导出收到 `work-moved` 后改从新位置载入，正在渲染时不能迁移。最后对原库 `reclaim` 释放空间。

「取消链接」把一个 GitHub 作品库从这台电脑移除，GitHub 上的仓库不动（本地作品库不能取消链接）。先取一次 GitHub，列出只在本机的内容：有未保存修改的工作目录、GitHub 没有的版本（两边都有新版本时要先在作品里处理）；可以一键保存并推送，或者明确选择丢弃。AI 正在工作或有导出在进行时拒绝。确认后删除这个库的克隆、工作目录、素材/经验/复盘的 worktree、导出的视频，以及各模块通过 `repos.beforeRemove` 登记的东西（封面缓存、AI 对话、文件监视、同步状态、素材库缓存）。

## 模块（`server/`）

| 模块 | 作用 |
|---|---|
| `app.mjs` | HTTP 服务、路由分发、静态文件、`/files/<库>/<作品>/films/...` 素材服务、WebSocket 事件（`/api/ws`；其他插件的 WebSocket 按路径登记在 `services.sockets`） |
| `config.mjs` `settings.mjs` | 环境变量、数据目录、设置与密钥 |
| `http.mjs` | 路由器、Range 文件发送、认证（本机免登录 / `FRAME_PASSWORD` / Bearer 令牌 / 内部令牌）、CSRF 与 DNS rebinding 防护 |
| `repos.mjs` `works.mjs` `git.mjs` `github.mjs` | 作品库与作品分支、版本、推送拉取、GitHub API |
| `project-meta.mjs` | 不执行代码地读取/修改 `project.ts` 字面量字段 |
| `documents.mjs` | `visual.json` / `audio.json` 的读取与原子编辑（UI 与 AI 共用） |
| `preview.mjs` | Vite 中间件；拦截作品文件的热更新，改为向舞台发送 `preview-update`；预览页附带要导入的全部模块（modulepreload 与各模块的 etag） |
| `precache.mjs` | 浏览器本地缓存的播放文件清单（作品 `public/` 的文件和作品用到的素材库文件，带内容版本）和小文件打包下载 |
| `render.mjs` | 无界面 Chromium：渲染帧、分镜、封面画面、响度分析、运行检查、MP4 导出（ffmpeg） |
| `render-gpu.mjs` | 用户浏览器里打开着的工作台页面，代替无界面 Chromium 用显卡画 AI 要看的画面（见「用用户的显卡画」） |
| `remote-sync.mjs` | 连接 GitHub 的作品库自动同步：保存版本后在后台推送（作品、经验库、素材库、复盘分支）；打开作品、手动刷新和推送被拒时只取这个分支和 GitHub 对比，能快进就自动更新，否则广播 `remote-state`（`behind` / `diverged` / `conflict` / `error`），工作台和 AI 的每条消息都会提示；用户选择更新、合并、采用 GitHub 或保留本机；启动后和每半小时补推只领先于 GitHub 的分支 |
| `covers.mjs` | 首页封面：`project.ts` 的 `poster` 图片，或作品在 `posterTime`（不写时自动挑选）的画面。按作品文件的版本缓存；列出作品时在后台逐个重做过期的封面，完成后广播 `work-cover` |
| `checks.mjs` | 作品检查：元数据、TypeScript、素材引用、真实加载 |
| `tools/` | 工具注册表（zod 参数），MCP、CLI、内置 AI 共用 |
| `mcp.mjs` | `/mcp`（Streamable HTTP）与 `/api/tools` |
| `ai/` | ACP 客户端：代理进程池、会话、权限、登录、自定义 API |
| `speech/` | 配音引擎、语音输入与模型下载。语音输入（`listen.mjs`）：聊天输入框把麦克风的 16 位 PCM 通过 `/api/speech/listen` 发来，Silero VAD 在停顿处分句，SenseVoice（sherpa-onnx，离线）识别每一句；正在说的那句隔一会儿重新识别一次，边说边出字。也可以改用 OpenAI 兼容的 `/v1/audio/transcriptions`（每句说完后出字）。识别在服务端排队，一次一句 |
| `audio-analysis.mjs` `beat-this/` | AI 的“听”：ffmpeg 解码后算响度；节拍和小节交给 [Beat This!](https://github.com/CPJKU/beat_this)（MIT）模型，由 `beat-this/analyze.py` 在独立的 Python 进程中运行（`FRAME_BEAT_PYTHON`），一次只跑一个 |
| `asset-previews.mjs` `thumbnails.mjs` | 模型、Lottie、全景图、字体的缩略图：作品 `public/` 里的按大小和修改时间、素材库的按 Git blob 缓存在 `cache/assets/`；`thumbnails.mjs` 是资源和素材共用的后台队列（一次一个，最新的请求先画，画不出来的记住几分钟），画好后广播 `asset-thumb` / `resource-thumb` |
| `resources.mjs` | 素材库代码里声明的资源（`defineResources` 的角色、场景、效果……，`defineSounds` 的音效）和导出的函数：不运行代码，用 Babel 静态读出字面量字段、zod 参数和注释，按 Git blob 缓存；`resources_search` / `resource_view` 工具、工作台的资源列表、缩略图（无界面浏览器在后台逐个渲染，最新的请求先画；没画好时接口返回 202，画好后广播 `resource-thumb`；按代码版本缓存在 `cache/resources/`，画不出来的按版本记住几分钟）；素材库概况（资源和音效数量、常用画布、README 第一段）给 `work_context` 和会话说明。预览和缩略图运行素材库现在的代码（`tmp/library/<库>/`，素材地址 `/files/<库>/-/`），不混用作品锁定的旧文件 |
| `reviews.mjs` `review-data.mjs` `review-analysis.mjs` `review-import.mjs` `review-segments.mjs` `sheets.mjs` | 复盘：作品发到平台后的发布记录、按时间记录的累计数据、留存曲线（和同类作品的）、每小时数据、关键时刻和自定义分段（`review.json`）、平台导出的原始文件（`raw/`，原样保存）和复盘文档，放在 `frame/reviews` 分支而不是作品分支（已发布的作品只读，数据却一直在增加；所有作品在一个文件夹里便于对比）。每次修改立即保存为一个版本并自动推送；只读的请求不会建出这个分支。`review-data.mjs`：数据格式和操作、按发布后同一天数取数（有每小时数据时正好算到那一天）、比例、中位数；`review-analysis.mjs`：每秒和每段流失率是同类的几倍、“按同类走”的收益、流量的几波，以及给 AI 的文字；`review-import.mjs`：按表格内容认出抖音创作者中心的导出和评论导出，直接读成数据；`review-segments.mjs`：从作品本身取分段（visual.json 的图层、镜头标记、字幕，配乐旁的 .lrc 按 audio.json 的剪辑换算到作品时间）；`sheets.mjs` 不执行公式地把 xlsx / csv 读成文字表格（GB18030、UTF-16 编码的导出也能读）。工具 `review_import` / `review_read` / `review_write` / `reviews_compare`，工作台「复盘」视图和首页的复盘对比页 |
| `libraries.mjs` | 素材库、经验库的回收站（删除的库移到分支里的 `.trash/<名称>/`，可以恢复——名称被占用时换一个——或彻底删除；每次都立即保存为一个版本，经验库只提交这些路径，其他未保存的修改不受影响；列表、搜索、资源目录都不看回收站），以及在很多库里挑选：检索词（中文按相邻两字比较）、名称的宽松匹配和最接近的名称、每个库有几个作品在用，以及“适合某个作品”的程度和理由（库的名称、介绍和内容——素材库里资源的名称和标签、经验库的文档标题——与作品的标题、说明、标签相近；同一系列、标题相近或关联了相同库的作品在用）。工作台的选择弹窗、面板的推荐、AI 工具的排序和会话说明都用它；会话开始前 `prepare` 一次，会话说明（同步生成）读它的结果 |
| `skills.mjs` `branch-routes.mjs` | 作品库的 AI 技能（Agent Skills）：放在 `frame/skills` 分支，同一作品库的所有作品共用，其他作品库看不到。AI 会话开始前，把作品根目录的 `.claude/skills`（Claude Code）和 `.agents/skills`（Codex）链接到 `skills/<库>/`，两个代理都按自己找项目技能的方式找到它们（Claude 和账号、本机的全局技能照常可用）；两个代理改 `.claude/`、`.agents/` 下的文件前都会先请求确认。聊天输入 `@`（任意位置）或开头的 `/`（先打字再回到开头输入也行）选技能，任何时候都列出作品库的技能，不依赖代理；`/` 还列出代理自己的命令（Codex 以 `$名称` 列出的技能除外）。消息里的 `@<名称>` 和开头的 `/<名称>` 在 `[FRAME]` 中写明用户点名要用的技能（Claude 用 Skill 工具加载，Codex 读它的 SKILL.md）；`/<技能>` 以 `@<技能>` 发给代理，不当作代理的命令，所以照常带上 `[FRAME]`。工作台「技能」视图上传（文件夹在浏览器里打成 zip；.zip / .skill 压缩包；单个 SKILL.md，按 `name` 命名）、新建、在编辑器标签页里改、下载、删除，每次修改立即保存为一个版本；AI 用自己的工具改的，在每轮结束时保存。每个技能的 Markdown 文档（经验和知识）同时是一个经验库，id 为 `skill:<技能名>`（`experience.mjs` 的 `locate`）：它的文件就是技能文件夹里的文件，不另存一份；作品可以像别的经验库一样关联它（`project.ts` 的 `experiences`），AI 用 experience_read / experience_write 读写，简报里列出、每条消息告知变化；在工作台或 AI 对话外的修改立即保存为技能的版本，对话里的在本轮结束时保存（版本说明用 AI 的 note）。它不能在经验库里改名、删除或移到回收站，也没有自己的版本（都在「技能」里）。技能的其他文件（程序、预览、数据）列在「素材」的素材库里，同样就是技能的文件：图片、声音、视频在标签页里看，「复制到作品素材」复制进作品的 public/，「引用到 AI 聊天」告诉 AI 它在 `.claude/skills/`（Codex 是 `.agents/skills/`）下的位置；这些文件不能像素材库文件那样被作品直接引用。分支在第一个技能保存时才建立（读取不建）。`branch-routes.mjs` 是复盘和技能这类“每次修改即一个版本”的共用分支的版本接口 |
| `browser.mjs` `browser-proxy.mjs` `tools/browser-tools.mjs` | 带登录状态的浏览器，每个作品库一个（`Browsers.of(<库>)`，第一次用到时才启动）：各自一个 Chromium（playwright-core 的 `launchPersistentContext`，用户数据在 `browser/<库>/profile/`）、各自的标签页和下载，工具按作品所在的库取浏览器，绑定在一个作品库的 AI 和授权碰不到别的库的登录；移除作品库时它的浏览器资料一起删除。FRAME 只有一个密码、没有用户账号，所以这不隔离共用密码的人。用户在编辑区的「浏览器」选项卡里看和操作所在作品库的浏览器：`/api/browser/view?repo=<库>` WebSocket 下发所看标签页的 CDP 截屏流（JPEG，二进制消息），收回鼠标、滚轮、按键和文字（隐藏的文本框接收，输入法和手机键盘都能用）；页面尺寸跟随最后一个在看的选项卡（高密度屏幕按最多 2 倍像素画），没人看时回到 1280×800。只接受登录的用户和本机，不接受 AI 的令牌。AI 通过 `browser_*` 工具使用它：每个对话一个标签页（网页弹出的窗口归打开它的对话，看着原标签页的用户跟过去），页面结构用 Playwright 的 AI 快照（`[ref=…]`）；密码框、有密码框的表单和写评论、发帖的多行输入框不让 AI 填；`browser_login` 在标签页上记下请求登录的对话，用户点「登录好了」时给那个对话发一条消息；`browser_download` 用标签页的 cookie、UA 和 Referer 逐跳下载（复用 `importFromUrl`），或等点击触发的下载；`browser_cookies` 写 Netscape cookies.txt（0600，一小时后删除）给 yt-dlp；每条消息的 [FRAME] 写上用户正在浏览器里看的标签页。工具标记 `signedIn`：不改作品，但只读授权看不到。设置了密码时浏览器的所有请求都经过本机的守卫代理（`browser-proxy.mjs`，`--proxy-bypass-list=<-loopback>` 让本机地址也走代理）：代理自己解析域名，拒绝内网地址，连接到检查过的地址。下载在浏览器关闭前移出来，保留一小时；15 分钟没人用（没有在前面的「浏览器」选项卡，也没有工具调用）时关闭浏览器，保存会话 cookie |
| `browser-bridge.mjs` `browser-page.mjs` `browser-extension.mjs`，`extension/` | 用户电脑上的浏览器（FRAME 连接器，Edge/Chrome 的 MV3 扩展）：「浏览器」标签页生成配对码（10 分钟、一次），扩展用它换一个令牌（设置里存 sha256，`browserBridges`，记着连接的作品库），之后保持 `/api/browser/bridge` WebSocket（app.mjs 让这个路径不经会话升级，扩展在第一条消息里证明身份；令牌对别的接口无效）。服务端发 `call`（打开、导航、在页面里执行脚本、DevTools 输入事件、截图、历史、切到前面、点击下载、下载），扩展回 `result`；下载的文件以二进制消息（16 字节的上传 id + 数据）流回，写进作品。浏览器工具通过同一个驱动接口用两种标签页（服务器的 t…、电脑上的 x…，`where` 选，默认电脑上的连着就用它）；电脑上的页面结构由 `browser-page.mjs` 的 `pageOutline` 在页面里生成（元素记 `data-frame-ref`），页面脚本两边共用，扩展收到的是函数源码。扩展本身也守规则：只操作它为某个作品库的 AI 开的标签页（单独的窗口和「FRAME AI」标签组）和用户在弹窗里交给某个作品库的标签页，只开 http(s)，下载用标签页的网络栈（`Network.loadNetworkResource`）并只对 AI 标签页正在访问的网站带 cookie。`/api/browser-extension.zip` 打包 `extension/`：写上本站地址（`defaults.json`），并在清单里只让本站的页面访问它的图标和配对页（`web_accessible_resources`）。清单带公钥（`key`），扩展 id 固定，「浏览器」标签页据此每两秒探测一次 `chrome-extension://<id>/icons/16.png` 是否装好，装好后「一键连接」用事先生成的配对码打开扩展的 `pair.html`，配对完成后它自己关闭 |
| `blender.mjs` `tools/blender-tools.mjs` | 用户电脑上的 Blender（[AB to T](https://github.com/xie-hou/abt) 插件 0.6.0 起）：「Blender」选项卡生成连接码（`地址#配对码`，10 分钟、一次），插件用它换一个令牌（设置里存 sha256，`blenderLinks`，记着连接的作品库）。插件不开端口，用令牌长轮询 `/api/blender-link/poll`（最多等 25 秒；连上后第一次立即返回），工具的请求（`open` 打开镜头、`run` 执行 Python、`view` 截一帧）作为 job 交给它，结果 POST 到 `/result`；它的状态（打开的镜头、实时同步、写回冲突、最近做的事）跟着每次轮询或 `/state` 报上来。插件在那台电脑上按作品的目录结构放一份镜头和它用的文件（`/file` 取作品 `projects/<名称>/` 里的文件，`materials/...` 按作品锁定的版本取素材库文件），导入、实时写回照常；写回的 JSON 经 `/save` 回到作品（只收 `abt/<镜头>.json`，带上次同步的 sha256，作品里的已经被别处改过时 409，用户在 Blender 里选用哪边）。`/api/blender-link/*` 是公开路由，自己验令牌；令牌对别的接口无效 |
| `svg-editor.mjs` | `/svg-editor/`：SVG 编辑器（[SVG-Edit](https://github.com/SVG-Edit/svgedit)，MIT，npm 包 `svgedit`，`patches/` 里的补丁见下）和宿主页 `src/svg-editor/`，公开、允许任何来源读取（只有编辑器代码，要编辑的 SVG 由工作台用 postMessage 传入） |
| `materials.mjs` `exports.mjs` `tasks.mjs` | 素材库（`/files/<库>/<作品>/materials/...` 按作品锁定的版本取文件，作品写 `-` 时取现在的版本：Git blob，LFS 内容按需下载；`@materials/...` 代码导入由 Vite 插件解析到作品根目录 `.materials/` 中的副本，锁定版本或素材库当前版本，锁定时沿导入关系一并锁定；保存版本和发布前锁定文件只保留作品用到的）、导出文件、后台任务 |

## 预览与热更新

舞台页 `/preview/stage.html` 在 iframe 中运行，只负责画面：通过 `/@fs/<作品>/project.ts` 动态导入作品，用 `createPlayerSession` 播放。工作台通过同源的 `window.__FRAME_STAGE__` 控制播放，舞台用 `postMessage` 回报状态。

载入作品时页面设置作品的素材地址、节拍（`project.ts` 的 `tempo`，`src/engine/tempo.ts`）和素材库代码副本的位置（`src/engine/materials.ts`）。引擎在任何文件里都按 `@frame/engine/<模块>` 导入（Vite 别名和作品 tsconfig 的 paths）。文档里写的素材库代码（audio.json 生成音源的 `module: "materials/<库>/<文件>.ts"`）在运行时按 `/@fs/<作品根>/.materials/<文件>` 导入，Vite 插件先把作品锁定的版本复制过去。

资源预览页 `/preview/resource.html` 在同样的作品环境里导入一个素材库代码文件，画出其中的资源（Canvas 2D 的 `draw`，或 three / pixi 的 `build` 搭出的场景，页面里共用一个 WebGL 渲染器和一个 Pixi 应用；工作台的资源标签页通过同源的 `window.__FRAME_RESOURCE__` 控制参数和时间，播放音效，三维资源可以拖动旋转视角）；服务端用同一个页面无界面渲染缩略图和给 AI 的预览图。

素材预览页 `/preview/asset.html` 画浏览器自己显示不了的素材：三维模型（GLB/glTF/FBX/OBJ，引擎的 `loadModel` + 摄影棚光）、Lottie、HDR/EXR 全景图、字体。工作台的标签页用它播放和旋转（`window.__FRAME_ASSET__`）；服务端每个素材地址前缀（一个作品，或 `/files/<库>/-/` 即素材库现在的版本）保留一个页面，`open` 换文件，给缩略图（`asset-previews.mjs`）和 `asset_view` 出图。

作品和素材库里的 SVG 文件在标签页里用 SVG 编辑器打开（「图形」，可切到「代码」）。编辑器在 `sandbox="allow-scripts"` 的框架里运行，是一个独立的来源，没有工作台的登录状态，SVG 里带的脚本和链接动不了工作台；工作台把文件文本 postMessage 给它，它在每次修改后发回文本，Ctrl+S 请工作台保存（素材库文件保存为素材库的新版本，本作品锁定了旧版本时改用新版本）。SVG-Edit 打开文件时会改写它（路径改成自己的写法、属性排序、根元素的尺寸、包一层图层、给图形加 id）：宿主页打开前给每个元素编号，导出时没改动的元素换回文件里的原文，改动过的元素按原来的属性顺序，根元素、图层、自动 id、缩进都还原，所以改一个图形只改文件的那一处。`patches/svgedit@7.4.2.patch`：导入时保留它不认识的属性、样式和 SVG 元素（只去掉脚本和事件属性）；点选后不再清掉元素的 style；拖动结束发出修改事件；编辑带变换的组里的路径时节点手柄位置算上所有上级变换。

保存作品文件时，Vite 的 `hotUpdate` 钩子使改动模块失效并打上时间戳，但阻止整页刷新；服务端合并 120 ms 内的改动后广播 `preview-update`。舞台带时间戳重新导入 `project.ts`，调用 `session.updateProject()` 原地替换场景和音频，播放位置保持不变。素材文件（`public/`）的改动由目录监听发现。

## 高延迟网络下的加载

预览页的代码由 Vite 逐个模块编译下发，一个作品连同引擎有上百个模块，按导入关系逐层发现；作品还要用到素材文件。为了在延迟高的网络里也能很快打开，再次打开时不为没改过的东西发请求：

- 预览页（舞台、资源、素材、本机导出）生成时附带它要导入的全部模块（`preview.mjs`：从页面脚本和舞台的 `project.ts` 出发，沿 Vite 改写后的导入找出浏览器会请求的地址，静态导入全部跟随，动态导入只跟随作品目录里的）：写成 `modulepreload` 链接，整张模块图一次取完或一次验证，而不是每层导入一个往返；并在页面的 `frame-cache` 数据里写上每个模块编译结果的 etag。舞台页和本机导出页还带上作品的播放文件清单（`precache.mjs`）。
- 浏览器的 Service Worker（`public/frame-sw.js`）拦截预览页的导航，在页面请求任何东西之前读出这些数据：etag 没变的模块直接从 Cache Storage 返回，变了或不在清单里的才请求服务器（etag 是编译结果的内容哈希，改动过的模块、热更新带的 `?t=` 地址都会重新取）。
- 播放文件（作品 `public/` 的文件、作品用到或锁定的素材库文件，代码除外）按内容版本保存在 Cache Storage：锁定的素材库文件用 Git blob 作版本，其余用内容哈希。清单先用来丢弃改动过的文件，之后才放行这个作品的素材请求，然后在后台补齐：小文件打包、一次往返，大文件并行分段下载，各段存为 Blob 后整体写入（Chrome 在 Service Worker 里流式写入超过 10 MB 会失败）。工作台打开作品和文件改动后也发送清单，较旧的清单被忽略。
- 编辑器选项卡打开缓存里有的文件（图片、音视频、SVG 等文本，素材库文件只在作品用的就是素材库当前版本时）也从 Cache Storage 读：工作台保留同一份清单，请求带上文件版本（`?v=`），Service Worker 只在缓存的正是这个版本时直接返回，否则加入正在进行的下载或请求服务器；文件改动后清单更新，打开着的选项卡随之换成新版本。文本的 hash 在浏览器里按服务器的算法计算，保存时的冲突检查不变。
- 合成器同时加载一帧里新出现的各个图层（模块、字体、媒体），不再一个接一个；工作台把作品信息请求和 `/api/state` 一起发出。

## AI

内置 AI 不自己实现代理，而是通过 ACP（Agent Client Protocol）驱动官方适配器：`@agentclientprotocol/claude-agent-acp`（Claude Agent SDK）和 `@agentclientprotocol/codex-acp`（Codex app-server）。

- 每个“AI 配置 + 模型”一个代理进程，多个会话共用；空闲 15 分钟退出，会话下次发送时通过 `session/resume` 恢复。
- 新会话的工作目录是作品目录，并注入 FRAME MCP（`/mcp`，带只对该作品有效的内部令牌）。代理自己的确认不经过 FRAME 工具（Claude 预先允许，Codex 不询问），由 FRAME 按会话当前模式决定：手动确认和计划模式下，会修改作品的工具先在聊天中请求用户确认（`confirmTool`）。
- 账号登录调用随依赖安装的 `claude` / `codex` 程序（`auth login`、`login --device-auth`），凭据在它们自己的目录（`~/.claude`、`~/.codex`；容器中为 `/data/home`）。
- 自定义 API：Anthropic 兼容接口通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 交给 Claude Code；OpenAI 兼容接口通过 `CODEX_CONFIG` 中的自定义 model provider 交给 Codex。
- 技能：开始或恢复会话时把作品库的技能链接到作品根目录的 `.claude/skills`、`.agents/skills`（`skills.mjs`），每轮结束时保存 AI 对技能的修改。
- 上下文（`ai/context.mjs`）：开始或恢复会话时重新生成作品根目录的 `AGENTS.md`（平台规则、作品需求、关联的经验库，`works.briefProviders` 提供）；每条消息附加 `[FRAME]`，只写 AI 还不知道的：播放位置与选中对象、上一轮之后被改动的作品文件、别人对经验库的修改。会话元数据中的 `context` 记录 AI 已知的经验库文档哈希；MCP 内部令牌带会话 id，工具读写经验库时据此更新。
- 分支（`fork`）：复制到分支点为止的对话记录，并用 ACP `session/fork`（`_meta.jetbrains.air.fork.messageId` 指定分叉点）分叉代理的上下文；会话元数据 `branch` 记录来源和保留的轮数，界面据此显示同一处的多个版本。
- 心跳（`ai/heartbeat.mjs`）：Claude 思考时只回传签名、不回传文字，API 保持连接的心跳包也在 Claude 内部丢掉，ACP 上什么都没有。Claude 回合运行时，服务端每 3 秒用 `ss`（iproute2，仅 Linux）读该会话 Claude 进程（命令行带会话 id）的 TCP 连接：发出请求 3 秒后仍在收数据的连接算作正在接收回答，取最近一次收到数据的时间，以 `ai-heartbeat` 事件推送。界面在 AI 不在运行工具、不在等用户时显示“心跳 N 秒前”（与最近一条记录的时间取较晚者），超过 30 秒没有数据时提示可能卡住。没有 `ss` 或非 Linux 时不显示；Codex 尚未确认其服务在推理时会发心跳，暂不显示。
- 对话记录保存为原始 ACP 更新的 JSONL，界面把它还原为消息、工具卡片、差异和计划。版本只由用户手动保存（活动栏「版本与同步」的图标显示未保存的改动数）。
- 长对话（几十 MB 的命令输出、工具结果）按轮次载入：打开时只取最近几轮（`history`：最多 8 轮，约 600 KB 内，至少一轮），往上滚动再取更早的；工具调用里超过 4000 字的文字在下发和实时事件中截短并标记 `cut`，卡片展开时按 `toolCall` 取完整内容（运行中或没取到时，卡片写明只有开头）。卡片里超过 4000 字的文字先显示开头，写明还有多少行、多少字没有显示，「展开全部」显示完整内容；Codex 的终端输出最多保留 20 万字，超出部分写明没有保留。服务端只解码需要的行；每轮结束时只合并这一轮的文字片段，不重写整个文件。实时事件带上条目在文件中的结束位置，正在载入的对话据此补上载入期间新写的条目。Codex 把 MCP 工具结果（连同 base64 图片）整个序列化成一段文字，写入时拆开，图片和其他工具图片一样存为文件。发送消息和取消排队的回应带上会话当前状态（排队、运行中），不依赖事件推送。

## 导出

服务器导出 MP4：先把作品目录复制为快照（之后的编辑不影响导出），用无界面 Chromium 打开 `/preview/render.html` 逐帧截图，音频由 `OfflineAudioContext` 分段渲染为 PCM，一起送入 ffmpeg 编码为 H.264 + AAC 的 MP4。浏览器：`FRAME_BROWSER` → playwright 浏览器 → 系统 Chrome/Chromium；ffmpeg：`FFMPEG_PATH` → 系统 ffmpeg → `ffmpeg-static`。任务的进度事件带剩余秒数（`eta`）和速度（`fps`）。

本机导出 WebM 完全在浏览器里进行，不经过服务器（服务器只像预览一样提供作品的代码和素材）：

- 工作台在一个隐藏的框架里打开 `/preview/export.html`（`src/preview/export.ts`），它载入作品，每 4 秒一段：画面编码成单独的 WebM（VP9，不行时 VP8；`src/engine/browser-export.ts`），声音存为 16 位 PCM。全部完成后把各段画面的数据包原样接起来、声音一次编码为 Opus，写成一个 WebM。每段都从关键帧开始，所以接缝不需要重新编码；声音整体编码一次，所以没有接缝。
- 编码器偶尔会丢帧（Chrome 在别的标签页切到前面时会丢，包括一段开头的关键帧）：一段只有帧数齐全、从关键帧开始才保存，否则这一段重新编码，最多三次。
- 分段、进度和成品都保存在浏览器的私有文件系统（OPFS，格式见 `src/preview/export-jobs.ts`），页面关闭、刷新或崩溃后从最后完成的一段继续，接着导出的结果和一次导完的逐字节相同。渲染导出的页面持有 Web Lock `frame-export:<id>`：没人持有锁却标着进行中的导出就是中断了；持有锁也让 Chrome 不冻结后台标签页。导出循环和离线音频的让步不用计时器（`src/engine/scheduling.ts`），后台标签页里的计时器节流不会拖慢导出。
- `web/lib/exports.ts` 管理导出：一个页面一次导出一个，其余排队；打开工作台时（任何页面）继续中断的导出，另一个标签页里的导出页面消失时（关闭、崩溃）由这个标签页接着导出；作品文件（名称、大小、修改时间）和开始导出时不同，先问用户继续还是重新导出；完成后自动下载，成品在浏览器里保留 7 天。各标签页之间用 BroadcastChannel `frame-exports` 传进度和暂停、取消的请求。
- 左下角的导出状态（`web/components/ExportDock.tsx`：工作台状态栏的最左边，其他页面的左下角）显示本机导出和服务器导出的进度、剩余时间和完成时刻，点开可以暂停、继续、取消、下载。

## 用用户的显卡画

服务器没有显卡，无界面 Chromium 用 SwiftShader 软件渲染，三维画面一帧要几秒。AI 的 `preview_frames`、`work_check` 的 `timing`、`preview_motion` 改在用户电脑上打开着的 FRAME 页面里画：

- 每个登录的页面（任何页面，`web/lib/gpu-render.ts`）连接 `/api/render/gpu`，报告开着的作品、能不能画（浏览器有显卡加速——WebGL 的渲染器不是 SwiftShader 之类的软件渲染——且设备有鼠标，不是手机、平板）、用户的选择、显卡名称、页面是否在前台、最近一次操作。
- 服务器把这些页面当作 Playwright 浏览器用（`render-gpu.mjs`）：新建页面、打开地址、等待、在页面里执行函数，页面在隐藏框架里打开同一个 `/preview/render.html` 照做，所以 `render.mjs` 的绘制代码不变（`openPage` 的 `on`）。页面的结果（截图的 base64 等）gzip 后用二进制消息发回；渲染页在框架里时把未捕获的错误、控制台警告和错误、失败的请求通过 postMessage 报给工作台，工作台在回复每次调用之前先转给服务器，与无界面浏览器的页面事件一样。
- 用哪台电脑：FRAME 只有一个密码、没有账号，几个人可能共用，所以不能随便挑一个页面。每个页面随状态报告它开着的作品（地址 `/work/<库>/<作品>`）和这个浏览器的选择（`mode`：`gpu` 画；`server` 用户在设置里选了服务器 CPU；`none` 手机、平板或没有显卡加速，不画）。另外按登录区分人：每次登录的 cookie 不同，`Auth.identify` 给它一个 `login`（cookie 的哈希；没有密码的本机是 `local`），AI 对话记下最后一条消息（新建、发送、目标、分支）来自哪个登录（会话元数据的 `login`，不发给页面；FRAME 自己发的消息不改它）。`GpuBrowsers.pick({ login, repo, work })`：发消息的登录选了服务器就在服务器上画；否则先用开着这个作品的页面（发消息的登录的在前），再用发消息的登录的其他页面；工具按 `ctx.scope.session` 取登录。没有对话的调用（外部 MCP、命令行）只看作品开在哪里。
- 每次画之前在这些页面里挑（`Renderer.anywhere`）：前台的优先，再按最近操作；3 秒内不回应的（电脑睡眠、标签页冻结）跳过。没有可用的页面，或者画到一半页面关了、不再回应（`GPU_PAGE_GONE`），就在服务器上画（`preview_motion` 从头再画）。预热的页面按作品和用户页面分开保存；重的分析（运动、测速）每个用户页面同时一个，与服务器的分开排队。
- 工具结果写明在哪里画的（显卡名称，或服务器软件渲染），测速说明数值是不是用户电脑的实际速度、页面当时是否在后台。工作台状态栏在画的时候显示「AI 在用本机显卡画」。打开着框架时页面持有 Web Lock `frame-gpu-render`，后台标签页不被冻结。
- 其他渲染（运行检查、封面、缩略图、声音、服务器 MP4 导出）仍在服务器上。

## 安全边界

- 只监听本机地址时无需登录，但拒绝非本机 Host 头和跨站写请求；监听其他地址必须设置 `FRAME_PASSWORD`。
- 外部 MCP 使用在设置中创建的令牌（可只读）；内部令牌只用于 AI 会话和渲染，且限定作品。
- 所有作品路径经 `confined()` 检查，拒绝路径穿越和指向目录外的链接。作品代码只在浏览器中运行，服务端不执行作品代码。
- AI 代理在作品目录中拥有其自身的文件与命令权限（与在终端中运行 Claude Code / Codex 相同）。
