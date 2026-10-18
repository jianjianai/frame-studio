import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { assetUrl } from "./types";

/** Model files loadModel reads. */
export const MODEL_FILE = /\.(glb|gltf|fbx|obj)$/i;

/**
 * Compile the shaders of everything in the scene (hidden objects too) and upload its textures
 * now, while it is being created: otherwise the first frame an object shows in does it, a
 * hitch of 100–300 ms that stops playback. Call after building the scene, before drawing.
 */
export async function prewarmScene(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera) {
  try {
    await renderer.compileAsync(scene, camera);
    const textures = new Set<THREE.Texture>();
    const add = (value: unknown) => value instanceof THREE.Texture && textures.add(value);
    if (scene instanceof THREE.Scene) [scene.background, scene.environment].forEach(add);
    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) for (const value of Object.values(item)) add(value);
    });
    for (const texture of textures) renderer.initTexture(texture);
  } catch {
    // Only a head start: drawing compiles and uploads whatever is left.
  }
}
/** Panoramas loadEnvironment reads. */
export const ENVIRONMENT_FILE = /\.(hdr|exr|jpe?g|png|webp)$/i;

export interface Model {
  /** Add this to a scene; its animations play through an AnimationMixer on it. */
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  cameras: THREE.Camera[];
}

const extensionOf = (src: string) => /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase() ?? "";

/**
 * A 3D model by its asset address (films/<work>/… or materials/<library>/…): GLB/glTF
 * (with Draco, Meshopt or KTX2 compression), FBX (Mixamo characters and motions) or OBJ
 * (with the .mtl it names). Prefer GLB: one file holds geometry, materials and textures.
 * Release it with disposeObject when the scene is done.
 */
export async function loadModel(src: string, renderer: THREE.WebGLRenderer): Promise<Model> {
  const url = assetUrl(src);
  const extension = extensionOf(src);
  if (extension === "glb" || extension === "gltf") {
    const draco = new DRACOLoader().setDecoderPath(assetUrl("vendor/draco/"));
    const ktx = new KTX2Loader().setTranscoderPath(assetUrl("vendor/basis/")).detectSupport(renderer);
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx).setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(url);
      return { scene: gltf.scene, animations: gltf.animations, cameras: gltf.cameras };
    } finally {
      draco.dispose();
      ktx.dispose();
    }
  }
  if (extension === "fbx") {
    const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
    const group = await new FBXLoader().loadAsync(url);
    return { scene: group, animations: group.animations, cameras: [] };
  }
  if (extension === "obj") {
    const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`模型加载失败（HTTP ${response.status}）：${src}`);
    const text = await response.text();
    const loader = new OBJLoader();
    let group = loader.parse(text);
    // An OBJ names its materials file (mtllib); without one it is drawn in a plain material.
    const library = (group as THREE.Group & { materialLibraries?: string[] }).materialLibraries?.[0];
    if (library) {
      const { MTLLoader } = await import("three/addons/loaders/MTLLoader.js");
      const materials = await new MTLLoader().setPath(url.slice(0, url.lastIndexOf("/") + 1)).loadAsync(library);
      materials.preload();
      group = loader.setMaterials(materials).parse(text);
    }
    return { scene: group, animations: [], cameras: [] };
  }
  throw new Error(`不支持的模型格式：${src}（支持 GLB、glTF、FBX、OBJ）`);
}

/**
 * A panorama as image-based lighting for `scene.environment` (and, if wanted,
 * `scene.background`): an HDR or EXR (e.g. from Poly Haven), or an ordinary equirectangular
 * JPEG/PNG/WebP. Released with the scene by disposeObject.
 */
export async function loadEnvironment(src: string, renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const url = assetUrl(src);
  const extension = extensionOf(src);
  let texture: THREE.Texture;
  if (extension === "hdr") texture = await new (await import("three/addons/loaders/HDRLoader.js")).HDRLoader().loadAsync(url);
  else if (extension === "exr") texture = await new (await import("three/addons/loaders/EXRLoader.js")).EXRLoader().loadAsync(url);
  else if (ENVIRONMENT_FILE.test(src)) {
    texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
  } else throw new Error(`不支持的环境贴图：${src}（支持 HDR、EXR、JPEG、PNG、WebP 全景图）`);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    return pmrem.fromEquirectangular(texture).texture;
  } finally {
    texture.dispose();
    pmrem.dispose();
  }
}

