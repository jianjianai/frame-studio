# 本次音频与预览模式 UI 审查、修复与验证

## 范围与状态

- 审查基线：8.1.1 / `79c603f286c4668d8c074adc4285fa454c5239de`。
- 范围：素材模式、完整缓存进度与错误恢复、采样片段和 pitch/stretch、音频效果编辑、麦克风授权、窄屏、键盘与相关重复计算。
- 本记录对应后续版本的主开发源码；没有修改已发布 8.1.1 tag、镜像、发布归档或生产作品，没有执行提交或生产操作。
- 麦克风父页授权、拒绝、撤销与当前 iframe 生命周期复审未发现本轮新增问题；现有物理生产麦克风与 Windows native runtime 接受范围没有扩大。

## 发现与处理

| 问题 | 原有实际证据 | 修复 |
| --- | --- | --- |
| 数值输入提前转换、夹紧 | 键盘输入 `-7` 保存为 `7`，`.5` 保存为 `0.055` | 复用 `NumberInput`，保留文本 draft，失焦/Enter 提交；Escape 恢复；上下键有界微调；一次提交一个撤销步骤 |
| Tone JSON 草稿被快捷调整覆盖 | 未应用的 `decay:12` 被 wet 快捷调整重置 | 单一 draft/base 状态，独立字段三方合并；嵌套对象逐字段，数组整体；冲突路径和明确保留选项 |
| 已知 Tone 非法参数保存成功后才播放失败 | `Reverb decay:-1` 原 schema 接受，实际构造报 RangeError | `tone-effect-options.mjs` 集中快捷元数据与已确认官方约束；编辑器、混音文档复用；保留官方时间/频率表达式和其他选项 |
| Signalsmith 预设被手动窗口覆盖但 UI 不提示 | `blockMs:500` 后切 cheaper 仍保留覆盖值 | 明确“手动窗口与间隔”；切回质量预设清零窗口/间隔，保留音色参数；间隔不能大于窗口 |
| 部分控件看似能编辑却被 change guard 丢弃 | 片段轨道/音源、循环、效果启用/排序/删除等缺少 disabled | 所有对应原生与复用控件明确 `disabled`，保持现有视觉布局 |
| 自定义片段按钮不支持空格 | Enter 可选中，Space 不选中 | Enter/Space 均选中并阻止空格滚动 |
| 播放头反复计算静态文档/波形 | 约 15Hz position 更新反复 stringify 文档、逐轨 filter、每片段生成 96 点 | memo 文档 dirty、音源/轨道索引、波形组件；播放头继续正常更新 |
| 已完整缓存的 Pixi 素材不能初始化 | 生产 paper-wings 60/60 文件后 `Assets.load` 返回 null，Sprite 报 texture 错误 | 素材保留文件扩展名与语义 URL；字节消费入口映射 Blob；原生媒体、CSS、FontFace、SVG href 与 Worker/Worklet 统一缓存处理 |
| 缓存错误标题误导 | 素材全部成功但场景初始化失败显示“缓存未完成”/“继续缓存” | 显示“素材已缓存，播放器准备失败”与“重试准备播放”；下载失败继续使用缓存未完成；初始化失败保持 error，绝不伪装 ready |

Tone 快捷范围与官方约束分开：Reverb 的 30 秒、Phaser 的 24 级是控件建议范围，JSON 不据此限制官方允许值；BitCrusher 小数位深仍允许，Chebyshev 仅按官方要求限制 order 整数。未知或复杂表达式的完整解释仍交给 Tone，运行时错误保留诊断。

## 缓存兼容实现与回归边界

