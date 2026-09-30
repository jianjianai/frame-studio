# 在作品任务内工作的 AI

统一参数、权威文档、能力发现、错误恢复和任务等待见 [AI 制作工具链](AI-TOOLCHAIN.md)。

本页是工程工具使用指南，不规定影片风格、镜头结构或音乐水准。现有 `film`、场景协议和音频接口保持不变。

## 接手与定位

在平台 AI 任务根目录运行：

```sh
node scripts/work-tool.mjs context
node scripts/work-tool.mjs help --json
```

`context` 自动识别当前作品，返回入口、有限长度的源码文件索引、音轨、镜头标记、用户选段、版本引用、结构问题和下一步命令。它不输出完整 task.json、账户配置或任务凭据；不执行作品代码。元数据或素材索引损坏时仍返回修复入口和诊断，不要求先修好作品才能获取上下文。

旧预览上的选段不能直接当作当前作品时间。`focus.mapping=requires_comparison` 时先比较只读引用与当前源码，再显式选定当前范围；工具不会自动回退源码。选段只是审片位置，不是代码修改影响范围的保证。

独立 checkout 无任务环境时传入 `{"project":"my-film"}`；本地 context/check 不需要平台登录。活动任务不允许切换为其他作品。所有临时请求 JSON、专用脚本、素材、记录和导出均放在 `projects/<id>/`，不要在根目录创建 scratch 文件。

## 实时预览

V8 在创作页持续预览当前作品或当前 AI 的隔离草稿。保存源码后增量更新，不需要每次 `film build`。任务内可运行 `node scripts/work-tool.mjs preview` 获取当前草稿播放器；不传作品或任务参数，权限由任务凭据限定。已有稳定画面在编译或初始化错误时继续显示。审片引用记录实际已显示的源码版本，不代表当前工作目录最新版本；修改引用的旧片段时先比较引用源码与最新源码。

详细行为、缓存、弱网代理和导出区别见 [V8 实时预览](V8-LIVE-PREVIEW.md)。

## 编辑与检查

```sh
pnpm --silent film checkpoint my-film --label before-edit --json
pnpm --silent film read my-film --path scene.ts --json
pnpm --silent film patch my-film --input projects/my-film/production/changes.json --dry-run --json
pnpm --silent film patch my-film --input projects/my-film/production/changes.json --json
node scripts/work-tool.mjs check
node scripts/work-tool.mjs check '{"runtime":true,"start":0,"end":2}'
pnpm --silent film test-e2e my-film --json
```

`check` 复用现有单作品结构、类型和单元测试，结合前后 Git scope 检查。快速迭代默认不启动浏览器；`runtime:true` 再执行短段播放、暂停、冷跳、倒跳与倍速检查，并生成三时间点的分镜图。默认选用户当前定位附近最多两秒，显式范围最多六秒，长段仍使用 `film playback` 或 `film review`。不复用其他作品的服务器，不修改公共源码。

控制台只返回阶段状态、诊断摘要、指纹和证据路径；完整结果写入本工程独立的 `exports/creator-checks/<uuid>/report.json`，不覆盖上次结果。结构、类型或运行失败时保留具体阶段，不把尚未执行的检查写成通过。无单元测试时保留 `not_run`。运行期间输入变化会拒绝验收。

拿到 `artifacts.storyboard` 后必须用实际图片读取能力打开；需要声音与节奏判断时生成并审阅短片：

```sh
pnpm --silent film review my-film --start 0 --end 2 --json
```

检查工具始终保留视觉/听觉内容审阅为 `not_run`。它不会因 PNG、MP4、波形或报告存在就宣称 AI 已看过或听过，也不把短片采样当作整片验收。检查失败应修复报告中的项目文件，不要用 reset/clean 或删除其他作品来让 scope 通过。

## 素材与语音

```sh
node scripts/work-tool.mjs assets '{"search":"背景","limit":30,"offset":0}'
node scripts/work-tool.mjs assets '{"limit":30,"offset":30}'
node scripts/work-tool.mjs engines
node scripts/work-tool.mjs use '{"asset":"素材 UUID"}'
node scripts/work-tool.mjs engine_test @projects/my-film/production/audition.json
node scripts/work-tool.mjs speech @projects/my-film/production/narration-request.json
```

分页范围只限当前任务所属仓库，不能用参数切换仓库。`engines` 发现已配置的内置服务和声线，优先复用，无需在作品中重复安装语音工具。`speech_providers` 读取已核实提供商预设；`engines_discover` 用已配置引擎获取音色/模型目录。`engine_test` 只生成临时试听；`speech` 保存正式素材。二者共享 options 与能力约束，text/voice/speed 旧调用仍有效；不要把未支持的 instructions 或 emotion 硬塞给兼容服务。先选择中文音色、校正多音字、短句试听，再正式合成；控制说明见 [SPEECH.md](SPEECH.md)。传 requestId 可用 speech_status/speech_cancel 查询或取消；取消不等于远端退费，写请求不自动重试。导入结果包含本地路径、浏览器 URL、媒体类型、大小、来源和接入提示，但不会擅自重写场景、audioTracks 或字幕。音频应先实测时长再对齐，文件存在不代表已经接入播放。

输入支持一个 JSON 对象、`@file` 或 stdin `-`，上限 256 KiB；带凭据的请求用私有文件或 stdin。远端调用有 180 秒超时和 2 MiB 响应上限，不跟随重定向，也不自动重试写操作。错误提供稳定 code、HTTP 状态、重试窗口（服务返回时）与 nextAction。超时或服务端异常时，语音请求可能已经产生结果：先查素材与任务状态，再决定是否重新提交，避免重复生成和计费。此行为不是服务端取消确认。

## 交付

```sh
pnpm --silent film export my-film --json
pnpm --silent film verify my-film --file projects/my-film/exports/renders/<id>/film.mp4 --json
```

任务成功前执行范围、结构、作品测试和类型检查；发布后实时预览自动跟随源码。预览能够播放不等于整片内容已验收。需要正式成片时使用分段导出和媒体验证，并报告实际版本、检查结果、文件路径以及尚未核对的内容。长期说明保留在 README；本次修改和验收记录放作品 records/。
