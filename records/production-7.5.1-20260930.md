# Frame Studio 7.5.1 生产发布验收

日期：2026-09-30（UTC）。生产：https://frame.nerviloom.com 。

## 发布身份

- Remotion 初始实现：`06b7de9`。推送前远端已有 Windows 安装器 7.4.1，因此保留合并并发布 7.5.0（`fc1bf50`），随后修复真实执行器资源问题发布 **7.5.1**。
- 生产冻结源码：`5a9d970728b0a2c2b2faf3fc311e6dedc86f5edf`，标签 `v7.5.1`。
- Studio、Controller 和新建任务执行器统一使用：
  `ghcr.io/jianjianai/frame-studio/app:7.5.1@sha256:7c7b2ea171ef58eec029a268776d30c3edb704e331ff09c216b80f2b8cfcbfc2`。
- [正式发布](https://github.com/jianjianai/frame-studio/releases/tag/v7.5.1)；[统一发布 CI](https://github.com/jianjianai/frame-studio/actions/runs/36717339777)。
- 发布后的 `6d050c8` 仅修正测试场景间浏览器释放，未改生产应用。记录提交时 main 已另外合入访问设置界面修复；这些后续提交未混入本次固定生产镜像。

## 发现和修复

7.5.0 的既有作品验收通过，但真实 Remotion 导出任务在 PIDs 256 边界停滞：诊断观察到 PIDs 255，内存约 1.127 GiB，并存在两个 Chromium 实例。取消自建任务后，将任务容器默认 PIDs 提至 512；继续保留 2 CPU、4 GiB 内存、非 root、能力移除和 no-new-privileges 等限制。新增真实 Docker 执行器 Remotion 构建、单帧和带音频 MP4 回归，覆盖 FrameScene、原生音频、Frame 生成音频、SVG、裁剪与帧率转换。

严格镜像测试最初也暴露了测试夹具保留上一场景浏览器的问题。`6d050c8` 在各场景结束时关闭对应浏览器，仅增加资源释放，未减少断言或提高额度。使用正式 7.5.1 镜像，只读挂载该测试文件后，在断网、只读根目录、2 CPU、4 GiB、PIDs 512、64 MiB shm 下通过完整 Remotion 测试，包括原生单帧、反向寻帧、视频、裁剪、帧率、音频、Player、WebM、捕获、分段导出、恢复、FLAC 和分轨。

## 发布前验证

- 统一 CI：361 项通过、3 项明确跳过。单元测试 83；MCP 86 通过及 1 跳过；服务端 192 通过及 2 跳过。
- 跳过项为 Linux 上的 Windows 专属测试及可选 GeneralUser 资源场景；独立 Windows 作业实际验证 EXE 安装、工作台渲染、修复、失败恢复、缓存复用和保留数据卸载。
- Windows 安装包：`FrameStudio-v7.5.1-win-x64-Setup.exe`，1,546,110 bytes，SHA-256：`783ab9f7076e394b7b4073e4095d2db450648ba5c256225a57fca17354eef19b`。
- OVH 冻结候选源码的真实 Docker Canvas + Remotion 回归：2 项通过，总耗时约 64.9 秒。第一次共享测试库运行失败，存在并行干扰迹象；原始失败日志保留。最终使用本次专用数据库 `frame_test_remotion_751` 完成验证，未修改测试断言。
- 正式候选镜像 doctor 和上述严格 Remotion 镜像测试通过。

## 生产切换

仅重建 Studio 和 Controller。Speech 保持 7.3.2；PostgreSQL、开发服务及开发数据库的容器身份和启动时间保持不变。7.3.2、7.5.0、7.5.1 的 9 项迁移标识与校验和一致，数据库实际迁移记录匹配；无需数据迁移。按现行仓库约定未进行发布前数据库转储或作品、素材、模型归档。未新增常驻一次性服务，未删除旧镜像。7.3.2 可作为兼容回退基线；7.5.0 虽然数据库兼容，但存在上述 Remotion PIDs 限制。

## 线上验收

5 个当前作品全部重新构建并完成真实浏览器加载、跳转、播放和暂停：
`paper-wings`、`work-39d8b371`、`tiny-seed`、`the-learning-machine`、`sunny-rail`。

12 份大于 10 MiB 的 SF2/WAV 素材验证首尾各 16 bytes Range 请求，均返回 206 且内容与源文件一致，最大 50,688,078 bytes。浏览器无错误；既有作品截图与 Remotion 截图已实际查看。

生产 MCP 返回 87 个工具，版本 7.5.1，创建参数包含 remotion，作者文档可用。临时作品使用 Sequence、useCurrentFrame、staticFile、SVG、类型完整的 FrameScene，以及原生 Audio 和 Frame 生成音频：

| 任务 | ID | 结果 |
| --- | --- | --- |
| 构建 | c057e659-bdb5-4b74-bfc3-9db205593ea5 | succeeded |
| 单帧 | d8248117-0ac2-4cbd-87d4-bbe7a6395a4b | succeeded，PNG 4,304 bytes，绿色像素断言通过 |
| MP4 | c3682082-b4bc-4fb4-96be-561b97915c74 | succeeded，10,749 bytes，320×180、36 帧、24 fps，含音频 |

三项任务 runtime 均匹配正式生产摘要与冻结源码。MP4 从 12 fps 源裁剪 0.27–1.77 秒并转换为 24 fps。Remotion 播放器跳转第 6 帧、播放和暂停通过，浏览器错误为空。

原有 7 条作品记录及源内容校验、28 条素材记录保持一致。临时作品 `work-97970031` 已移入回收站；验收令牌已撤销，最终活动任务为 0。验收重试产生的 7 条小型 tone 素材记录仍与该回收站作品关联：官方 detach/trash 在引用重新扫描后返回 409，因此保留关联和文件，没有绕过保护或永久删除。另有现有作品的 465-byte `poster.svg` 被正常扫描为新素材，已保留。

公开端点：`/healthz` 200，版本 7.5.1、revision 5a9d970；`/readyz` 200；未登录访问 `/api/me` 401。

验收脚本初次运行中出现临时场景缺少严格类型、误读简略 task 响应 runtime 字段、sharp 入口路径及重复下载路径问题；修正验收脚本后重新完整执行通过，未放宽产品断言。初始与最终结果分别保留。

## 证据

服务器目录 `/opt/frame-release-7.5.1-20260930/`：

- `source/` 冻结源码，`candidate.json`、`candidate-doctor.json`、`candidate-remotion.log`。
- `local-regression.log`、`local-regression.exit`（0）、首次共享库失败日志及严格镜像首次失败日志。
- `ci-result.json`、`deploy-summary.json`、`migration-compatibility.json`。
- `production-previews.json`、`production-browser.json`、`production-remotion.json`、`final.json`、`final-summary.json`、`qa-cleanup.json`。
- `release-751-*.png`、`release-751-remotion.mp4` 及临时作品身份文件。
- 最终完整成功验收 session：`session-c0c5e7573c0f5302d0450935`（退出 0）。`production-remotion-rerun.exit` / `production-remotion-rerun.json` 记录成功重跑；原 `production-remotion.exit` 的 1 保留为首次驱动失败证据。

7.5.0 初始切换、数据基线与 PIDs 问题证据保留在 `/opt/frame-release-7.5.0-20260930/`。CI 服务端原始日志另存于仓库忽略目录 `.cache/release-751-server.log`。
