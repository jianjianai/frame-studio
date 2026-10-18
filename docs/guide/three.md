# three：Three.js 三维场景

`createThreeScene(options, build)` 创建透明背景的 WebGL 渲染器。`build` 返回场景、相机和 `update(time)`；不要调用 `renderer.setAnimationLoop`。只想把一个模型放进画面，不需要写代码：用模型图层（见 `layers` 的「三维模型图层」）。

```ts
import * as THREE from "three";
import type { SceneOptions } from "@frame/engine/types";
import { createThreeScene } from "@frame/engine/scene-adapters";
import { loadModel, studioEnvironment, frameObject, setAnimationTime } from "@frame/engine/three-assets";
import { smooth, phase } from "@frame/engine/math";

export function createScene(options: SceneOptions) {
  return createThreeScene(options, async (renderer) => {
    renderer.toneMapping = THREE.NeutralToneMapping;
    const scene = new THREE.Scene();
    scene.environment = studioEnvironment(renderer);   // 柔和的摄影棚光，不需要文件
    const camera = new THREE.PerspectiveCamera(35, options.width / options.height, 0.1, 100);

    // 模型：作品 public/ 或素材库里的 GLB/glTF/FBX/OBJ
    const robot = await loadModel("materials/三维/models/robot.glb", renderer);
    scene.add(robot.scene);
    const mixer = new THREE.AnimationMixer(robot.scene);
    mixer.clipAction(robot.animations[0]).play();
    const middle = frameObject(camera, robot.scene, { azimuth: 30, elevation: 10 });   // 取一次景
    const offset = camera.position.clone().sub(middle);

    return {
      scene,
      camera,
      update(t) {
        setAnimationTime(mixer, t);                  // 骨骼动画按绝对时间求值
        // 镜头绕模型慢慢转过 60°
        const turn = THREE.MathUtils.degToRad(60) * smooth(phase(t, 0, 3));
        camera.position.copy(middle).add(offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn));
        camera.lookAt(middle);
      },
    };
  });
}
```

## 模型、环境光与取景（`@frame/engine/three-assets`）

| 函数 | 作用 |
|---|---|
| `loadModel(src, renderer)` | 读模型：GLB/glTF（支持 Draco、Meshopt、KTX2 压缩）、FBX（Mixamo 的角色和动作）、OBJ（连同它引用的 .mtl）。返回 `{ scene, animations, cameras }`。推荐 GLB：一个文件包含几何、材质和贴图 |
| `loadEnvironment(src, renderer)` | HDR/EXR 全景图（如 Poly Haven 的 CC0 HDRI）或普通全景 JPEG/PNG → `scene.environment`（也可以作 `scene.background`） |
| `studioEnvironment(renderer)` | 不用文件的柔和摄影棚光 |
| `frameObject(camera, object, { azimuth, elevation, margin, turning })` | 把透视相机放在能让物体刚好占满画面的位置，返回物体中心。`azimuth` 水平角（默认 20，0 是正面 +Z，90 是右侧），`elevation` 俯仰角（默认 10，负数从下往上看），`margin` 留白（默认 1.08，1 是贴边），`turning: true` 时按物体绕竖直轴转一圈都放得下来取景。画面比例取相机的 `aspect`，先设好再调用 |
| `showcase(object, renderer, options)` | 一个物体的完整展台：环境光 + 主光 + 取好景的相机，返回 `{ scene, camera }`（资源预览常用）。`options` 除了 `frameObject` 的取景参数，还有 `width`/`height`（画面比例，默认渲染器的尺寸）、`environment`（`loadEnvironment` 的结果，默认摄影棚光）、`background`（背景色，默认透明） |
| `setAnimationTime(mixer, t)` | 动画按绝对时间求值，可以倒退、跳转 |
| `createPostPipeline(renderer, scene, camera, bloom)` | 辉光后期（见下） |
| `disposeObject(root)` | 释放几何体、材质、贴图（场景的 environment/background 也一起） |
| `prewarmScene(renderer, scene, camera)` | 提前编译场景里所有物体（包括暂时隐藏的）的着色器、上传贴图，免得物体第一次出现时卡一下；`createThreeScene` 已自动调用，自己建 `WebGLRenderer` 时在场景建好后 `await` 它 |

