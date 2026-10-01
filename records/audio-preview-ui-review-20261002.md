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
