# AI 制作工作流升级

统一参数、权威文档、能力发现、错误恢复和任务等待见 [AI 制作工具链](AI-TOOLCHAIN.md)。

目标是让命令行和 MCP 调用同一套制作能力。作品继续使用绝对时间场景、多音轨和现有渲染器；公共工具负责隔离、修改、审片和交付证据。

## 能力与验收

| 能力       | 设计                                                                                            | 验收依据                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 正式渲染   | 单项目输入快照，包含二进制素材、公共运行源码与依赖锁文件指纹；无热更新与文件监视；独立端口/缓存 | 其他作品损坏、原文件中途变更不影响已启动任务               |
| 单项目执行 | dev、typecheck、test、build、validate；只纳入目标与其公共依赖                                   | 其他项目语法错误不影响目标检查和导出                       |
| 编辑       | 共享项目服务支持文件搜索、带版本的局部替换、批量编辑、检查点/恢复                               | 冲突拒写；恢复不覆盖检查点之后未知的外部改动               |
| 审片       | 指定片段的视频、分镜、字幕、混音、分轨和测量组成版本化审片包；A/B 页面与带时间意见              | 输出同一输入版本；未看/未听保持未审阅                      |
| 交付验证   | 完整解码、实际帧数、规格、声画时长、音频测量、最终文件抽帧及版本核对                            | 工程/运行/媒体/内容审阅分别报告 passed/failed/not_run      |
| 后台 PCM   | 无状态绝对时间 PCM 生成器的通用 Worker 适配；限额缓存、取消、错误和释放                         | 冷跳、倒跳、倍速、离线片段一致，取消不破坏其他会话         |
| 调试       | 等待就绪、定位捕获、倍速/音轨控制、性能与错误诊断、可选场景参数                                 | 自动化不再依赖查找 UI 控件                                 |
| 导出预检   | 实际短段编码/封装验证；保持目标尺寸/帧率；可恢复片段清单                                        | 编码失败不发布成品；恢复拒绝不同输入或参数                 |
| 旁白       | 提供供应商无关的逐句素材/文本清单、内容指纹缓存与实测字幕时间线                                 | 修改句子/声线/参数后缓存失效；不内置密钥或擅自请求付费服务 |

## 边界

普通作品制作仅写目标目录。公共工具不是操作系统沙箱。检查通过不代表审美验收；黑帧、静音和响度仅作为诊断，除非作品明确约束。独立工作副本用于任务隔离，全工作区 scope 仍如实报告目录外更改。

正式输出必须记录源码、公共运行文件、二进制素材及参数的版本。生成结果、缓存、过程记录不参与运行输入指纹。恢复操作始终保留外部修改，不能用强制覆盖掩盖冲突。

实现及验证结果见根 records 中对应记录。

## 从接手到交付

所有命令在所选 checkout 根目录执行；`pnpm --silent` 避免包管理器横幅进入 JSON。新增命令标准输出为一个 JSON 结果，渲染进度走 stderr；失败返回非零。`film help --json` 返回可机器读取的命令帮助。原有 frame/render/storyboard/import 等命令加 `--json` 时返回状态、输出路径及诊断。

```powershell
pnpm --silent film context my-film --json
pnpm --silent film workspace my-film --json   # 并行任务可用；后续在返回的 directory 工作
pnpm --silent film search my-film --query "createScene" --json
pnpm --silent film read my-film --path scene.ts --line 1 --lines 150 --json
pnpm --silent film patch my-film --input changes.json --dry-run --json
pnpm --silent film patch my-film --input changes.json --json
pnpm --silent film validate my-film --json
pnpm --silent film test-e2e my-film --json
pnpm --silent film playback my-film --start 0 --duration 3 --json
pnpm --silent film review my-film --start 0 --end 6 --json
pnpm --silent film export my-film --width 1920 --fps 30 --json
pnpm --silent film verify my-film --file projects/my-film/exports/renders/<render-id>/film.mp4 --json
```

`dev` 启动单项目工作台并返回独立 URL，保持进程直到 Ctrl+C。`typecheck`、`test`（项目单元测试）、`test-e2e`（项目浏览器测试）、`build` 都只选择本项目；构建在本项目 exports/build-UUID，临时检查文件在本项目 .cache，结束清除。`validate` 聚合结构、类型、项目单元测试，单独保留运行、媒体与内容审阅的 `not_run` 状态；它不是全片验收。`playback` 实测指定片段的播放/暂停、冷跳和倍速，不强制播放整个长片。