1. Pixi 会去掉 URL 的 query/hash 再检查扩展名；给 Blob 加 `#texture.png` 无法修复，已用真实 `Assets.load` 复现并排除。
2. 原始 URL 的 query/hash 保留；无 query 的已知素材补 manifest 版本，使 SDK 自身缓存会随素材 SHA 更新。JS 模块导入保留既有 URL/importmap 单例策略；曾观察到给 JS 导入新增 query 会产生重复 mediabunny 类并触发 `videoTrack must be an InputVideoTrack`，已修正且真实热更新回归通过。
3. 动态 Blob Worker 使用已有 bootstrap；original 首播创建的 Worker pool 在切 cached 时接收新映射。SDK 控制消息隔离；Request/Range 保留；终止和缓存释放回收自有 bootstrap URL/Worker。
4. 原生 FontFace、动态 CSS、图片/媒体、SVG image/use href/baseVal 消费缓存 Blob；SVG fragment 保留；图片 URL 本身仍有扩展名。
5. Chromium opaque iframe 的原生模块 Blob Worker 在独立诊断中也失败；正式 opaque 回归使用 Pixi 实际 classic Worker，模块 Worker 的缓存/队列/Range 在可信独立预览验证。没有增加生产 iframe 同源权限。

## 验证

使用独立临时目录、Vite 随机端口和测试浏览器，没有运行数据库套件或生产请求；每个 fixture 清理自己的浏览器、服务与目录。

- `tests/unit/editor-drafts.test.ts`：5/5，通过数值草稿、三方合并、删除/数组冲突、预设与共享 Tone schema。
- `tests/unit/preview-cache-presentation.test.ts`：1/1，通过完整字节与失败/取消的播放准备区分。
- `tests/mcp/audio-editor-controls.test.mjs`：真实组件通过 signed/fractional 输入、Escape/箭头、单步撤销、预设清除、JSON 独立合并与冲突、非法 Reverb、disabled、Space/Enter、320/390/768 窄屏；20 次位置更新无新增波形读数。真实构造全部 18 个 Tone 效果默认配置，并验证非法 Reverb、合法 fractional BitCrusher 与负向 FrequencyShifter。
- `tests/server/pixi-preview-cache.test.mjs`：真实 Pixi 已有 Worker pool、主线程 ImageBitmap、HTMLImage 输出 8×8 红色像素；新 SHA 后绿色像素且旧纹理有效；原 query/hash、SVG 红色像素、动态 CSS、字体、WASM、Worker Range 206；缓存阶段 HTTP 请求 0。
- `tests/server/preview-cache-browser.test.mjs`：既有 opaque 持久缓存、Range、音频、图像、WASM、Worker/Worklet、字体、热更新、清理回归保持通过。
- `tests/server/v8-live-preview-browser-cache.test.mjs`：真实 Live Player 三模式、播放中切 cached、离线视频/音频/Worker、热更新、取消、重试保持通过；新增全部素材下载后场景失败的真实标题、重试按钮与错误诊断断言。
- `pnpm typecheck` 与 `pnpm typecheck:platform`：最后原生 SVG 补丁后再次全部通过。

最终同一组合复核成功（remote session `session-914d5864bb0efbd0da7a1ca2`，exit 0）：两套 TypeScript、6 个单元断言、4 个实际浏览器目标，全部无失败、无跳过。浏览器组合耗时 26.66 秒，其中真实组件 4.18 秒、Pixi 2.69 秒、opaque 完整缓存 3.25 秒、真实 Live Player 13.38 秒。`git diff --check` 通过。

发布镜像完整门禁与生产全部作品三模式验收由发布代理执行；这些目标成功不等于后续版本上线验收，8.1.1 的正式制品和生产源码保持不变。

## 不扩大范围的事项

- 已完成文件按 SHA 复用；取消中尚未完成的大文件仍在下次重新下载，字节级断点续传为后续独立改进决策。
- 未重设计视觉主题，未修改作品、聊天/Paseo UI、TLS、域名或不相关导出/设置功能。


## 候选完整门禁发现的数值草稿交互回归（2026-10-02）

### 根因与修复

