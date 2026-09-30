# 作品回收站清理

- 基线：`main` / `fc1bf50`，新工作树 `frame-studio-work-trash`，分支 `fix/work-trash-purge`。
- 单个永久删除及清空回收站均接入网页和公共操作注册表，MCP/CLI 自动使用同一实现。清空跨分页，可按仓库或全部仓库执行，并显示失败作品和原因。
- 先删除准确的 `works/<project>` 远端分支，再清理本地工作树、分支、快照、任务、聊天、导出和素材引用。远端错误保留本地作品；本地清理中断有可重试标记。共享素材、其他作品、主分支及素材分支保留。
- 检查作品删除状态、名称确认、运行任务、撤销恢复和活跃文件读者；已清理作品不会因旧文件目录或过期发现结果重新导入。无需数据库迁移。

## 轻量验证

按本次要求只进行针对性检查，不运行全量视频导出或完整 verify。

- `node scripts/check-platform.mjs`：123 个文件的语法和相对引用通过。
- `node --test --test-timeout=30000 tests/server/work-purge.test.mjs`：SQLite 与独立测试 PostgreSQL 的 8 项全部通过，0 跳过，5.64 秒。使用临时本地 bare Git 仓库验证实际远端分支删除，覆盖拒绝删除、清理中断重试、31 个作品跨页清空、忙碌项保留、共享素材、未上传作品及防止重新导入。
- `vite build --config studio/vite.config.mjs --configLoader native`：工作台构建通过。使用 native 配置加载以保持复用依赖只读。
- `tsc --noEmit -p tsconfig.platform.json`：通过。
- `git diff --check`：通过。

本次只修改独立开发分支；验证使用临时作品和测试库，未清理生产作品或生产远端分支。
