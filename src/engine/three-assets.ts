import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { assetUrl } from "./types";
/** Load local GLB/glTF assets, including Draco / Meshopt / KTX2 compression. Dispose the result on unmount. */
export async function loadGltf(
  url: string,
  renderer: THREE.WebGLRenderer,
): Promise<GLTF> {
  const draco = new DRACOLoader().setDecoderPath(assetUrl("vendor/draco/"));
  const ktx = new KTX2Loader()
    .setTranscoderPath(assetUrl("vendor/basis/"))
    .detectSupport(renderer);
  const loader = new GLTFLoader()
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx)
    .setMeshoptDecoder(MeshoptDecoder);
  try {
    return await loader.loadAsync(assetUrl(url));
  } finally {
    draco.dispose();
    ktx.dispose();
  }
}
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m);
        Object.values(m).forEach((v) => {
          if (v instanceof THREE.Texture) textures.add(v);
        });
      }
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  textures.forEach((t) => t.dispose());
}
/** An opt-in post-production chain. Call composer.render(0), never its own animation loop. */
export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  bloom = 0.18,
): EffectComposer {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(size, bloom, 0.4, 0.85));
  composer.addPass(new OutputPass());
  return composer;
}
/** Skeletal animations must be evaluated from absolute time for safe reverse seeking. */
export function setAnimationTime(
  mixer: THREE.AnimationMixer,
  seconds: number,
): void {
  mixer.setTime(seconds);
}
