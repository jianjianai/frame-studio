# 远程 MCP 与 CLI 创作工具

远程工作台以作品 UUID 为 `id`，不是本地的工程名称或 Git 分支名。`scene.ts`、`production/brief.md` 等路径相对于该作品目录。网页、远程 HTTP、MCP 和 `platform` CLI 共用业务操作；本地 `pnpm film` / stdio MCP 使用本地工程 slug，不能直接混用参数。

## 从哪里开始

MCP 先调用 `frame_workspace_context`，得到仓库、作品概览和可继续调用的操作。新建但未打开的作品也会出现在概览里。概览只返回有限条目，完整内容继续使用仓库/作品分页列表。

参数不确定时调用 `frame_tool_describe({name:"works_patch"})`。返回准确的输入 JSON Schema 和副作用提示；名称接受有或没有 `frame_` 前缀的形式。私有管理操作不会因这个发现入口而暴露给 MCP。权限仍由服务端认证和业务检查决定，工具注解不是权限机制。

CLI 使用工作台令牌和地址；凭据放在环境变量，不放进命令行参数或记录文件。以下例子省略环境变量配置，作品 UUID 用占位值表示。

```sh
pnpm --silent platform --help
pnpm --silent platform actions
pnpm --silent platform describe works_patch
pnpm --silent platform workspace_context
pnpm --silent platform works_context '{"id":"作品UUID"}'
```

`--help`、`help`、`-h` 和不带参数均可离线使用，不要求设置 `FRAME_URL` / `FRAME_TOKEN`。`describe` 需要连接服务器，以运行中的操作定义为准。HTTP 客户端也可读取已认证的 `GET /api/actions/<name>`；原有 `/api/actions` 列表格式保持不变。

## 阅读与局部编辑

`works_context` 默认包含作品元数据、README、作品 AGENTS、制作 brief、简短创作接口说明、20 条素材和最多 5 条任务摘要。`taskLimit` 可设 0–20；`detail:true` 展开完整创作参考，但不会重新附带历次构建的文件哈希清单。文本上下文截取会标记 `truncated`，原文件可以继续通过读取工具取得。素材与任务的后续页入口随上下文返回。

| 操作                | 行为                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `works_files_page`  | `directory` 缩小目录；`limit` / `offset` 分页，返回 `nextOffset`、总数和文件可编辑性。旧 `works_files` 数组接口保留。                   |
| `works_read`        | 兼容旧调用，默认返回完整文本；显式传 `startLine` / `lineCount` 可读取局部。返回全文件 SHA-256、`complete`、`totalLines` 和 `nextLine`。 |
| `works_search`      | 按字面文本搜索，不执行正则表达式。结果带路径、行号、全文件 SHA 和片段；将 `nextCursor` 原样传回继续搜索。                               |
| `works_patch`       | 一个文件内按顺序执行精确文本替换，检查 SHA 和匹配数量；全部检查通过才写入。`dryRun:true` 只预演。                                       |
| `works_write`       | 创建或替换完整 UTF-8 文件。`expectedSha256:null` 表示必须不存在，不是忽略冲突。                                                         |
| `works_delete_file` | 持全文件 SHA 删除一个文本源码文件，支持预演。不能删除 `project.ts` 和 `production/work.json`。重要删除前保存版本。                      |

源文件上限为 **1 MiB UTF-8 字节**，不是字符数。显式分页读取的单次正文上限为 128 KiB，文件列表最多扫描 10,000 个文件。搜索每次最多检查 500 个文件、4 MiB，遇到扫描预算或结果数限制时返回续查游标；不能把空的当前页当作整个作品没有匹配。二进制素材使用上传工具，不通过文本读写处理。

**局部读取不能直接作为完整文件写回。** SHA 始终代表完整文件，不能以片段内容计算。推荐读取需要的位置后使用精确补丁：

```json
{
  "id": "作品UUID",
  "path": "scene.ts",
  "expectedSha256": "从 works_read 返回的完整64位SHA256",
  "edits": [
    {
      "oldText": "height * .07",
      "newText": "height * .09",
      "expectedMatches": 1
    }
  ],
  "dryRun": true
}
```

将真实参数保存到 `patch.json`，运行 `pnpm --silent platform works_patch @patch.json`。确认预演结果后改成 `dryRun:false`。某项匹配数量不符或 SHA 过期，会返回冲突且不会应用前面的替换。需要同时修改多个文件时，逐个文件调用，随后统一验证；**本接口不声称具有跨文件事务能力**。

文件哈希按原始字节计算，保留 UTF-8 BOM 和 CRLF。隐藏路径、越界路径、生成输出、依赖目录、符号链接和硬链接不能通过源码接口修改。遇到 `FILE_CHANGED` 先重新读取并协调修改，不自动覆盖；遇到忙碌任务先查询任务状态。缺失文件返回 `FILE_NOT_FOUND`，不会把服务器绝对路径作为恢复提示。

## 任务、预览和结果

远程任务独立持久化。关闭终端、等待超时或中断客户端 **不会取消任务**。需要取消时显式调用 `task_cancel`。

```sh
pnpm --silent platform works_task @frame-task.json --wait --timeout-ms 120000 --events
pnpm --silent platform wait 任务UUID --timeout-ms 120000
pnpm --silent platform works_browser '{"id":"作品UUID"}' --wait
pnpm --silent platform download 任务UUID frame-0.500000.png --out ./review/frame.png
```

