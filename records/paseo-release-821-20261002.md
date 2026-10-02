# Paseo Windows 构建修复与 8.2.1 发布

## 已确认的问题

8.2.0 候选 `37e846faa5e6976d917a4a7ee1334fe757244fa2` 的完整门禁通过（176 单元、128 MCP、431 服务端通过，3 个明确跳过）。Git 标签 `v8.2.0` 已推送并保持不可变。

Windows 发布任务 `36947891428` / job `110654054465` 实际失败于官方 Paseo `scripts/build-daemon-web-ui.mjs`：`spawn npm ENOENT`。服务端 TypeScript 已编译成功，Web 导出启动前失败。日志保存在忽略的 `.cache/paseo-820/windows-failed-job.log`。安装包未发布成功，生产未切换。

## 修复与后续门禁

以独立上游补丁修复跨平台 npm 调用，保持完整官方 WebUI、参数和构建完整性检查。最终发布版本改为 8.2.1；旧源码标签、候选证明和失败日志保留。新候选、正式公开镜像、安装包、生产切换与实际浏览器验收均须分别核对，当前未完成。Windows 构建成功不等同于 Windows 原生应用运行验收。

## 8.2.1 首轮候选门禁

源码 `6c8c71163af2b9eda8f08933ce1fcdef8a80b8a6`，归档 SHA-256 `d986a9e913a4a455cd6f5b35eb555f6929cbeebddb5f99755229d462736cebe6`，候选镜像 `sha256:ee728287b140052df5148b621680d2aa4ac25458572490310ab4a3f492792cea`。完整 run `20261002T012935Z-84cdcc2c` 返回 1：176 单元通过；MCP 128 通过、1 可选音色库跳过；服务端 433 通过、1 失败、2 明确跳过，总计 737 通过、1 失败、3 跳过。

唯一失败为弱网浏览器测试的 CDP `Fetch.continueRequest` 在拦截器关闭时出现 `Invalid InterceptionId` 未处理 Promise。原始候选、源码与日志保留，未创建 v8.2.1 标签或切换生产。针对测试请求生命周期修复后必须重新完整候选门禁，不能把该轮算通过。
