# Paseo Windows 构建修复与 8.2.1 发布

## 已确认的问题

8.2.0 候选 `37e846faa5e6976d917a4a7ee1334fe757244fa2` 的完整门禁通过（176 单元、128 MCP、431 服务端通过，3 个明确跳过）。Git 标签 `v8.2.0` 已推送并保持不可变。

Windows 发布任务 `36947891428` / job `110654054465` 实际失败于官方 Paseo `scripts/build-daemon-web-ui.mjs`：`spawn npm ENOENT`。服务端 TypeScript 已编译成功，Web 导出启动前失败。日志保存在忽略的 `.cache/paseo-820/windows-failed-job.log`。安装包未发布成功，生产未切换。

## 修复与后续门禁

以独立上游补丁修复跨平台 npm 调用，保持完整官方 WebUI、参数和构建完整性检查。最终发布版本改为 8.2.1；旧源码标签、候选证明和失败日志保留。新候选、正式公开镜像、安装包、生产切换与实际浏览器验收均须分别核对，当前未完成。Windows 构建成功不等同于 Windows 原生应用运行验收。

## 8.2.1 首轮候选门禁

源码 `6c8c71163af2b9eda8f08933ce1fcdef8a80b8a6`，归档 SHA-256 `d986a9e913a4a455cd6f5b35eb555f6929cbeebddb5f99755229d462736cebe6`，候选镜像 `sha256:ee728287b140052df5148b621680d2aa4ac25458572490310ab4a3f492792cea`。完整 run `20261002T012935Z-84cdcc2c` 返回 1：176 单元通过；MCP 128 通过、1 可选音色库跳过；服务端 433 通过、1 失败、2 明确跳过，总计 737 通过、1 失败、3 跳过。

唯一失败为弱网浏览器测试的 CDP `Fetch.continueRequest` 在拦截器关闭时出现 `Invalid InterceptionId` 未处理 Promise。原始候选、源码与日志保留，未创建 v8.2.1 标签或切换生产。针对测试请求生命周期修复后必须重新完整候选门禁，不能把该轮算通过。


## 8.2.1 正式发布与生产验收发现

- 不可变源码 `fb54e036b54719ce8b60356ccfad5e102dacc044`；annotated `v8.2.1`；GitHub Release 已生成。
- 候选与正式镜像完整门禁分别 744 pass / 3 项明确允许的 skip / 0 fail。正式 OCI index `sha256:86e94f32f9c2fa481b41faa30b4f2e713abab07ae2d4e8dd3efc54bbe09b4e68`。
- Release CI `36955774936` 成功，包括 Windows 安装包与 app/speech 镜像；生产只切换 studio/controller，其他四个服务身份不变；未执行发布前备份。
- 生产原有六个作品的 original/compressed/cached 模式与测试作品真实 PNG/MP4 解码及有限非零 PCM 均通过；完整生产接受未通过，不能以镜像门禁/health 代替。
- 第二次实际接受 `00e6b87c3bd64a5d9df3311190177561` 显示 AI 面板展开但 Paseo session HTTP 503，daemon 启动未成功；自身测试作品/凭据/会话已清理。
- controller 真实 leader、Docker image inspect 与 runtime fingerprint 正常。六个作品各有 daemon 已监听 6767 的日志，却以 90 秒依次超时；Paseo 官方 Host middleware 在 health 路由之前，默认不接受 Docker daemon 容器名。现有 fullstack fixture 显式设置 localMode 和回环 URL，遗漏真实 Docker 分支。
- 另发现生产 Compose 没有 FRAME_AGENT_URL/FRAME_PUBLIC_URL，插件收到 `undefined/api/...` 而加载失败；默认语音模型为各作品重复下载，runtime 缺 bzip2 导致解压失败。
- 修复使用后继 8.2.2；不移动 8.2.1 tag、不覆盖其源码、镜像、门禁、失败接受与归档证据。本节记录发现，不代表 8.2.2 已接受或生产清理已完成。
