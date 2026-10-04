# T3 Code 创作工作台

FRAME 接入官方 [T3 Code](https://github.com/pingdotgg/t3code) 原生页面，通过 Codex app-server 和 Claude Code 执行创作。固定源码为 `v0.0.45`、commit `6c8fed35dded9ff71c5b46807125457acbb76be6`，保留 MIT 许可证。该标签的上游 package manifest 写作 `0.0.44`；FRAME 记录标签、commit 和 manifest，不把这个差异伪装成另一个版本。

## 使用

打开作品的 AI 侧栏进入当前作品聊天。侧栏保留原生输入、模型选择、附件、权限和流式执行；“打开完整工作台”进入同一服务的完整原生页面，继续当前对话并使用文件、Git、终端和设置。

设置 → AI 助手的“打开提供商与模型”打开原生设置。API、账号与模型使用 T3 页面及 Codex/Claude Code CLI 配置；FRAME 不再提供重复表单。CLI 升级保留在“创作工具”，T3 自身升级独立于 FRAME 镜像。

作品按权威工作目录绑定原生 project；多条 thread 使用相同 cwd，默认 local 模式。相同仓库 remote 不会把不同作品的聊天合并。回合的 FRAME 工具凭据根据实际 project/thread/cwd 核对，不能跨作品沿用。

“引用当前画面/选段”冻结播放器实际显示的 revision 和位置；素材引用在原生输入中显示。发送失败保留草稿，回执确认后重试不会重复执行。独立页面没有播放器时不生成虚假的上下文。作品检查直接验证当前目录，结果绑定被检查的 revision，源码更新后旧报告显示过期。

## 服务与存储

Docker 长期运行两个独立软件服务：FRAME 的 `studio/controller` 和共享 `t3`，不按作品启动 AI 容器。T3 经 FRAME 的 `/ai/` 同源网关访问，不需要额外域名或端口公开。原生账号、项目与历史在 `/data/ai/t3/`；FRAME 作品绑定、引用与验证在新的 AI 表中。

`/data/ai/shared/control.json` 自动生成服务间上下文凭据；T3 使用官方 CLI 签发的服务 token `/data/ai/t3/frame-service-token`。浏览器沿用 FRAME 登录，不接收服务管理 token。这些文件不入库、不要求用户填写。

AI 服务使用自己的 `/opt/t3` 原生代码与依赖。FRAME 的制作工具链一次发布到 `/data/runtime/<fingerprint>`，`current` 原子链接指向该版本；T3 将其只读挂载在 `/opt/frame`，作品复用公共源码和 node_modules。发布失败保留旧链接并清理本次临时文件。更换 T3 镜像不会复制或重建每个作品。

## 构建与独立升级

原生源、薄补丁及 portable runtime 锁文件在 `integrations/t3-code/`。`node scripts/build-t3.mjs --bundle-only` 生成 `.cache/t3-generated`；`--prebuilt=<目录> --runtime=<目录>` 安装候选，`--check` 验证已有安装。安装校验固定 commit、patch、锁文件和 bundle 指纹，保留原生完整页面。Windows 复用相同 portable Node `dist/bin.mjs`，不依赖 Linux 单文件二进制。

FRAME 使用 `deploy/Dockerfile`，T3 使用 `deploy/Dockerfile.t3`：`docker build -f deploy/Dockerfile.t3 --build-context t3_bundle=.cache/t3-generated -t <原生镜像> .`。独立发布工作流为 `.github/workflows/release-t3.yml`。`FRAME_VERSION` 与 `FRAME_T3_VERSION` 分别选择镜像。首次启动 T3 前，使用候选 FRAME 镜像在栈外发布共享核心：

```sh
docker run --rm --network none --read-only --user 1000:1000 \
  --mount "type=bind,source=/opt/stacks/frame/data,target=/data" \
  ghcr.io/jianjianai/frame-studio/app:8.4.0 \
  node scripts/publish-runtime.mjs /data/runtime
```

更新原生服务时，先完成源码/补丁校验和真实协议、浏览器测试，核对活动回合及权限请求，然后只切换 `t3`。数据目录及共享核心继续复用。更新 FRAME 工具链时先发布新核心，再重新创建 T3 挂载；T3 版本不随 FRAME 版本暗中改变。每次正式发布记录镜像身份及实际验收，见 [维护记录](../records/2026-10-04-t3-code-8.4.0.md)。
