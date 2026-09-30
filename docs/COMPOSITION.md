# V6 混合合成接口

本页说明工程结构、可用能力和运行契约，不限定题材、风格或制作方法。

## 项目入口

`pnpm film new my-film "标题"` 默认创建空白合成（renderer: composition），没有预选 2D/3D 引擎，没有预填镜头或动效；composition 表示基础容器，不是绘制框架选型。显式 `--renderer` 可创建 Canvas、PixiJS、Three.js、Babylon.js 或 Remotion 示例。`pnpm --silent film capabilities --json` 查询完整能力目录，支持 `--category visual|media|animation|audio`、`--query <关键词>` 和 `--id <能力 id>`；分类值每次传入一个，不在 shell 中使用管道符。完整接入说明见 [CAPABILITIES.md](CAPABILITIES.md)。旧 `film composition engines --json` 保留为渲染器目录，不包含全部动画和音频能力。

`project.ts` 保持静态元数据，`composition: {width,height}` 仍仅表示画幅。`loadVisual: () => import('./visual.json')` 声明可编辑合成；`load: () => import('./scene')` 加载场景。旧程序化作品无需迁移。

默认 scene.ts 调用 `createCompositionScene(options, visual, loaders)`。loaders 是项目内模块表，例如：

```ts
return createCompositionScene(options, visual, {
  product: () => import('./scenes/product'),
  labels: () => import('./scenes/labels'),
});
```

每个模块导出 createScene。可以继续自由编写程序化场景，也可以将其他合成模块作为一个场景嵌套；内部对象、深度与灯光属于各自场景，不自动跨引擎共享。以下示例中的 product 是嵌套的 `createCompositionScene` 模块，因此其实际 engine 为 composition；其他模块填写各自真实的 engine，不能用虚构的通用引擎值替代。

## 权威片段数据

```json
{
  "schemaVersion": 1,
  "background": "transparent",
  "clips": [
    {
      "id": "footage",
      "source": {"kind": "video", "src": "films/my-film/imports/clip.webm"},
      "start": 0, "duration": 5, "offset": 1, "rate": 1,
      "fit": "cover",
      "audio": {"enabled": true, "gain": 0.8}
    },
    {
      "id": "product",
      "source": {"kind": "scene", "engine": "composition", "module": "product"},
      "start": 0, "duration": 5,
      "transform": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.8}
    }
  ]
}
```

片段数组从底到顶合成，id 唯一且稳定。start/duration 为影片秒数，结束点不包含；offset 为素材入点，rate 为正向速度（0.05–16），loop 可声明素材循环长度。phase 为分割产生的素材相位，通常由编辑操作维护：

`素材时间 = offset + ((影片时间-start) × rate + phase)`，设置 loop 后对括号内结果取模。

| source.kind | 字段与能力 |
|---|---|
| image | src；透明图片、SVG、自动方向解码 |
| video | src；按时间读取解码帧，失败明确报错；原声显式启用 |
| sequence | frames: 素材 URL 数组，fps；按时间选择单张图片 |
| lottie | src；Canvas 运行时，绝对时间定位，图片需内嵌 |
| scene | module、engine、可选 parameters；项目内可输出 CanvasImageSource 的兼容场景模块 |
| color | color: #RRGGBB 或 #RRGGBBAA |

Remotion 的 React/DOM 输出不能直接作为上述 Canvas 合成图层。混用时，以 Remotion 组件为根，通过 `FrameScene` 嵌入 Canvas/PixiJS/Three.js/Babylon.js/Lottie 或嵌套 composition；Remotion 子组件直接在 React 内组合。两种根入口都支持预览与导出，但截图与浏览器编码边界不同，见 [REMOTION.md](REMOTION.md)。这属于输出类型契约，不是框架优先级。

transform 的 x/y/width/height 为画幅比例，rotation 为度，opacity 为透明度。各字段可为数值或递增的关键帧数组：`[{at:0,value:0,easing:"smooth"},{at:2,value:1}]`。at 使用素材秒数；插值支持 linear/smooth/hold。分割不会重置关键帧或素材循环相位。

