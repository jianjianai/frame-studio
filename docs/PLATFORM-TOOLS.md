# 平台 MCP 与 CLI：真实作品工作流

本地目录工程使用 `pnpm film`；远程 Frame Studio 平台使用 `pnpm platform` 或 `pnpm film platform`。两种运行环境不要混用标识：平台 `id` 是作品 UUID，不是 `projects/` 下的目录名。平台 MCP、HTTP 和 CLI 共用操作注册表、参数校验与错误约定。

## 先发现能力，不猜工具名

MCP 从 `frame_help` 开始。它支持 `query` 搜索、`offset/limit` 分页、`name` 查询单个工具的精确 JSON Schema，并提供创建、编辑、预览和导出顺序。`frame_works_context` 的 `sections` 可选 `metadata/readme/authoring/assets/tasks`；默认仍返回完整上下文，日常只取 `metadata/readme` 可以明显减少重复内容。

```sh
pnpm --silent platform help
pnpm --silent platform doctor
pnpm --silent platform actions patch
pnpm --silent platform describe works_patch
pnpm --silent platform frame_help '{"query":"edit"}'
pnpm --silent platform works_page '{"limit":20,"offset":0}'
```

命令需要 `FRAME_URL` 与 `FRAME_TOKEN`，也可用 `--token-file <私有文件>`。不要把令牌直接写入命令行参数、源文件或项目记录。远端默认要求 HTTPS；本机回环 HTTP 可直接使用，可信测试内网需要显式 `--allow-http`。HTTP 重定向不会携带凭据跟随，写操作不会被客户端自动重试。

`GET /api/actions` 保留原有操作列表，同时支持 `search`、`name`、`schema=1`。旧服务可能不返回 Schema，`describe` 会明确提示，而不是假装成功。已连接客户端的工具参数表可能仍有缓存；升级服务后应重新发现工具，不能仅凭客户端旧参数表推断当前源码能力。

MCP 保留原有文本结果，并为普通结果补充 `structuredContent`；数组在结构化结果中包装为 `{items: [...]}`，文本结果仍维持旧格式。失败同时携带 `isError` 与结构化错误码。工具标注采用保守的读写、破坏性、幂等与外部访问提示；这些提示不是权限边界。

## 源码阅读与安全编辑

| 操作               | 用途                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `works_files_page` | 稳定排序的文件分页；跟随 `nextOffset`，直到 `null`。                   |
| `works_read_lines` | 按行读取 UTF-8；`sha256` 始终覆盖整个原文件。                          |
| `works_search`     | 项目内字面量查找，返回路径、行号、完整文件哈希；截断时缩小目录或查询。 |
| `works_patch`      | 精确字符串替换，要求哈希新鲜且匹配次数准确；避免重传整个场景。         |
| `works_edit`       | 同一事务创建、替换或删除 1–20 个相关文件。                             |

新建文件使用 `expectedSha256: null`；删除使用 `content: null` 并提供当前哈希。补丁形状示例：

```json
{
  "id": "<作品 UUID>",
  "changes": [
    {
      "path": "scene.ts",
      "expectedSha256": "<完整文件的 64 位 SHA-256>",
      "replacements": [
        { "find": "old phrase", "replace": "new phrase", "count": 1 }
      ]
    }
  ],
  "dryRun": false
}
```

```sh
pnpm --silent platform works_patch @patch.json
pnpm --silent platform works_edit - < edits.json
pnpm --silent platform read <作品UUID> scene.ts --line 1 --lines 100
pnpm --silent platform write <作品UUID> scene.ts --file scene.ts --expected <当前SHA256>
pnpm --silent platform write <作品UUID> production/note.md --file note.md --new
```

`dryRun: true` 检查提案、路径、哈希与大小，不写文件、不创建检查点，也不运行编译或完整结构校验。真正应用时先保留本地检查点，执行与本地工具共用的编辑事务；结构校验失败会回滚整批文件。平台另外使用数据库作品锁，不能在运行任务期间修改该作品。其他作品不受影响。

源码文件上限为 **1 MiB UTF-8 字节**，批量编辑上限 20 个文件、2 MiB 新内容；请求还受 2 MiB JSON 包体限制。行切片减少响应量，但不会放宽单文件上限。支持 `.srt/.vtt` 等文本字幕；二进制文件、非法 UTF-8、NUL、目录和越界路径会明确拒绝。大体积媒体使用素材上传，不要塞进源码编辑接口。

