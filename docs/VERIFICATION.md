# 验证与发布门禁

`pnpm verify` 是完整平台验收：工程检查、全部 server/studio JS/JSX 语法与相对导入检查、原 TypeScript 检查、关键聊天模块 JSDoc 类型检查、单元/MCP 测试、播放器和工作台构建、服务端与真实浏览器测试。工作台先构建，再执行浏览器测试，避免使用上次构建结果。

平台类型检查采用增量方式，而非一次重写全部既有 JavaScript。`tsconfig.platform.json` 先覆盖草稿快照和事件加载；`check:platform` 覆盖全部平台源码的语法及相对依赖，不冒充类型检查。

## 本地统一验收

需要 Node/pnpm、FFmpeg/FFprobe、受支持 Chromium 和独立 PostgreSQL 测试数据库。`FRAME_TEST_DATABASE_URL` 的数据库名必须包含 `frame_test`，且不能指向 `DATABASE_URL` 同一个数据库。测试会清空该测试数据库中的表，严禁使用生产库。

```powershell
$env:FRAME_TEST_DATABASE_URL = 'postgres://frame:<测试库密码>@127.0.0.1:5432/frame_test_review'
pnpm verify
```

`pnpm test:server` 默认缺少数据库会失败，不再静默把集成测试全部跳过。仅开发时允许显式使用 `pnpm test:server:light`；该命令会提示有跳过，不能作为发布验收。单独运行完整服务端测试前先执行 `pnpm build:studio`。

## 发布验收

在隔离 Linux/WSL checkout 中构建候选执行器镜像，并配置：

```sh
export FRAME_TEST_DATABASE_URL='postgres://frame:<测试库密码>@127.0.0.1:5432/frame_test_release'
export FRAME_TEST_EXECUTOR=1
export FRAME_TEST_HOST_ROOT="$PWD"
export FRAME_EXECUTOR_IMAGE=frame-studio:verification
docker build -f deploy/Dockerfile -t "$FRAME_EXECUTOR_IMAGE" .
pnpm verify:release
```

完整执行器用例需要能够访问 Docker、对自己创建的测试目录执行 chown，并从默认 Docker bridge 访问本机 55178/55179 端口。可在专用测试虚拟机或 root WSL 中执行，不在生产目录执行。它使用隔离模拟模型服务，不调用收费账号。

发布门禁拒绝执行器、数据库或未知用例的跳过。唯一显式可选项是用户提供的 GeneralUser 音色库：设置 `FRAME_TEST_SF2` 后启用；没有该文件会单独列明跳过，其生成音色库测试始终执行。平台自身新增的短片验收不依赖私有作品，覆盖确定性跳转、有声播放、取消和重新导出、完整视频帧数及音频流。

GitHub 镜像发布必须依赖同一 `verify:release` 成功。本地发布也应先执行相同命令；直接手工 `docker push` 不受工作流约束，不能据此声称已经验收。

## 作品回归与人工审片

`pnpm verify:content` 仍是独立内容入口，需要先把作品仓库复制到临时 checkout。不要把作品提交进平台仓库。真实长片还需检查多音轨、慢网冷跳转、变速、声画漂移、音效边界、正式导出与预览的一致性，以及音乐和运镜质量；短片功能验收不能替代这些检查。