`workspace` 创建只有目标作品的独立 Git 副本，在 `.history/workspaces/UUID` 保留当前未提交源码，建立本地基线。依赖共享但应只读使用；这里的“只读”是操作约定，不是 OS 权限。它不自动合并或同步回原目录，不对原 checkout 做 reset/stash。副本中有工作时不得清理 `.history`。管理本聊天的 Git 工作树仍使用宿主的工作树工具；此命令用于作品级独立副本。

## 局部修改、检查点与恢复

`changes.json`（也可 `--input -` 从 stdin 读取）：

```json
{
  "changes": [
    {
      "path": "scene.ts",
      "expectedSha256": "填入 read/search 返回的完整文件哈希",
      "replacements": [
        {
          "find": "const speed = 1;",
          "replace": "const speed = 0.8;",
          "count": 1
        }
      ]
    }
  ]
}
```

替换顺序执行，匹配数量不符合就拒绝整个批次。整文件新建/替换/删除使用 `edit`，每项为 `{path, expectedSha256, content}`；新建哈希为 null，删除 content 为 null。操作前自动保存文本检查点，检查失败回滚。每批最多 20 文件/2 MiB，每个文本最多 1 MiB。

```powershell
pnpm --silent film checkpoint my-film --label "调整运镜前" --json
pnpm --silent film history my-film --json
pnpm --silent film restore my-film --checkpoint <uuid> --expected <当前fingerprint> --json
pnpm --silent film restore my-film --checkpoint <uuid> --expected <当前fingerprint> --apply --json
```

恢复默认仅预览，明确 `--apply` 才写入。使用 history 返回的当前完整输入指纹，输入再变化则拒绝。检查点只恢复可编辑文本，不恢复二进制素材、exports 或 records，最多 400 文件/32 MiB。保存于项目 `.history/checkpoints/`，不随普通缓存清理，也默认不提交 Git；长期版本仍应使用 Git。失败遗留事务需要人工核对备份，工具不会删除未知锁。

## 声画审片与证据

`review` 在同一冻结输入上生成 clip.mp4、带绝对时间的 storyboard.png、独立 frame-N.png、mix.wav、track-ID.wav、captions.srt、review.json 和本地 index.html。默认每秒两个采样、最多 24 帧；快速运动可缩小时间范围后加密检查。音轨文件保留元数据中的音量和静音；它们代表实际混音条件，不自动归一化。

```powershell
pnpm --silent film compare my-film --a <review-id-A> --b <review-id-B> --json
pnpm --silent film review-note my-film --review <review-id> --input note.json --json
```

A/B 必须覆盖同一时间范围。页面并列显示两段视频，支持同步开始、暂停、循环；默认只播放 A 声音，避免两段混听。note.json 示例：`{"reviewer":"人工审阅","time":2.5,"note":"字幕遮住主体","visual":true,"listening":false}`。意见保存在项目 records/reviews，并绑定审片输入版本。技术报告中的 `not_run` 不会因为输出文件存在而自动变成内容通过；记录意见也不表示整片已审阅。

`verify` 针对最终文件完整解码、实际计帧、规格与声画时长检查、响度/真峰值/静音测量，并抽取最终文件画面。有 .render.json 时核对源码与素材指纹；缺少清单就明确报告版本未知。输入过时与媒体损坏是不同字段。声音静音、黑画面或某个响度数值没有统一艺术合格阈值，不能仅靠技术数据宣称已试听。

## 正式导出与后台任务

`render` 保留单次 PNG → 软件 H.264/AAC 路径；`export` 增加真实短段试编码、固定整数帧分段、完整成片验证及可恢复清单。后者输出 exports/renders/UUID/film.mp4。先试编码、封装和核对，再渲染长片；分段视频复用前逐个核对哈希及帧数，声音从同一生成器重新离线混合一次，避免拼接 AAC 造成边界不一致。不得改变分辨率、帧率或静默丢帧。

失败保留已验证分段；使用相同参数追加 `--resume <render-id>`。输入或参数改变即拒绝恢复，需新建导出。同一导出清单有排他锁，拒绝并发恢复；后台任务在自己的进程树退出后清除自己持有的锁。进程整体崩溃留下的 render.lock 需核对现场、确认已无任务使用后再清理，不凭旧 PID 自动回收。成功后临时快照和混音清除，分段与清单保留用于复核；文件未通过验证前不会发布为 film.mp4。场景与素材从冻结副本构建为静态页面，不启动开发热更新；正式快照只有目标项目，修改其他作品不会使导出页面刷新。依赖目录共享，导出期间不得更新依赖安装。

长任务可以退出当前命令后继续执行：

```powershell
pnpm --silent film job my-film start --kind export --input export-options.json --json
pnpm --silent film job my-film status --id <job-id> --json
pnpm --silent film job my-film cancel --id <job-id> --json
```