/** Soft studio lighting without any file (an indoor room), for `scene.environment`. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    return pmrem.fromScene(room, 0.04).texture;
  } finally {
    room.dispose();
    pmrem.dispose();
  }
}

export interface FrameOptions {
  /** Degrees around the object: 0 looks at its front (+Z), 90 at its right side. */
  azimuth?: number;
  /** Degrees above the object's middle (negative: from below). */
  elevation?: number;
  /** Room around it: 1 touches the picture's edges. */
  margin?: number;
  /** The object turns about its vertical axis (spin): frame it so that it fits at every angle. */
  turning?: boolean;
}

/**
 * Place a perspective camera so the object fills the picture (the camera's aspect) from the
 * given direction, and aim it at the object's middle. Returns that point.
 */
export function frameObject(camera: THREE.PerspectiveCamera, object: THREE.Object3D, { azimuth = 20, elevation = 10, margin = 1.08, turning = false }: FrameOptions = {}): THREE.Vector3 {
  object.updateWorldMatrix(true, true);
  // A skinned mesh keeps the bounds of the pose it was first measured in: measure the current one.
  object.traverse((item) => {
    if (item instanceof THREE.SkinnedMesh) item.computeBoundingBox();
  });
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const center = box.getCenter(new THREE.Vector3());
  if (turning) {
    // Whatever the angle, the object stays inside the cylinder around its vertical axis.
    const radius = Math.hypot(Math.max(center.x - box.min.x, box.max.x - center.x), Math.max(center.z - box.min.z, box.max.z - center.z));
    box.min.x = center.x - radius;
    box.max.x = center.x + radius;
    box.min.z = center.z - radius;
    box.max.z = center.z + radius;
  }
  const a = THREE.MathUtils.degToRad(azimuth);
  const e = THREE.MathUtils.degToRad(Math.max(-89, Math.min(89, elevation)));
  const back = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * camera.aspect;
  // The nearest distance at which every corner of the box is inside the view.
  let distance = 0;
  let depth = 0;
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    const toward = corner.dot(back);
    depth = Math.max(depth, Math.abs(toward));
    distance = Math.max(distance, toward + Math.abs(corner.dot(right)) * margin / tanH, toward + Math.abs(corner.dot(up)) * margin / tanV);
  }
  distance = Math.max(distance, depth * 1.5, 1e-3);
  camera.position.copy(center).addScaledVector(back, distance);
  camera.near = Math.max(distance / 1000, (distance - depth) * 0.2);
  camera.far = distance + depth * 10;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

export interface ShowcaseOptions extends FrameOptions {
  /** Picture size (default: the renderer's). */
  width?: number;
  height?: number;
  /** Image-based lighting (loadEnvironment); default a soft studio. */
  environment?: THREE.Texture;
  /** A colour behind the object; default transparent. */
  background?: THREE.ColorRepresentation;
}

/**
 * A scene that shows one object (a character, a product, a prop) lit like in a studio, with a
 * camera that frames it: `{ scene, camera }` for createThreeScene and resource previews.
 */
export function showcase(object: THREE.Object3D, renderer: THREE.WebGLRenderer, options: ShowcaseOptions = {}): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const size = renderer.getSize(new THREE.Vector2());
  const scene = new THREE.Scene();
  scene.environment = options.environment ?? studioEnvironment(renderer);
  if (options.background !== undefined) scene.background = new THREE.Color(options.background);
  const camera = new THREE.PerspectiveCamera(30, (options.width ?? size.x) / (options.height ?? size.y), 0.01, 1000);
  scene.add(object);
  const center = frameObject(camera, object, options);
  // A key light above and beside the camera gives the shape some modelling.
  const toward = camera.position.clone().sub(center);
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toward).normalize();
  const key = new THREE.DirectionalLight("#ffffff", 1.2);
  key.position.copy(camera.position).addScaledVector(side, toward.length() * 0.6).add(new THREE.Vector3(0, toward.length() * 0.8, 0));
  key.target.position.copy(center);
  scene.add(key, key.target);
  return { scene, camera };
}

export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m);
        Object.values(m).forEach((v) => {
          if (v instanceof THREE.Texture) textures.add(v);
        });
      }
    }
  });
  // A scene's lighting and backdrop belong to it as well.
  if (root instanceof THREE.Scene) for (const value of [root.environment, root.background]) if (value instanceof THREE.Texture) textures.add(value);
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
