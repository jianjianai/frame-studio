# Paseo Docker 启动复核

## 本次发现

生产 controller leader 与 immutable executor image 正常，实际官方 daemon bootstrap 约140ms并监听，但默认 Host middleware 拒绝容器名的健康请求。逐作品串行90秒超时使后续会话还停留cold/gen0。
既有正式镜像全栈测试采用localMode与127.0.0.1，覆盖不到此路径。缺省FRAME bridge URL与语音缓存重复下载也在真实生产发现。

## 修复范围与待验证项

8.2.2管理的daemon自动适配内部Host、回连studio服务，保持现有显式URL设置；有界并发启动、失败阶段可观测、公共提示可重试。
语音模型由可信后台准备，作品只读共享；保留官方完整语音功能与自定义模型设置。runtime补bzip2。引擎runtime identity覆盖Paseo管理配置。
增加独立Docker网络/测试数据库/同镜像controller和6个官方daemon的回归，真实插件、选中配置与work-tool回调，不发送付费生产模型turn。
候选、正式镜像、生产接受和垃圾清理结果将在实际完成后追加。此文件当前不是通过报告。

## 已完成的针对性检查

在 Node 24.21.0 下，启动/代际/错误/ready 重开语音重试目标 17/17 通过，共享语音模型目标 15/15 通过（包含真实 SIGKILL 后孤儿硬链接恢复），均为零跳过。官方 server 类型检查、入口语法、固定上游及四补丁严格校验通过。
这些结果不替代候选与正式镜像完整门禁，也不代表生产启动和真实语音推理已通过。
