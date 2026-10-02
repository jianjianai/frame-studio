# Paseo 共享语音模型与只读消费者 · 2026-10-02

## 范围与原因

Paseo 固定版本 0.10.2，提交 919c737c1948c5a16220307403a82e90d3e27ea0。官方本地语音功能及模型选择保留。旧环境每个作品在自己的 native home 下载相同默认语音模型，且缺少 bzip2 导致 tar 解压失败。本记录覆盖共享模型生产者、官方只读等待补丁和相关目标验证；Docker 启动、地址、Host allowlist、并发调度与正式发布由对应维护任务记录。

## 处理方式

受信控制器创建一个后台生产者，使用安装包的官方 listLocalSpeechModels / ensureLocalSpeechModels。已实测编译入口为 dist/server/server/speech/providers/local/models.js，包含双层 server。开始工作只等待目录初始化，不等待模型下载；聊天和 SDK 就绪继续独立进行。

共享目录为数据根下 paseo-models。Docker 作品通过 /paseo-models 只读挂载使用，Frame 专用环境声明 FRAME_PASEO_SHARED_MODELS 与 FRAME_PASEO_SHARED_MODELS_READONLY=1。缺省原生配置只补 providers.local.modelsDir，用户明确设置的原生目录、环境覆盖和其他配置保留。不同作品的 native home、聊天历史及用户自定义模型目录未迁移或删除。

固定目录目前有三种模型：Parakeet v2 默认 STT、Kokoro 默认 TTS、Parakeet v3 可选多语言 STT。共享生产者先准备两个默认模型，再准备 v3，所有作品共用同一份权重。消费者检查自身所需文件；默认模型已完成时，即使 v3 仍在准备或失败，也可恢复默认语音。

跨进程锁和控制器 leadership 检查保证一次后台下载。下载和解压在本次 job 的私有 staging 目录执行；完整目录通过原子 rename 发布。发布前再次检查取消信号、控制器权限与文件锁。缓存全部完整时，不重新持锁、不改写 preparing 状态。关闭中不启动新 job；失权取消当前 job，后续合法 start 使用新 AbortController。失败状态保留已经完成的模型进度，公开错误为固定安全说明。

状态文件 .frame-speech-state.json 使用 version/state/modelIds/completedModelIds，可选固定 error。官方 0004-frame-shared-speech-wait.patch 仅在 Frame 声明的精确只读共享目录启用：消费者等待文件和状态，不请求网络、不写缓存。原生其他目录沿用原下载逻辑。生产者重试后，原生 monitor 能恢复等待；停止期间的文件检查不会返回过期 ready。

预填的完整 archive 只硬链接到本次 staging，不额外复制或重新下载。官方提取后删除 staging 的链接，共享原始 archive 保留供发布接受后的精确缓存清理。清理只操作本 job 的 UUID 目录和自己的锁，不修改其他 job、旧作品模型或历史。

## 体量与性能边界

本次 root 发布排障报告已验证并预填两个默认 archive：

| 默认 archive | 字节 |
| --- | ---: |
| Kokoro en v0.19 | 319,625,534 |
| Parakeet v2 int8 | 482,468,385 |
| 合计 | 802,093,919 |

该合计是两个默认模型的压缩包大小。v3 archive 与三种模型的解压后总量尚未由本目标测量，不把 802 MB 当作完整模型总量。没有按作品重复存储默认权重；模型推理工作进程仍按官方请求和空闲退出机制工作，共享磁盘文件不表示跨进程共享推理内存。

首次准备仍有网络、解压和磁盘成本，语音保持官方准备状态，聊天可使用。自定义目录可能包含用户自己的模型副本。已经存在但缺少 requiredFiles 的共享模型目录会失败，普通重试不会修复这个目录；修复该缓存需要单独处理，不擅自覆盖或删除。普通缺失下载、取消和控制器换届可以重试。

## 验证

实际开发容器 Node **24.21.0**：

- node --test --test-concurrency=1 tests/server/paseo-speech-models.test.mjs：**14/14 PASS，0 skip，exit 0**，1323.595511 ms。
- 涵盖跨工厂唯一写入、默认顺序、原子可见性、ready 复用、不复制 archive、错误安全与已完成文件复用、失权后可重试、最后发布前失权、关闭与启动竞态、失效锁恢复、外来有效锁保留、自定义原生配置、只读等待与取消、默认先就绪、后台错误恢复。
- 实际安装包 API 导入及目录验证通过，禁用测试中的模型网络请求，读取官方三项目录。使用完整的有限 fixture 文件验证已就绪路径，无真实权重下载。
- 官方 server npm run typecheck --workspace=@getpaseo/server：tsgo **exit 0**。
- 真实 pinned clone 与全部 0001/0002/0003/0004 补丁的严格源码校验 **PASS**；0004 reverse-check **PASS**，调用者 Git index 未改变。
- node --check integrations/paseo/daemon-entry.mjs：**exit 0**。

目标日志：

- .cache/paseo-821/speech-models-target.log 与 .exit
- .cache/paseo-821/speech-upstream-typecheck.log 与 .exit
- .cache/paseo-821/speech-source-check.log 与 .exit
- .cache/paseo-821/speech-entry-syntax.log 与 .exit

首次目标因 fixture 在状态文件创建前直接读取 ENOENT 失败，修正为等待真实后台状态后通过。源码校验先受到 root Git ownership 与不同 UID 缓存权限限制；最终使用实际 Node 24、仅进程级精确 safe.directory 配置完成，未更改全局 Git 信任或公共目录权限。

本目标没有运行生产、下载实际模型、证明真实 ONNX 加载、TTS/STT 或麦克风效果，也没有运行完整构建或全量验证。新镜像、实际模型暖机及语音验收由 root 后续执行；本记录不将这些工作标为已完成。