options JSON 例如 `{"width":1920,"fps":30,"start":0,"end":6,"segmentSeconds":3}`。kind 支持 frame/storyboard/render/review/export/validate/typecheck/test/test-e2e/build/verify/playback/narrate。默认超时 3600 秒，`--timeout` 可调整。启动器建立自己的后台进程，状态带心跳、有限长度日志与帧进度；取消请求由拥有任务的进程处理，不按旧 PID 杀进程。异常结束后状态可能是 unobserved，必须检查现场，不把旧状态当成功。MCP 会话任务仍随客户端断开停止；跨会话后台任务用这个 CLI 入口。

浏览器 WebM 也会在目标尺寸与帧率上真实试编码，软件 VP9 不可用时试 VP8，两者均失败则明确提示命令导出。支持文件选择 API 时，可勾选“直接保存到文件”边编码边落盘；写入带背压，取消时中止文件写入。不支持该 API 或未勾选时保留 256 MiB 缓存限制。[Mediabunny 写入接口](https://mediabunny.dev/guide/writing-media-files)

## 后台音频与调试接口

作品的 audio.ts：

```ts
import { createWorkerPcmAudio } from "../../src/engine/worker-pcm";
const audio = createWorkerPcmAudio({
  createWorker: () =>
    new Worker(new URL("./pcm.worker.ts", import.meta.url), { type: "module" }),
});
export const { prepareAudio, prepareSegment, createAudio, disposeAudio } =
  audio;
```

作品的 pcm.worker.ts：

```ts
import { exposePcmGenerator } from "../../src/engine/worker-pcm";
exposePcmGenerator(({ startFrame, frames, sampleRate, trackId }, signal) => {
  signal.throwIfAborted();
  const left = new Float32Array(frames);
  // 依据绝对采样索引 startFrame + i 和 trackId 生成声音；返回两个等长声道。
  return [left, left.slice()];
});
```

适配器使用 48 kHz、0.25 秒块、默认 128 MiB LRU 缓存，每次 Worker 请求有超时，暂停/跳转撤销后续需求。已共享的单块计算可完成并缓存，不会为取消一个请求销毁其他会话；原采样乐谱的有状态 Worker 保持原实现。离线最多 10 秒的片段需能放入所选缓存，过小预算明确失败，不用静音掩盖。声音始终由公共 AudioContext 调度，不另建播放时钟。

`window.__FRAME_STUDIO__` 新增 waitUntilReady、captureAt、setRate、setTrack、getDiagnostics；前两者支持音频准备与超时。诊断提供实际帧时间、渲染耗时、准备耗时、音轨设置和错误，暂未公开的缓冲范围为 null。场景可选 debug.parameters / setParameters / setOverlay / diagnostics，暴露有范围的数值参数和相机辅助层；使用 getParameters/setParameters 调整。调试参数是临时值，确认后用 patch/edit 保存到作品实际使用的参数源码/JSON，再正式导出。基座不猜测摄影机、灯光或角色结构。

## 旁白与字幕

公共 Edge、OpenAI/compatible、Azure、MiniMax、豆包、ElevenLabs、可选 Qwen bridge 及项目自定义合成器已统一接入，完整说明见 [项目语音合成](SPEECH.md)。最快开始：`pnpm film speech my-film init --provider edge`，然后 `pnpm film speech my-film say --text "你好"`。每个项目保存自己的 `production/speech.json`、角色声线和私有 `.env`。

`film narrate my-film --input production/narration.json` 接受：

```json
{
  "voice": "指定声线",
  "duration": 12,
  "sentences": [
    {
      "id": "intro",
      "text": "这是第一句。",
      "start": 0,
      "budget": 3,
      "audio": "production/intro.wav"
    }
  ]
}
```

已有音频逐句测量；需要合成时使用项目 speech.json 或在清单显式选择公共提供器。旧 `provider: "scripts/narration-provider.mjs"` 继续兼容：模块导出 `synthesize({text,voice,settings,signal}) -> Uint8Array`，返回 WAV，可声明 providerDependencies 参与缓存版本。基座不内置在线账户，不自动切换付费服务。自定义模块作为可信项目代码执行，Worker 不提供操作系统权限隔离。

缓存键包括文本、声线、参数、模型/服务地址、提供器版本和原音频内容。只重做失效句子，超出预算或混音时长错误则失败；默认拒绝重叠，需要时显式 allowOverlap。mode: sequential 可按实测时长排列对白，默认 absolute 保留逐句 start。输出版本化 public/narration/<hash>/voice.wav、captions.srt、timeline.json，返回可直接并入 project.ts 的 audioTrack 与 subtitles；不擅自重写镜头时间。生成物保存后普通播放不依赖在线服务。
