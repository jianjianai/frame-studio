# three：Three.js 三维场景

`createThreeScene(options, build)` 创建透明背景的 WebGL 渲染器。`build` 返回场景、相机和 `update(time)`；不要调用 `renderer.setAnimationLoop`。

```ts
import * as THREE from "three";
import type { SceneOptions } from "@frame/engine/types";
import { createThreeScene, } from "@frame/engine/scene-adapters";
import { loadGltf, setAnimationTime, createPostPipeline } from "@frame/engine/three-assets";
import { smooth, phase } from "@frame/engine/math";

export function createScene(options: SceneOptions) {
  return createThreeScene(options, async (renderer) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0d1117");   // 去掉这行即为透明，可叠在其他图层上
    const camera = new THREE.PerspectiveCamera(40, options.width / options.height, 0.1, 100);
    scene.add(new THREE.HemisphereLight("#ffffff", "#334155", 1.2));
    const sun = new THREE.DirectionalLight("#ffffff", 2);
    sun.position.set(3, 5, 2);
    scene.add(sun);

    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#4f7cff", roughness: 0.35 }));
    scene.add(cube);

    // 可选：GLB 模型（放在 public/，支持 Draco / Meshopt / KTX2 压缩）
    // const gltf = await loadGltf("films/work-1a2b3c4d/robot.glb", renderer);
    // scene.add(gltf.scene);
    // const mixer = new THREE.AnimationMixer(gltf.scene);
    // mixer.clipAction(gltf.animations[0]).play();

    return {
      scene,
      camera,
      update(t) {
        cube.rotation.set(t * 0.6, t * 0.9, 0);
        const p = smooth(phase(t, 0, 3));
        camera.position.set(0, 0.5, 6 - 2.5 * p);
        camera.lookAt(0, 0, 0);
        // setAnimationTime(mixer, t);   // 骨骼动画按绝对时间求值
      },
    };
  });
}
```

- 渲染像素比固定为 1，尺寸来自 `options.width/height`。
- 后期（辉光等）：自己实现 Scene，用 `createPostPipeline` 代替直接渲染：

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
      composer.render();
    },
    dispose() {
      disposeObject(scene);
      composer.dispose();
      renderer.dispose();
    },
  };
}
```

- 相机路径可用 `THREE.CatmullRomCurve3` 按时间取点，或 `cameraCurve(time, keys)`（`src/engine/camera-curve.ts`）做一维关键帧插值。
- 引擎在 `dispose` 时释放场景内几何体、材质和纹理；自己创建的 RenderTarget 等需要自行释放（自定义 Scene 时）。
- 预览窗口没有 WebGL 时会显示错误；`preview_frames` 使用软件渲染，三维场景较慢，取少量时间点。
