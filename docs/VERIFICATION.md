# 验证与发布门禁

V5 新增执行配置冻结、版本引用、逆向撤销/中断恢复、定向实时订阅和真实浏览器前后审片测试，仍包含在统一 `test:server` 中。工作台构建需包含当前路由分块；不复用旧构建。完整升级与兼容边界见 [V5 升级说明](V5-UPGRADE.md)。

`pnpm verify` 是完整平台验收：工程检查、全部 server/studio JS/JSX 语法与相对导入检查、原 TypeScript 检查、共享协议与实时订阅 JSDoc 类型检查、单元/MCP 测试、播放器和工作台构建、服务端与真实浏览器测试。工作台先构建，再执行浏览器测试，避免使用上次构建结果。

平台类型检查采用增量方式，而非一次重写全部既有 JavaScript。`tsconfig.platform.json` 覆盖实时预览、共享协议、实时订阅和操作注册器；`check:platform` 覆盖全部平台源码的语法及相对依赖，不冒充类型检查。

## 本地统一验收

需要 Node/pnpm、Git 与 Git LFS、FFmpeg/FFprobe、受支持 Chromium 和独立 PostgreSQL 测试数据库。`FRAME_TEST_DATABASE_URL` 的数据库名必须包含 `frame_test`，且不能指向 `DATABASE_URL` 同一个数据库。测试会清空该测试数据库中的表，严禁使用生产库。

```powershell
$env:FRAME_TEST_DATABASE_URL = 'postgres://frame:<测试库密码>@127.0.0.1:5432/frame_test_review'
pnpm verify
```

`pnpm test:server` 默认缺少数据库会失败，不再静默把集成测试全部跳过。仅开发时允许显式使用 `pnpm test:server:light`；该命令会提示有跳过，不能作为发布验收。单独运行完整服务端测试前先执行 `pnpm build:studio`。

## 发布验收

在当前开发 checkout 构建候选镜像，测试使用独立数据库、临时作品目录与端口，并配置：

```sh
export FRAME_TEST_DATABASE_URL='postgres://frame:<测试库密码>@127.0.0.1:5432/frame_test_release'
export FRAME_TEST_EXECUTOR=1
export FRAME_TEST_HOST_ROOT="$PWD"
export FRAME_EXECUTOR_IMAGE=frame-studio:verification
docker build -f deploy/Dockerfile -t "$FRAME_EXECUTOR_IMAGE" .
pnpm verify:release
```

完整执行器用例需要能够访问 Docker、对自己创建的测试目录执行 chown，并从默认 Docker bridge 访问本机 55178/55179 端口。Paseo 工作流门禁使用镜像内的完整官方 daemon/WebUI，验证默认打开、多对话共享目录、保存后画面更新、版本引用、失败保留修改，以及独立标签页原生发送和重连。可在专用测试虚拟机或 root WSL 中执行，不在生产目录执行。它使用隔离模拟模型服务和 CLI 协议，不调用收费账号；不能据此宣称生产外部账号登录或付费模型已经验收。

发布门禁拒绝执行器、数据库或未知用例的跳过。唯一显式可选项是用户提供的 GeneralUser 音色库：设置 `FRAME_TEST_SF2` 后启用；没有该文件会单独列明跳过，其生成音色库测试始终执行。平台自身新增的短片验收不依赖私有作品，覆盖确定性跳转、有声播放、取消和重新导出、完整视频帧数及音频流。

GitHub 工作流只负责构建与发布，不运行 `verify`、`verify:release` 或 Windows 功能测试。开发验收在本地或独立开发环境执行；发布成功只证明资产构建和上传完成，不能据此声称功能测试已经通过。实际验收结果单独记录在 records 中。

## 作品回归与人工审片

`pnpm verify:content` 仍是独立内容入口，需要先把作品仓库复制到临时 checkout。不要把作品提交进平台仓库。真实长片还需检查多音轨、慢网冷跳转、变速、声画漂移、音效边界、正式导出与预览的一致性，以及音乐和运镜质量；短片功能验收不能替代这些检查。

候选构建可复用经 `scripts/build-paseo.mjs --bundle-only` 生成的官方源码 bundle：Docker 参数 `--build-arg PASEO_MODE=prebuilt --build-context paseo-prepared=<bundle目录>`。安装时仍逐项校验固定 commit、全部 patch、插件、依赖与 bundle 内容；任一不匹配会拒绝构建。默认构建仍从固定官方源码生成。

升级前核对活动 FRAME 任务、原生 Paseo Agent/终端/权限请求以及旧 `paseo_candidates`。旧候选非空时迁移拒绝升级并保留其运行身份，需先完成定向核对。退役旧 AI 的迁移删除旧聊天和专用任务数据，随后在栈外使用 `docker run --rm` 执行 `scripts/clear-legacy-ai.mjs` 清理已记录身份的旧文件/容器；不会删除作品、素材、当前原生 Paseo 会话或数据卷。不可用旧版应用直接回滚已移除旧 schema 的数据库。
