# Paseo additive schema 与 8.1.1 兼容检查

本记录使用自有 PostgreSQL fixture 数据，不是生产数据回滚演练。没有读取、转储或归档生产数据库、作品、素材或凭据。

## 固定来源

- 原正式镜像：`ghcr.io/jianjianai/frame-studio/app:8.1.1@sha256:ef9ce25537d9e706457352a21e596f873db43932ba4bb6a70c24c0b06f50d04f`。
- OCI revision 与原 `/healthz` 均为 `79c603f286c4668d8c074adc4285fa454c5239de`，版本为 `8.1.1`。
- 新增 schema 使用当前 `server/paseo-store.mjs` 与 `server/paseo-migrations/`，实际源码 SHA-256 在自有机器 receipt 中保留。
- 最终执行：`.cache/paseo-integration/verify-811-additive.py`，exit 0。
- 最终 receipt：`.cache/paseo-integration/compat-811/e6db5ac286cc43358ff3fa2fac10e19e/summary.json`；阶段日志与早期 fixture 配置失败均保留。

## 已验证

1. 用原 8.1.1 镜像初始化独立临时 PostgreSQL，创建自有作品、源码、素材关系、blob、旧 chat/task/event。
2. 实际运行新的独立 Paseo ledger 两项迁移与三个元数据表。在 schemaAdditive 阶段，核心 ledger、所有旧表 rows、源码字节和文件 mode 完全相同。
3. 实际运行 8 个并发冻结请求并拒绝变化意图；8 个并发 candidate CAS 只有一个领取成功，验证状态转移持久化。
4. 同一个临时数据库再次由原 8.1.1 镜像的 `database` 与 `createApp` 打开，无 unknown core migration。SQL 查询和真实 `/healthz` 均通过。
5. 旧 chats/tasks/events、素材及关系、blob、源码字节/mode/source_revision 保持精确一致。作品只有 `source_generation`、`source_indexed_at` 两个派生索引字段按合法单调规则变化；Paseo 元数据保持精确不变。
6. 所有自有临时容器、临时网络及 fixture 素材树已删除；检查日志和 receipts 保留。

## 实际限制与既有行为

- 纯 schema fixture 没有生产 controller、speech 和 Docker 就绪依赖，因此原 `/readyz` 如实返回 `503 degraded`。本检查不证明生产 rollout readiness，也不代替发布镜像完整 gate。
- 原 8.1.1 `seedSpeech()` 在每次启动时，为官方 catalog 三个固定内置 engine 重新加密 config，随机 nonce 使密文字节变化。逐项验证解密 JSON 与其他 engine 字段完全相同；非内置配置仍要求原字节一致。因此 receipt 明确 `allLegacyTableBytesIdentical=false`，没有把正常启动行为伪装成逐字保存。
- 每次重写内置 speech 密文是与此次 Paseo schema 无关的优化发现，本轮未修改 speech；是否减少无变化时的写入由后续维护决定。
