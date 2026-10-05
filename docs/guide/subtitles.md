# subtitles：字幕与镜头标记

字幕保存在 `project.ts` 的 `subtitles`，由播放器绘制在画面底部，导出时可选择烧录。用户也会在时间轴上编辑它们。

## subtitles_edit

```json
{ "add": [{ "start": 1, "end": 3.2, "text": "欢迎了解我们的新产品" }] }
```

- `add`：追加字幕；与新字幕时间重叠的旧字幕会被替换，所以改一句时直接 `add` 新的即可。
- `set`：整体替换全部字幕（`[]` 清空）。
- `removeBetween: { start, end }`：删除与这段时间重叠的字幕。
- 三者可以同时使用，执行顺序：set → removeBetween → add。返回排好序的全部字幕。
- `end` 必须大于 `start`，且不能超过作品时长。

配音时用 `speech_synthesize` 的 `subtitles: true` 自动生成对应时间的字幕（见 `speech`）。

## 字幕写法

- 一条字幕一句话，中文每行不超过约 16 字；长句拆成多条。
- 每条至少显示 1 秒左右，跟随配音的实际时间。
- 字幕已经由播放器绘制，不要在场景里再画一遍同样的文字。

## 镜头标记 beats

`work_update` 的 `beats` 是时间轴上的镜头标记（整体替换），用来和用户指代片段：

```json
{ "beats": [{ "at": 0, "title": "开场", "detail": "标题从下方升起" }, { "at": 4, "title": "产品特写", "detail": "" }] }
```
