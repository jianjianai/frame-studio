# 日光快线 · 工程索引

工程 id：`sunny-rail`。

## 文件位置

- `src/projects/sunny-rail/project.ts`：元数据和模块入口。
- `src/projects/sunny-rail/scene.ts`：Scene 接口实现。
- `src/projects/sunny-rail/motion.mjs` 与 `motion.d.mts`：共享给本工程处理脚本的确定性运动计算。
- `public/audio/sunny-rail.wav`、`public/posters/sunny-rail.webp`：运行资源；保留已有路径。
- `scripts/music/`：现有共用处理工具；`production/music/`：对应源文件与参数，不另复制一份。

## 命令与写入范围

`pnpm project:check sunny-rail` 只读检查。`pnpm posters --project sunny-rail` 更新该工程封面；`pnpm music:build sunny-rail` 更新该工程音频及相关共享素材/波形条目，生成中间文件位于 `exports/demo-polish/audio/`，该共享索引写入应串行进行。

依赖由根 package.json / pnpm-lock.yaml 管理；外部工具配置参考根 README。

## 测试覆盖

现有覆盖位于 `tests/unit/projects.test.ts`、`tests/unit/demo-polish.test.ts`、`tests/e2e/demo-polish.spec.ts` 和 `tests/e2e/studio.spec.ts`。新增接口/文件写入变更需保持这些回归。

## 关联文件

资源来源和许可证在 `production/music/GENERALUSER-LICENSE.txt`、`public/ASSET-LICENSES.md`。本索引不增加创作或交付规则；旧记录仍在原路径。
