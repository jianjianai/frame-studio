# 作品库体验分支合并审核 · 2026-09-30

分支 `feat/work-library-ux`，原提交 `342cf78`。结论：值得合并，修复并发资料保存问题并完成回收站集成后纳入 main。

## 结论与集成

新增独立作品库入口、全部/最近/回收站范围、卡片与列表持久化、状态筛选、全局排序、封面回退、信息编辑、副本与空状态/错误恢复。服务端排序仅使用固定白名单，先排序后分页，以 id 保持稳定；最近打开空时间排后，修改时间包含成功创作任务。

原信息编辑发送名称、简介、状态，但未带版本，可覆盖其他窗口新值。现为 works_page 返回与 works_get 相同的 metadataRevision，保存传 expectedRevision；409 时保留表单输入，提示重新打开。真实 Pg 列表断言版本一致，Chromium 模拟并发简介更新后拒绝旧版本。

合并 main 时 studio/library.jsx 冲突以新界面结构整合既有永久删除能力：独立无筛选回收站总数、单项永久删除、跨页全部清空、未删除项错误及重试。永久删除置于菜单，避免窄屏操作列过宽；刷新、恢复与清理同步刷新总数，提示栏支持换行。其他自动合并保留权限设置和新工具管理。

## 本次轻量验证

隔离测试容器、只读共享依赖、临时 PostgreSQL/SQLite 和临时 Git 仓库；不挂载生产数据或 Docker socket。

- work-library、work-metadata-race、work-purge：13 项通过，0 失败/跳过。排序测试使用真实 PostgreSQL；删除测试使用真实本地 bare Git 及两种数据库。
- workbench-browser：1 项真实服务端 Chromium 检查通过，覆盖导航、实际隔离预览、尺寸调整、弹窗、后台连续性。
- library-review：10 组实际 React/Chromium + 模拟 API 流程通过，包括资料竞争、32 个回收站项目与筛选外总数、精确确认、部分失败重试、最后页移除后回退、390px 卡片/列表无横向溢出和无 pageerror。已查看桌面及回收站手机截图。
- check:platform（128 文件）、typecheck:platform、build:studio、git diff --check 通过。

首次额外 metadata-race 检查发现其 mock 缺少既有 purge recovery 使用的 setting 接口，使恢复分支短路；仅补 mock 接口后三种元数据场景通过。浏览器新增断言首次误选弹窗内通知 alert，已改为核验失败详情并重跑通过。上述失败均保留原日志于忽略缓存，不作为通过记录。

未跑全量发布流程，未发布生产服务。
