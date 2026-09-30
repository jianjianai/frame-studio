# FRAME Studio 7.6.2 生产发布验收

本次将已合并的性能、旁白和设置改造发布到 OVH，生产从 7.6.0 升级到 7.6.2。公网地址为 https://frame.nerviloom.com 。发布和生产验收于 2026-10-01（北京时间）完成，未执行发布前备份。

## 发布快照和产物

- 不可变标签：`v7.6.2`，源码 `e7fcc28e1029889f412b6fe9194977dcdaef34f9`。
- [正式发布](https://github.com/jianjianai/frame-studio/releases/tag/v7.6.2)。[完整发布 CI](https://github.com/jianjianai/frame-studio/actions/runs/36751995846) 最终全部成功。
- 生产应用及任务执行器固定为 `ghcr.io/jianjianai/frame-studio/app:7.6.2@sha256:25735546cc3cc2cf5c6c0333e7d972aab962957412fd570649ced71d72a4ce77`。该 OCI 索引直接取自成功 CI 的镜像发布结果，Linux amd64 子清单为 `sha256:b1d9010d6d6ea89db4f812df602c542f5e0768600e1ea6c2b4ed0bef253d7c97`，镜像源码标签与冻结提交一致。
- 下载的实际 Windows 安装器 `FrameStudio-v7.6.2-win-x64-Setup.exe` 为 1,746,261 字节；SHA-256 为 `4c72c4aa80fe4ecf88e0efd4f4e6e10185fb2a9664d995df0a1a5aaf32781606`，同时匹配发布的 `.sha256` 文件和 GitHub asset digest。
- 发布过程中观察到版本镜像标签被另一构建覆盖。先前拉取的索引为 `sha256:787b3e7906b3facd9bf51cc27d20a6df1664a45581b8a49b086f9125efe726e7`，源码标签同为冻结提交，但不属于上述成功 CI 的索引。生产改用成功 CI 的不可变摘要重新拉取、检查；随后将 `app:7.6.2` 与 `app:sha-e7fcc28e1029889f412b6fe9194977dcdaef34f9` 恢复指向该正式索引，没有重建源码或移动 Git 标签。

冻结之后的主分支追加了 Windows 专属重启修复及 7.6.3 版本准备，提交 `47adcabe8f5d96436744aca9ac726365d31608ef` 已保留。与本次冻结快照相比，`server/`、`scripts/`、`studio/`、`speech/` 和应用 Dockerfile 没有功能变更。此次 OVH 部署采用已完成完整门禁的 7.6.2，不把尚在执行的 7.6.3 发布视为已验收产物。

## 发布前检查

| 检查 | 本次结果 |
| --- | --- |
| Linux `pnpm verify:release` | 项目/平台检查、类型检查、两套前端构建和完整发布门禁成功 |
| 单元测试 | 83 通过 |
| MCP 测试 | 115 通过、1 个既有可选 SoundFont 跳过 |
| 服务端发布测试 | 271 通过、2 跳过；包含隔离 PostgreSQL、CLI 与真实 Docker 执行器 |
| OVH 本地候选 CLI/MCP/Docker | Canvas 和 Remotion 创建、构建、帧、MP4 及媒体校验共 2/2 通过、0 跳过；专用数据库容器与网络已清理 |
| 成功 CI 摘要的正式镜像 | 无网络、只读容器中 doctor 通过，完整 Remotion 验收 1/1 通过、0 跳过；覆盖静态资源、正反向定位、音视频混合、播放/暂停、浏览器 WebM、分段 MP4、续渲和 FLAC/分轨 |
| Windows 门禁 | 实际依赖准备、中文安装路径和快捷方式、修复/卸载、TTS/SQLite、原生界面、浏览器作品/导出及真实更新/失败恢复通过 |

检查中的失败如实保留：版本标签候选的第一次 Remotion 检查在正式音频混合时出现 `tone.wav` 的 `net::ERR_ABORTED`；相同摘要、相同资源限制及未修改断言的第二次检查通过。该候选没有用于生产；成功 CI 的正式不可变摘要首次完整检查即通过。上述失败日志和两次结果均保留，不将重跑通过当作该请求中止原因已修复。

7.6.2 首次 Windows CI 的重启检查曾因 PID 未变化失败；未改变源码和断言的重跑通过，独立 [Windows 诊断运行](https://github.com/jianjianai/frame-studio/actions/runs/36753826247) 的 Windows 与 Linux 门禁也通过，该运行最终取消。并发 Windows 维护后来确认并修复启动实例状态竞争，详见 [7.6.3 Windows 记录](windows-control-center-v7.6.3-20261001.md)；本次 Linux 生产不执行 Windows 控制中心代码。

## 生产切换和验收

切换前无活动任务。旧应用、正式候选和生产数据库的 9 项迁移 ID 及 checksum 完全一致，无新增数据库迁移。持有生产发布锁，优雅停止并仅重新创建 `studio` 和 `controller`；只更新栈环境中的 `FRAME_VERSION`，Compose 文件字节和其他环境项保持，凭据保留。

生产应用和控制器均为 healthy；两者的 `FRAME_EXECUTOR_IMAGE` 与生产镜像一致。公网 `/healthz` 返回版本 7.6.2、冻结 revision；`/readyz` 返回 200，未登录 `/api/me` 返回 401。

- 公网真实 MCP：93 个工具，平台版本正确，回收站操作可发现；读取 6 种 TTS 提供商及能力，语音测试/任务状态/取消/引擎发现工具可发现。
- 公网 React/WebSocket 浏览器：作品列表、排序、回收站、工具指定版本弹窗、提供商和模型设置、390px 移动访问设置通过。语音 API 弹窗的 6 种提供商与 MCP 一致，切换提供商及地址均清除未保存的草稿密钥；关闭弹窗，未保存测试配置。4 张当前生产截图已实际查看。
- 全部 6 个在用作品的当前预览均成功，对应 `paper-wings`、`work-39d8b371`、`tiny-seed`、`work-8644ea78`、`the-learning-machine`、`sunny-rail`；预览版本 11 与当前源码、运行时一致。
- 全部 6 个作品在公网浏览器中完成 ready、定位、播放推进与暂停保持检查，浏览器错误 0。12 个大媒体文件均验证首尾各 16 字节的 HTTP 206、Content-Range 和实际内容一致。
- 切换前后 9 个作品的记录及源码树哈希、44 个素材记录完全一致；活动任务 0、临时验收令牌 0。完整性记录仅包含元数据和哈希，没有数据库转储或作品/素材归档。
- `speech`、生产 PostgreSQL、开发工作台及开发 PostgreSQL 的容器 ID 和启动时间完全保持。原生产 Speech 7.3.2 保留；新增 Qwen 桥接为按需配置能力，此次不启动 GPU 服务或下载模型。

本次不请求真实云端 TTS 合成或 AI 推理；云服务账号、音质和 Qwen GPU 效果不属于已验证结论。适配器协议和错误/取消路径由自动化夹具覆盖，生产验证了公开工具、配置界面及草稿密钥隔离。

主机证据目录为 `/opt/frame-release-7.6.2-20261001/`，包含 CI 结果、不可变镜像清单、候选检查、迁移兼容性、切换结果、生产功能/预览/媒体报告、截图和最终完整性结果。旧镜像及既有备份保留，没有删除数据卷或重启无关服务。