`frame-task.json` 是 `{"id":"作品UUID","kind":"frame","input":{"time":0.5,"width":640}}`。可用 `kind` 包括 `validate`、`frame`、`storyboard`、`render`、`build`。创建任务的 `requestKey` 是调用方生成的 UUID，只能为同一个请求重用，用于响应丢失后的去重。

`works_browser --wait` 在需要时等待编译，完成后再次获取当前作品的私有预览 URL；已经就绪时直接返回 URL，不重复构建。`rebuild:true` 只作用于最初请求，后续获取链接不会不断重建。等待期间可能先有其他编辑任务完成，CLI 会继续请求最新预览，直到就绪、失败或超过总等待时间。

MCP 使用 `frame_task_status`。`waitMs` 最多 10 秒；每页最多 100 条事件。默认不带完整构建清单，返回任务摘要、输出路径、下载入口和后续操作建议。把 **`nextAfter` 原样作为字符串** 带入下一次 `after`，避免大事件编号经过浮点数转换后丢失精度。即使 `done:true`，`hasMore:true` 仍表示有最后几页事件未读完。全量诊断仍可通过原 `task_get` 获取；原前端协议没有改名或更改数组形状。

`publish_failed` 意味着结果保存需要恢复，不能当作仍在运行而无限等待。先检查失败原因，再调用 `task_retry_publish`；不要为保存失败重新执行已经完成的 AI 任务。

PNG 在 MCP 中直接作为图像输出，JSON/SRT 作为文本。结构化元数据与原内容一并返回，图像 base64 不重复塞进 JSON。语音试听继续返回音频块并带结构化文件元数据。视频、音频和较大文件用 `platform download`，或对 `downloadPath` 发起同服务器的带认证请求。过期文件返回明确的重建提示。

下载流式写入临时文件，校验字节数并计算 SHA-256，成功后才发布为目标文件。默认不覆盖已有文件；只有 `--force` 才替换普通文件。传输失败不会留下冒充完整文件的目标产物，也不会覆盖先前成品。

## 素材上传与中断恢复

```sh
pnpm --silent platform upload ./music.wav --repo 仓库UUID --license "原创" --mime audio/wav
pnpm --silent platform upload ./music.wav --resume 上传UUID
pnpm --silent platform upload_status '{"id":"上传UUID"}'
pnpm --silent platform upload_abort '{"id":"上传UUID"}'
```

也可用 `FRAME_REPOSITORY`、`FRAME_ASSET_LICENSE` 提供上传默认值。新上传要求来源许可，不能默默填充为“未知”。上传按文件流计算 SHA 并分块发送，不把整份素材读进内存。MCP 仍使用 `upload_begin` / `upload_chunk` / `upload_finish`。

`upload_begin` 接受 `requestKey`：相同键、相同元数据返回同一个上传及当前偏移；相同键但不同请求会冲突。CLI 在发送 begin 前就输出上传 UUID，响应丢失后仍可查询。`upload_status` 给出精确字节偏移和已完成素材，恢复前校验本地字节、文件名及仓库。不得换一个文件复用旧上传 UUID。

重复且完全相同的已写入块可重传；跨越当前文件末尾的重叠块会被拒绝，不能以未写入的零字节冒充成功。分块必须是非空规范 base64。`upload_finish` 的已完成结果可重复查询；`upload_abort` 只清理未完成会话，绝不删除已经登记的素材。已完成素材按素材回收站规则处理。

## 自动化与错误约定

CLI 操作参数可以直接传 JSON、`@file` 或 `-` 从 stdin 读取。stdout 只输出最终 JSON；进度、事件和错误写 stderr。使用 `pnpm --silent` 避免包管理器的脚本横幅混入输出。

| 退出码 | 含义                                                    |
| ------ | ------------------------------------------------------- |
| 0      | 操作成功，或等待到成功结果/就绪预览。                   |
| 1      | 参数、网络、HTTP 或任务失败；包括取消和结果保存待恢复。 |
| 2      | 总等待时间耗尽，远程任务没有因此取消。                  |
| 130    | 客户端收到中断；远程任务/上传保持可查询。               |

`--request-timeout-ms` 控制一次 HTTP 请求，默认 30 秒；`--timeout-ms` 控制整个等待，默认 120 秒。下载较大产物时适当提高请求超时。请求不自动重试写操作，也不跟随重定向把令牌转发到其他地址；`FRAME_URL` 必须是最终 HTTP(S) 基地址，不能嵌入用户名、密码、查询参数或片段。

HTTP/MCP 错误包含 `error`、`status`、`code`、`recovery` 等机器可读信息。CLI 尽量保留恢复字段并移除令牌；不回显代理返回的 HTML 或堆栈。网络失败的写请求可能已经完成，应先查任务/上传/文件状态，而不是直接重做。

## 兼容与验证

旧 `works_files`、`works_tasks`、`task_get`、`/api/actions` 和整文件读取调用保留；新增的分页/精简接口是可选择的替代路径。MCP 原文字 JSON 保留，结构化内容作为补充；数组的结构化外壳为 `{items:[...]}`，文字块仍是原数组。

新操作需要运行包含本次改动的服务端。安装后客户端可能需要刷新 MCP 工具列表，未发布的分支不会改变当前生产连接的可用工具。

回归测试集中在 `tests/server/agent-toolkit.test.mjs`、`agent-toolkit-integration.test.mjs`、`platform-cli.test.mjs`，并纳入 `pnpm verify`。涉及 PostgreSQL 的测试必须使用专用 `frame_test` 数据库；发布执行器的额外门禁见 [VERIFICATION](VERIFICATION.md)。
