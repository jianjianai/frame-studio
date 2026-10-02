# Paseo Windows 构建修复与 8.2.1 发布

## 已确认的问题

8.2.0 候选 `37e846faa5e6976d917a4a7ee1334fe757244fa2` 的完整门禁通过（176 单元、128 MCP、431 服务端通过，3 个明确跳过）。Git 标签 `v8.2.0` 已推送并保持不可变。

Windows 发布任务 `36947891428` / job `110654054465` 实际失败于官方 Paseo `scripts/build-daemon-web-ui.mjs`：`spawn npm ENOENT`。服务端 TypeScript 已编译成功，Web 导出启动前失败。日志保存在忽略的 `.cache/paseo-820/windows-failed-job.log`。安装包未发布成功，生产未切换。

## 修复与后续门禁

以独立上游补丁修复跨平台 npm 调用，保持完整官方 WebUI、参数和构建完整性检查。最终发布版本改为 8.2.1；旧源码标签、候选证明和失败日志保留。新候选、正式公开镜像、安装包、生产切换与实际浏览器验收均须分别核对，当前未完成。Windows 构建成功不等同于 Windows 原生应用运行验收。
