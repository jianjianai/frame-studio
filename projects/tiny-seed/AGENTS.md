# tiny-seed 修改边界

本视频项目的所有修改只允许在 projects/tiny-seed/ 内。源码、音频、素材、脚本、说明、测试和导出结果都放在本目录。不得修改公共引擎、公共 UI、根配置或其他项目；缺少公共能力时向工作台维护任务提出需求。

可只读引用 src/engine/ 的公开接口和仓库依赖。运行 pnpm project:check tiny-seed --strict 和 pnpm project:scope tiny-seed 检查结构与本次修改边界。公共命令从仓库根执行；生成结果保存在本目录 exports/。