fit 为 contain/cover/fill；crop 为素材归一化裁切矩形 x/y/width/height。blend 支持 source-over/multiply/screen/overlay/darken/lighten/difference/destination-in/destination-out；后两者作用于已合成的下方画面，可用作遮罩。fadeIn/fadeOut 为影片秒数，重叠图层可产生淡入淡出；分割用 fadeOffset/fadeDuration 保留原过渡。hidden 同时隐藏画面与关联原声。

编辑器可移动、裁切、分割、排序、替换素材、调整变速/循环、变换、裁切、混合、原声和关键帧。复杂场景代码保持独立；可编辑参数由 scene.debug.parameters/setParameters 显式公开，不能反向编辑任意 JavaScript 内部对象。

## 时间、资源与取消

Scene 接口保持 canvas/render/dispose，createScene 和 render 可异步；可选 `prepareFrame(time,{signal})` 在绘制前加载资源。预览、缩略图、截图和两种视频导出共用 FrameRenderer，串行准备并原子提交完整画面；旧请求不能覆盖新帧。传入的 signal 用于取消和超时，适配器须及时响应，dispose 释放本实例资源。

Three/Pixi/Babylon 适配器由公共时钟驱动，没有独立播放循环。程序场景负责从绝对时间重建自身状态。需要历史状态的模拟可以在模块内实现固定步长、预滚动或检查点。

素材服务 `openVideoSource(src,width,signal)` 返回 duration、frame(time,signal)、dispose；frame.image 可用于合成或由场景更新视频纹理（例如 Three CanvasTexture）。每个活跃视频有有界输入缓存和两个复用解码画布；非活跃片段立即释放。合成最多 128 个片段、同时 32 个活跃片段，并检查 512 MiB 基础画布预算；场景内部 GPU 资源仍由场景管理，预算不是浏览器总内存保证。第一版输出为 SDR/sRGB。

浏览器解码能力取决于实际编码器和运行环境。CLI `film media <id> probe --src films/<id>/video.webm` 探测尺寸、时长、编码和原声；浏览器首次加载检查实际解码能力。不支持的编码可用 `film media <id> transcode --src ... --out public/imports/compatible.webm` 生成独立 VP9/Opus 副本，原始文件和已有目标均不覆盖。

## GUI、CLI、MCP

三者使用同一操作协议：add/update/remove/reorder/split/replace。先读取文档与 sha256，编辑请求必须携带 expectedSha256；写入前重新检查，冲突不覆盖。保存复用原子项目写入、操作锁、预览失效和版本记录。

```sh
pnpm film composition my-film --json
pnpm film composition my-film edit --input request.json --json
pnpm film composition my-film edit --input request.json --dry-run --json
```

```json
{
  "expectedSha256": "<读取所得 sha256>",
  "operations": [
    {"op":"update","id":"footage","patch":{"start":2,"duration":3}},
    {"op":"split","id":"footage","at":3,"newId":"footage_right"}
  ]
}
```

update 替换所给顶层字段；可选 unset 数组显式清除 loop/crop/transform 等字段（例如关闭循环），随后重新应用字段默认值；修改 transform/source 时先读取并保留未修改子字段。CLI 输入为 - 时读取 stdin。replace 用于整文档变更及撤销，同样检查版本。

完整能力发现使用本地/平台 MCP `frame_capabilities`，与 CLI `film capabilities` 共用目录；按 category/query/id 筛选后再读取对应参考文档。本地 MCP：frame_renderers、frame_composition、frame_composition_edit、frame_media_probe、frame_media_transcode。平台 GUI/API/远程 MCP：works_composition、works_composition_edit、works_media_probe；平台通用文件写入和版本恢复仍可用。平台媒体上传支持自包含 Lottie JSON，图像序列由项目内图片数组定义。

预览关联原声与导出音频使用同一素材时间映射；browser WebM 与 CLI MP4 使用同一合成和离线音频逻辑，编码不同不保证压缩字节一致。浏览器导出可取消；缺素材、越界素材时间、解码或适配器失败均使请求失败。