8.2.0 候选源码 `43976f249865a0f1a3880687d7b20e66deebf52f` 的真实 API 浏览器测试发现：输入时长 1 秒后直接拖动，开始位置仍为 0。初始测试作品仅 2 秒，默认片段占满作品；拖动的 preventDefault 阻止输入失焦，未提交的 1 秒草稿没有进入权威文档，旧 2 秒片段被边界约束锁在 0。已用 Node 24 / NODE_ENV=production 与独立测试数据库精确复现原断言失败（session `session-dbfe7bb763122d6086fb69c3`，exit 1）。

进一步复审发现：仅有数值草稿时保存按钮尚未启用，直接点击保存无法完成提交。最终修复覆盖真实操作，不要求用户先按 Tab：

- `NumericDraftProvider` 复用字段实例 token 与稳定回调，各字段保留自己的文本；仅聚合 dirty 布尔值翻转时更新编辑器。未提交数值纳入“未保存”、保存按钮、刷新/放弃与离开页面保护；浏览器持久草稿仍只保存有效权威文档，不存中间负号或小数点字符串。
- 保存与拖动共用 `flushNumericPending`，先提交焦点数字，再查找无效字段并展开所在高级设置、定位错误；后续读取 `current.current` 的最新文档和片段。无效草稿阻止开始操作，未应用的高级 JSON 不会自动进入混音。
- 数字提交与随后拖动各占一个撤销步骤；无位移点击不产生步骤；pointercancel 恢复拖动开始时的文档，不丢失之前的数字提交、不添加拖动历史。相同数值的不同文字表示不提交新修订。
- 明确放弃/重新加载时重置字段草稿与错误；保存繁忙、外部禁用等既有约束保持有效。

### 最终目标验证

以下是本次补丁的独立目标结果，不合并计入前一批测试：

| 验证 | 结果与证据 |
| --- | --- |
| 真实组件 `tests/mcp/audio-editor-controls.test.mjs` | 1/1 PASS，0 skip；session `session-0db5d4ecfe8453515a106448`，exit 0，案例 5.45 秒 |
| 真实 API `tests/server/audio-browser.test.mjs` | 保留时长 fill 后直接 mouse drag，以及 gain fill 后直接保存；补两步撤销/重做，完整迁移、多轨、处理器、冲突、草稿恢复与窄屏断言通过；session `session-2f5b94bdeb112a0d54edcb38`，exit 0，1/1 PASS，0 skip，案例 9.59 秒、进程 54.58 秒 |
| TypeScript 与新工作台构建 | `pnpm typecheck && pnpm typecheck:platform && pnpm build:studio` 全部 exit 0；session `session-71278ca90bfa9b3bcefbf8dd` |

组件新增断言实际覆盖：有效草稿直接拖动、无效草稿拒绝拖动、取消与无操作历史、数值草稿启用保存/未保存/刷新与 unload 保护、鼠标直接保存、无效保存不写版本且保留焦点、Escape 恢复、等值文本零新版本、显式放弃重置、高级 JSON 保存后仍未应用。连续三次修改已 dirty 的数字字段，父级工具栏渲染计数不增加；既有波形复用、全部 18 个 Tone 效果真实构造与窄屏断言继续通过。

API 目标使用自动创建与 finally 删除的独立 `frame_test_audio_drag_<uuid>` PostgreSQL 数据库、独立端口 59493 与 Node 24 开发容器，未使用共享测试数据库。服务读取 `studio-dist`，因此先用当前源码重新构建后才运行最终 API 目标；曾有一次仍读旧构建的失败，明确不计作新源码结果。早期加入 gain Tab 的拖动专项成功仅是中间诊断，最终直接保存断言已恢复，没有降低门槛或添加 skip。

本轮公共修改仅为 `studio/audio-editor.jsx`、`studio/editor-inputs.jsx`、两项对应浏览器测试、`docs/AUDIO-CREATIVE.md` 与本记录。候选固定归档、已发布 tag/镜像、生产作品与清理授权均未修改；后续版本需要新候选完整门禁与生产验收。
