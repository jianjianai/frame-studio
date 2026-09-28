# 素材传输：MCP、HTTP 与命令行

这些入口共用素材传输实现，将原始字节写入本项目 `public/imports/`，自动更新 `public/assets.json` 并返回 `assetUrl`、SHA-256、来源与许可。图像不重新编码，音频不预混，模型不转换。原有 `film import` 的图像优化行为保留。

## 选择入口

| 输入 | 建议方式 |
| --- | --- |
| AI 可以取得真实的公网 HTTPS 素材 URL | `frame_fetch_asset` 后台拉取，随后查询上传状态 |
| AI 工具能够读出小文件字节 | `frame_upload_asset`，最多 1 MiB 的规范 base64 |
| 外部程序传输大文件 | HTTP 原始字节分块，或命令行 `--remote` 自动处理 |
| 客户端只能发送 MCP JSON | `frame_asset_upload` 分块，按返回的偏移续传 |
| 文件已经在本机 | `film asset <id> upload <file>`，原样保存并登记 |

ChatGPT 附件是否能变成可下载 URL 或字节，取决于客户端实际提供的能力。服务不能读取客户端沙箱内的路径，不接受虚构的链接或占位 base64；无法提供 URL/字节时，可以用本机命令行上传。传输成功不代表 AI 已完成视觉或听觉审阅。

## 命令行

```powershell
# 本机导入，保持原文件字节
pnpm film asset my-film upload "D:/assets/character.glb" --license "原创素材" --json

# 使用当前工作区 .env 中的公网地址和 Bearer token 上传
pnpm film asset my-film upload "D:/assets/music.wav" --license "来源与许可" --remote --json

# 指定其他服务器，凭据从环境变量读取，不写入命令参数
pnpm film asset my-film upload "D:/assets/character.png" --license "原创" --endpoint https://your-mcp-domain/mcp --token-env FRAME_MCP_BEARER_TOKEN --json

# 断线后用此前打印的 uploadId 续传；本地文件必须与原 SHA-256 和文件名一致
pnpm film asset my-film upload "D:/assets/music.wav" --resume <uploadId> --remote --json

# 后台 URL 拉取；CLI 等待结果，MCP 立即返回 uploadId
pnpm film asset my-film fetch "https://your-source/material.glb" --filename character.glb --license "来源与许可" --remote --json
pnpm film asset my-film status --id <uploadId> --remote --json
pnpm film asset my-film complete --id <uploadId> --remote --json
pnpm film asset my-film abort --id <uploadId> --remote --json
pnpm film asset my-film prune --remote --json
pnpm film asset my-film capabilities --json
```

进度及可恢复的 `uploadId` 写入 stderr，最终结构化结果写 stdout；失败退出非零。远程上传对短暂连接失败、限流及服务忙进行有限重试；分块与完成操作可安全重复。`--remote` 使用静态 Bearer 凭据，OAuth 客户端使用下面的 HTTP/MCP 接口。生产素材的长期目录使用 `asset.path`，不要引用缓存路径。

## MCP 工具

### 小文件

`frame_upload_asset` 参数：`project`、`filename`、`license`、`dataBase64`，可选 `sha256`、`source`、`requestId`。`requestId` 是调用方生成的 UUID；在重试时复用同一值，防止响应丢失后重复导入。相同 ID 搭配不同元数据会明确拒绝。

### 分块上传

`frame_asset_upload` 的 `action`：

1. `begin`：提供 `filename`、完整文件 `bytes`、`license`，建议提供完整 SHA-256 与用于重试去重的 `requestId`。返回 `uploadId`、`receivedBytes`、`chunkBytes`、到期时间和远程传输入口。
2. `chunk`：提供 `uploadId`、`offset`、`dataBase64`；可选 `sha256` 在这一步指当前分块的哈希。分块必须按偏移顺序发送。已确认片段只有字节完全相同时才接受重试。
3. `status`：提供 `uploadId`，读取已确认偏移；URL 下载可额外设置 `waitMs: 20000`，减少快速轮询。
4. `complete`：长度、完整 SHA-256（如提供）、扩展名与格式校验通过后登记素材。重复完成返回相同产物。
5. `abort`：取消下载并清除尚未发布的字节，保留状态回执；不会删除已发布素材。
6. `prune`：清理当前授权主体已过期、可安全回收的缓存与回执，跳过其他主体、存活工作进程、正在提交或未知文件。

每个 `begin` 默认创建新传输；需要请求级去重时必须复用 `requestId`。上传缓存不占用整个制作任务的项目锁，开始分配配额和最后登记时短暂获取项目锁。遇到渲染或编辑正在占用项目，等待后重试，不删除其他任务的锁。

