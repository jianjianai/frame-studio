# 任务工具运行目录惰性解析修复（2026-10-02）

## 问题与范围

首轮 8.2.0 正式候选镜像完整门禁有四项相关失败：creator-flow 的素材分页，以及 v8-creator-preview-policy 的三项预览/参数拒绝/凭据拒绝测试。

`server/agent-tools.mjs` 在任何分支与无任务凭据检查前执行 `path.join(data, "runs", ...)`。只需要素材分页或预览查询的调用不依赖文件系统目录，精确测试夹具无需提供 data；因此路径解析的 TypeError 提前遮蔽了正常参数和权限拒绝逻辑。正式生产装配有真实 data，修复同时恢复无 task 请求的 403 次序。

仅修改公共 `server/agent-tools.mjs`，没有改测试夹具、参数格式、素材仓库约束、分页断言、预览来源校验或任务凭据策略。没有修改已经归档的候选源码、镜像或生产环境。

## 修改

1. 先检查绑定任务，缺少任务仍返回 403。
2. 运行目录改为惰性函数，保留原有 `task.runRoot` 优先与旧任务 data/runs 路径规则。
3. 仅在 `engine_test` 复制预览文件，以及 `use / speech` 导入素材文件时调用该函数。
4. 素材仓库关系和回收站检查仍先于导入文件的目录解析；preview 参数与数据库查找顺序保持不变。

Diff 为 3 行增加、3 行删除；没有无关格式化。

## 验证

开发容器 Node 24，独立端口 `FRAME_TEST_PORT=59489`，顺序执行以下两个完整测试文件：

```sh
node --test --test-concurrency=1 --test-reporter=tap \
  tests/server/creator-flow.test.mjs \
  tests/server/v8-creator-preview-policy.test.mjs
```

19/19 通过，0 失败、0 跳过、0 取消；TAP 总耗时 12.38 秒。这两个目标使用自身临时文件和受限数据库替身，不需要 PostgreSQL，也未启动其他数据库测试套件。

`node --check server/agent-tools.mjs` 和精确文件 `git diff --check` 均通过。

- 修改后文件 SHA-256：`0f6fb73b1bd04f4c6b72674ae74af1092c0ebf9c5d5849f69e5963d7ffb98955`。
- 测试日志：`.cache/paseo-integration/agent-tools-lazy-root-target.log`。
- 测试日志 SHA-256：`5ca7267173ef9343e3173bdb3f224e4d0c50bcbb72088c5c1624ab36776670fe`。

原正式候选失败证据保留；这个精确目标通过不等同于新版正式镜像全量门禁或生产部署通过。