- 模型的地址和其他素材一样：作品自己的 `films/<名称>/…`，或素材库的 `materials/<库>/…`（代码里写这个地址，保存版本时锁定）。glTF/OBJ 引用的外部文件（.bin、贴图、.mtl）要放在同一个文件夹里；能用 GLB 就用 GLB。
- 不知道模型长什么样、有哪些动画：先用 `asset_view` 看（多个方向的渲染、动画名、三角形数、尺寸）。
- 渲染像素比固定为 1，尺寸来自 `options.width/height`。

## 后期

自己实现 Scene，用 `createPostPipeline` 代替直接渲染：

```ts
import * as THREE from "three";
import { createPostPipeline, disposeObject } from "@frame/engine/three-assets";
import type { Scene, SceneOptions } from "@frame/engine/types";

export async function createScene({ width, height }: SceneOptions): Promise<Scene> {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
  const composer = createPostPipeline(renderer, scene, camera, 0.35);
  // …搭建场景…
  return {
    canvas: renderer.domElement,
    render(t) {
      // …按 t 更新…
      composer.render(0);                           // 0：不让后期按自己的时钟推进
    },
    dispose() {
      disposeObject(scene);
      composer.dispose();                           // 连同各个 pass 的渲染目标
      renderer.dispose();
      renderer.forceContextLoss();                  // 立刻交还 WebGL 上下文
    },
  };
}
```

- 辉光后期输出不透明的画面（背景是黑色，不能像普通 three 场景那样透明叠在下层上）：要叠加时给场景画完整的背景，或把辉光图层的 `blend` 设成 `screen`/`lighter`，让黑色部分不起作用。
- 自己创建的 `AnimationMixer` 用 `mixer.stopAllAction()` 停掉，自建的 `WebGLRenderTarget` 要 `dispose()`；几何体、材质、贴图交给 `disposeObject(scene)`。

## 场景的画布和图层的框

scene 图层的模块按**作品画面的尺寸**创建（`options.width/height`），再按图层的 `transform` 和 `fit` 缩放放进框里。全屏的三维场景直接用；只占画面一角的三维卡片（例如方形的框），相机的 `aspect` 和渲染尺寸要按框的形状来，否则物体按整个画面取景、放进小框后显得很小：

```ts
// 框是画面的 0.3 × 0.5（1920×1080 里是 576×540，接近方形）
const w = Math.round(options.width * 0.3), h = Math.round(options.height * 0.5);
renderer.setSize(w, h);                     // 自己实现 Scene 时；createThreeScene 里用 options 的尺寸
camera.aspect = w / h;
camera.updateProjectionMatrix();
frameObject(camera, object);
```

只放一个模型时，模型图层会自动按框的形状取景，不用考虑这些。

## 素材库里的三维资源

角色、道具、场景做成素材库代码，所有作品共用：导出一个创建函数（返回物体和 `update(time)`），再声明成资源（`engine: "three"`），就能在「素材 → 资源」里预览、调参数，AI 用 `resources_search` 找到（写法见 `resources`）。作品里在 `build` 中调用：

```ts
import { gem } from "@materials/三维/code/gems";
import { showcase } from "@frame/engine/three-assets";

export function createScene(options: SceneOptions) {
  return createThreeScene(options, (renderer) => {
    const g = gem({ color: "#ff5a7a" });
    const { scene, camera } = showcase(g.object, renderer);
    return { scene, camera, update: g.update };
  });
}
```

## 其他

- 相机路径可用 `THREE.CatmullRomCurve3` 按时间取点，或 `cameraCurve(time, keys)`（`src/engine/camera-curve.ts`）做一维关键帧插值。
- 作为 visual.json 的 scene 图层时，`engine` 写 `"three"`；背景不设置就是透明的，可以叠在其他图层上。
- 引擎在 `dispose` 时释放场景内几何体、材质和纹理；自己创建的 RenderTarget 等需要自行释放（自定义 Scene 时）。
- 预览窗口没有 WebGL 时会显示错误。`preview_frames` 等工具在用户电脑上开着 FRAME 时用那台电脑的显卡画；否则在服务器上软件渲染，三维场景一帧要几秒，取少量时间点（结果里写明在哪里画的）。
