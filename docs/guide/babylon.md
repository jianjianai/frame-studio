# babylon：Babylon.js 三维场景

`createBabylonScene(options, build)` 创建引擎和画布，`build(engine, canvas)` 返回 `{ scene, update }`。引擎关闭了场景自带动画，不调用 `runRenderLoop`。

```ts
import { Scene, ArcRotateCamera, HemisphericLight, MeshBuilder, Vector3, Color4, StandardMaterial, Color3 } from "@babylonjs/core";
import type { SceneOptions } from "../../src/engine/types";
import { createBabylonScene } from "../../src/engine/babylon-adapter";

export function createScene(options: SceneOptions) {
  return createBabylonScene(options, (engine, canvas) => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);
    const camera = new ArcRotateCamera("camera", 0, 1.1, 8, Vector3.Zero(), scene);
    new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    const knot = MeshBuilder.CreateTorusKnot("knot", { radius: 1.4, tube: 0.35 }, scene);
    const material = new StandardMaterial("mat", scene);
    material.diffuseColor = new Color3(0.9, 0.5, 0.2);
    knot.material = material;
    void canvas;
    return {
      scene,
      update(t) {
        camera.alpha = t * 0.4;
        knot.rotation.y = t;
      },
    };
  });
}
```

作为 visual.json 的 scene 图层时，`engine` 写 `"babylon"`。
