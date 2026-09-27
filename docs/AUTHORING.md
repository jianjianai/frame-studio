# 工程接入与接口说明

目录和修改规则见 [新增工程规范](NEW-PROJECT-STANDARD.md)。本页仅解释代码接入，不约束动画内容、制作方法、交付或声音质量。

## 1. 新建与目录

```powershell
pnpm animation:new example-project "示例工程" --renderer pixi
pnpm project:check example-project
```

脚手架生成：

```text
src/projects/example-project/project.ts
src/projects/example-project/scene.ts
public/films/example-project/poster.svg
production/example-project/README.md
tests/e2e/example-project.spec.ts
```

项目目录在全部依赖准备后才发布到自动发现范围。遇到已存在的文件拒绝覆盖；同一 id 并发创建只有一个成功。临时锁在 `.cache/new-project-locks/`，崩溃后的残留锁先确认没有活动创建任务，再人工处理。

`project.ts` 是静态元数据对象和 `load: () => import('./scene')`。`id`、目录与路由一致；字段类型见 `src/engine/types.ts`。脚手架的字段默认值是初始化值，不是创作阶段规则。

生产构建新增工程后重新运行 `pnpm build`。公共列表和路由自动发现工程，不需要修改 App 或播放器。

## 2. 场景接口

```typescript
import type { Scene, SceneOptions } from "../../engine/types";

export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  let disposed = false;
  return {
    canvas,
    render(time) {
      if (disposed) return;
      ctx.clearRect(0, 0, width, height);
      // 根据绝对 time 求值并绘制。本例只展示接口结构。
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
```

公共 FrameRenderer 将场景画布复制到统一输出画布，再按选项绘制字幕。播放器、截图、录制与离线渲染共用此接口，场景不依赖 DOM 文案被自动捕获。

同一时间点能直接重绘，`A → B → A` 不留下历史状态。不要独立启动 `requestAnimationFrame`、库 ticker 或音频定时器。使用 GSAP 时建立暂停的 timeline，由 `timeline.seek(time,true)` 求值；Three 骨骼按绝对时间求值；其他实现只需满足接口，不限定算法或库。

随机数据可使用 `engine/math.ts` 的 `seeded()`；释放时清理本实例创建的事件、timeline、WebGL、几何体、材质与纹理，不误删共享缓存。异步初始化失败也需要回收已创建资源。

## 3. 资源和可选音频字段

`assetUrl('films/example-project/image.webp')` 访问 public 下的文件。资源必须真实存在，不引用另一工程私有源码，不硬编码个人磁盘路径或运行时 CDN。

```typescript
import { assetUrl } from "../../engine/types";
import {
  loadGltf,
  disposeObject,
  setAnimationTime,
} from "../../engine/three-assets";
// const image = await Assets.load(assetUrl('films/example-project/image.webp'));
// const model = await loadGltf('films/example-project/model.glb', renderer);
```

模型加载工具支持项目已接入的解码器；导入工具当前要求自包含模型以避免外部依赖丢失。第三方源文件和许可证记录放在 `production/<id>/`，浏览器所需文件放在 `public/films/<id>/`。

`project.audio` 是可选路径。当前 AudioTransport 解码该资源，并与公共播放时间同步；没有音频字段也可以运行。它是当前接口能力，不规定使用哪种音乐或制作流程。扩展接口时同步维护类型、加载、暂停、定位、释放及相关测试。

`project.subtitles` 是可为空的时间区间数组。单条开始包含、结束不包含；不能重叠或超出 duration，顺序应递增。统一字幕合成器负责输出，SRT 工具负责序列化。

## 4. 命令的读写范围

```powershell
pnpm project:check example-project       # 只读检查
pnpm project:check example-project --strict
pnpm assets:import "D:/assets/model.glb" --license "来源与许可记录"
pnpm posters --project example-project  # 更新该工程封面
pnpm posters --all                      # 明确更新全部封面
pnpm render example-project --start 5 --end 10 --width 1280 --fps 30
```

后两类命令会产生文件；输出、覆盖开关及外部工具要求见 README 和脚本帮助。工程专用脚本在 `scripts/projects/<id>/`，在 `production/<id>/README.md` 写明输入输出和执行方法。诊断脚本不要附带写入行为；生成命令仅写明确目标。

`pnpm assets` 是已有全局重建命令，可能更新公共插画、解码器和索引，不是单工程操作；新增工程不顺手执行。它不会重新生成三个已有 Demo 的音乐文件。

## 5. 测试与调试

```powershell
$env:FRAME_TEST_PORT="4181"
pnpm verify
```

端口选择当前未占用的端口。测试默认不复用未知服务；并行任务采用独立 worktree 和构建目录，不能同时写一个 dist。完整验证包括工程检查、类型、单元、构建与浏览器测试。只修改文档时也检查引用有效性。

脚手架附带直接定位与反向定位测试；按修改内容补充接口、资源释放、异常路径与写入边界回归。通用列表测试基于元数据计算预期数量，不依赖固定工程数。

开发页提供 `window.__FRAME_STUDIO__`；生产播放器需带 `?debug=1`，离线渲染入口始终提供此接口：

```text
/?render=example-project&width=1280&time=5&subtitles=1
```

等待 `ready` 后调用 `frame(seconds, subtitles)`、`dataURL()`。该渲染入口不播放音频，离线编码器处理音频资源；这是工具行为，不是交付要求。
