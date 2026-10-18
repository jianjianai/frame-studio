# blender：用户电脑上的 Blender

用户电脑上的 Blender 装了 [AB to T](https://github.com/xie-hou/abt) 插件（0.6.0 起）并连着这个作品库时，你可以在那里打开作品的三维镜头、执行 Python、看画面。镜头是 abt-scene 技能做的 `abt/<镜头>.json`（作品里的 three 场景图层，做法见那个技能）。用户在 Blender 里一个参数一个参数地手调，改动实时写回作品里的 JSON，FRAME 的预览跟着刷新。

## 工具

| 要做的事 | 工具 |
|---|---|
| 看 Blender 连没连着、开着哪个镜头、有没有写回冲突 | `blender_status` |
| 在 Blender 里打开镜头 | `blender_open`：`shot` 写 `abt/<镜头>.json`。第一次导入成 Blender 场景，以后打开上次的 .blend（用户的手调都在），并开启实时同步 |
| 改镜头 | `blender_run`：执行 Python，可以直接用 `bpy` 和 `abt`（插件的 core：`set_param`、`get_param`、`set_rotation`、`get_rotation`…），`print` 出来的就是结果 |
| 看画面 | `blender_view`：`camera` 相机视角的视口预览（快）、`render` 用场景的渲染引擎正式渲染一帧（EEVEE 或 Cycles，几秒到几分钟）、`window` 截 Blender 整个窗口。`frame` 选帧 |

## 规则

- **导入以后以 Blender 为准**：改这个镜头用 `blender_run`，不要再直接改 JSON。直接改的话，Blender 下次写回时会发现作品里的版本变了，写回被拒，要用户在 Blender 里选用哪一边。
- `blender_open` 的 `reimport` 用作品里现在的 JSON 重新导入，会冲掉 Blender 里没写进 JSON 的调整（灯光细节、规范之外的设置），先问用户。
- 代码在用户的电脑上运行：只做和镜头有关的事，不读写镜头以外的文件、不联网、不启动其他程序。每次执行记一步撤销，用户可以 Ctrl+Z。
- 省 token：只查、只打印要改的对象；用户没要求时少截图，检查效果取少量帧。FRAME 里的 three.js 画面照常用 `preview_frames` 看。

## 没连着的时候

`blender_status` 会说原因，转告用户：

- 这个作品库还没连接过 Blender：请用户打开「Blender」选项卡（「素材」视图顶部的立方体按钮），按步骤装插件、复制连接码，在 Blender 的 AB to T 侧边栏点「连接 FRAME…」粘贴。
- 连接过但现在不在线：请用户打开 Blender，确认 AB to T 面板里「连接 FRAME」是开着的。

用户自己也能在「Blender」选项卡或资源管理器（右键镜头文件 →「在 Blender 里打开」）里打开镜头。.blend 只在用户的电脑上，作品里保存的是镜头 JSON。