### URL 拉取与素材读取

`frame_fetch_asset` 参数：`project`、真实 `url`、`filename`、`license`；可选 `sha256`、`maxBytes`。立即返回上传回执，用 `frame_asset_upload status` 查询。`completed` 表示已经登记；`ready` 表示下载完成但最终登记被项目占用等条件阻止，可以重试 `complete`。`failed` 或 `interrupted` 的 URL 下载需要取消后重新拉取；URL 下载本身不承诺 HTTP Range 续传。上传的字节分块则可跨服务重启续传。

`frame_read_asset` 仅读取本项目已登记的 `public/imports/` 素材。默认返回元数据和需要认证的下载链接；`metadataOnly: false`、`offset`、`length` 返回最多 1 MiB 的 base64、当前块 SHA-256、`nextOffset` 和 `eof`。这是文件传输接口；看图片仍使用原生图片审片工具。

## HTTP 原始字节通道

每个请求都携带 `Authorization: Bearer <token>`；支持现有 OAuth access token 或静态 Bearer。写操作需要 `frame:write`，只读身份不能上传或取消。上传属于创建它的授权主体，OAuth 刷新令牌后仍可继续，同一授权可跨服务重启续传。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /uploads/<project>` | JSON：`filename`、`bytes`、`license`、可选 `sha256/source/requestId` |
| `GET /uploads/<project>/<uploadId>` | 查询已确认的字节偏移和结果 |
| `PATCH /uploads/<project>/<uploadId>` | `Content-Type: application/octet-stream`，`Upload-Offset: <offset>`，body 是原始字节；可选 `X-Chunk-SHA256` |
| `POST /uploads/<project>/<uploadId>/complete` | 校验并登记，body 可空 |
| `DELETE /uploads/<project>/<uploadId>` | 取消并清除尚未发布的字节 |
| `GET/HEAD /assets/<project>/public/imports/<filename>` | 带认证的素材下载，支持单段 `Range` |

URL 与请求方法也会在 MCP 回执的 `transport` 中返回。文件内容不进入 URL，不产生匿名分享链接，不接受 URL query 中的访问令牌。HTTP 下载链接需要客户端发送认证头，不能假定 ChatGPT 内置网页查看器会自动附加凭据。

## 容量、格式与失败恢复

- 单个素材最多 **512 MiB**；每块最多 **1 MiB**。项目暂存保留配额 **1 GiB**，最多 16 个未完成传输；每个授权最多 2 个并行 URL 下载。上传回执有效期 24 小时，已完成素材长期保留，过期缓存由显式 `prune` 回收。
- 支持 PNG/JPEG/WebP/AVIF/GIF、WAV/MP3/OGG/M4A/FLAC、MP4/WebM、GLB/内嵌 glTF、SF2、MIDI、TTF/OTF/WOFF/WOFF2。SVG 保持现有文本编辑或本机导入流程，不作为此接口的二进制上传格式。
- glTF/GLB 拒绝外部 URI 依赖。文件签名、图像元数据、模型结构与字节完整性检查不代替完整解码、兼容性或内容质量验收。上传不会自动添加到音轨，也不自动合成音频或生成波形。
- URL 拉取仅支持公网 HTTPS 443；每次跳转重新检查域名解析，并固定连接到已检查的公网地址，拒绝回环、私网、链路本地和特殊地址。不接收自定义 Cookie/Authorization 头。最多 5 次跳转、15 秒连接空闲、180 秒下载时限；不信任 Content-Length，实际传输也受容量上限限制。
- 系统 DNS 全部返回代理使用的 `198.18.0.0/15` 虚拟地址时，自动经固定的 `1.1.1.1` TLS 连接使用 [Cloudflare 公共 DNS 查询](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) 取得真实 A/AAAA 记录，再检查并固定公网地址。该过程不会连接虚拟地址，也不会放行解析出的私网地址；直接输入特殊 IP 仍被拒绝。
- 私有签名 URL 的查询串不会持久化到素材索引或回执；来源保留协议、域名与路径。需要自定义认证头或本机私有地址的素材由客户端先下载，再上传字节。
- 缓存位于 `.cache/asset-transfers/<uploadId>/`；分块写入后持久化确认偏移。进程退出后仅回收可证明失效的内部传输锁。完整发布使用确定的目标文件名、素材索引检查和持久回执，重试不会重复登记。发生外部文件冲突会保留现场，不覆盖外部修改。

底层网络接口依据 [Node.js HTTPS](https://nodejs.org/api/https.html#httpsrequesturl-options-callback) 与 [地址过滤](https://nodejs.org/api/net.html#class-netblocklist)；实现与验证记录见 [本轮记录](../records/2026-09-28-asset-transfer.md)。