`works_write` 保持兼容，也可用于逐个写入搭建初稿；需要跨文件一致性时优先使用批量事务。结构检查通过不等于类型、运行、视听质量通过，下一步仍应验证、渲染和查看。

## 任务等待、恢复与浏览器预览

```sh
pnpm --silent platform works_task @validate.json --wait
pnpm --silent platform wait <任务UUID> --timeout 900 --poll 1
pnpm --silent platform works_browser @work.json --wait
```

`validate.json` 示例：`{"id":"<作品UUID>","kind":"validate"}`；`work.json` 示例：`{"id":"<作品UUID>"}`。帧、分镜、渲染的完整输入以 `describe works_task` 为准。创建作品还支持 `fps`、`audio: silent|generated` 与构图尺寸。

客户端会读取递增事件游标，排空事件分页后再返回最终任务。浏览器入口可能先等待已有验证任务，再等待构建；`--wait` 会继续请求直到拿到 `state: ready`，不会重复设置 `rebuild: true`。

**客户端 Ctrl-C 或超时不取消服务端任务。** 保留返回的任务 ID，用 `wait` 恢复；确实要停止时显式调用 `task_cancel`。失败、取消、发布失败不会输出成功结果。发布失败应检查 `task_get`，使用 `task_retry_publish` 恢复保存过程，不要重复执行创作任务。

浏览器打开 `works_browser` 返回的临时私有地址后，可使用：

```js
await FRAME_AI.ready();
FRAME_AI.help();
await FRAME_AI.frame({ time: 3, width: 640 });
await FRAME_AI.play({ start: 2, end: 5, rate: 1 });
FRAME_AI.pause();
const { id } = FRAME_AI.exportVideo({ start: 2, end: 4, width: 640, fps: 30 });
FRAME_AI.exportStatus(id);
FRAME_AI.download(id); // 完成后下载
FRAME_AI.release(id); // 释放 Blob URL
```

浏览器视频导出期间必须保持页面打开；服务端任务是持久执行，二者生命周期不同。第一次播放可能需要真实点击来允许音频。不要把临时预览 URL 写进公开报告。

## 媒体上传与明确下载

```sh
pnpm --silent platform upload cue.wav --repo <仓库UUID> --license "原创" --mime audio/wav
pnpm --silent platform upload cue.wav --repo <仓库UUID> --license "原创" --resume <上传UUID>
pnpm --silent platform upload_status '{"id":"<上传UUID>"}'
pnpm --silent platform upload_abort '{"id":"<上传UUID>"}'
pnpm --silent platform download <任务UUID> projects/<目录名>/exports/<文件名> --out ./film.mp4
```

上传流式计算 SHA-256，按服务端偏移分块传输；中断错误包含上传 ID 和最后确认偏移。恢复前再次核对仓库、大小和源文件哈希，不会把另一份文件拼进已有上传。素材许可证必填，不能以空字符串绕过。`upload_abort` 只删除未完成上传的临时字节，已经注册的素材必须使用素材生命周期操作处理。

下载路径必须来自该成功任务的 `result.artifacts`。下载使用临时文件流式写入，校验大小以及服务端提供的 SHA-256，完成后原子落盘；默认拒绝覆盖，`--force` 才可替换普通文件。失败会清理本次临时文件，原有目标不被改动。旧服务没有产物 SHA-256 时，结果会明确 `checksumVerified: false`；客户端计算出的本地哈希不冒充服务端校验。

## 脚本输出约定与回归工程

除纯文本帮助外，stdout 为单个 JSON；进度和错误是 stderr 上的 JSON 行。退出码：成功 0、一般失败 1、超时 124、中断 130。使用 `pnpm --silent` 可避免包管理器提示混入 stdout。参数支持 JSON 字符串、`@file` 和标准输入 `-`；未知参数、额外位置参数、非对象 JSON 都会拒绝。

真实视频夹具位于 `tests/fixtures/toolchain-film/`，包含 24 秒连续动画、双轨原创音乐、中文字幕、可复现创建脚本以及浏览器/媒体验收脚本。详细命令见该目录 README。它只在独立的忽略项目目录产生影片与报告，不把用户作品或导出写入平台源码仓库。
