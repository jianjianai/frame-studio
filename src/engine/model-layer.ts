import * as THREE from "three";
import { disposeObject, frameObject, loadEnvironment, loadModel, studioEnvironment, prewarmScene } from "./three-assets";

/** visual.json `source` of a model layer. */
export interface ModelSource {
  kind: "model";
  src: string;
  /** Animation clip by name; the first clip when not given. */
  animation?: string;
  /** Degrees per second the model turns about its vertical axis. */
  spin?: number;
  /** Camera direction: degrees around (0 = front) and above. */
  azimuth?: number;
  elevation?: number;
  /** Panorama for image-based lighting; a soft studio when not given. */
  environment?: string;
}

/**
 * A model layer: the model lit like in a studio, framed to fill the layer's box at the box's
 * own shape, its animation at the layer's time. Drawn at the size it is shown, on its own
 * transparent WebGL canvas.
 */
export async function createModelLayer(source: ModelSource, signal: AbortSignal) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  try {
    const model = await loadModel(source.src, renderer);
    signal.throwIfAborted();
    scene.environment = source.environment ? await loadEnvironment(source.environment, renderer) : studioEnvironment(renderer);
    signal.throwIfAborted();
    // The model turns about the vertical line through its middle.
    const pivot = new THREE.Group();
    const center = new THREE.Box3().setFromObject(model.scene).getCenter(new THREE.Vector3());
    model.scene.position.sub(new THREE.Vector3(center.x, 0, center.z));
    pivot.add(model.scene);
    scene.add(pivot);
    const key = new THREE.DirectionalLight("#ffffff", 1.2);
    scene.add(key, key.target);
    const clip = source.animation ? model.animations.find((item) => item.name === source.animation) : model.animations[0];
    if (source.animation && !clip)
      throw new Error(`模型 ${source.src} 里没有动画「${source.animation}」（有：${model.animations.map((item) => item.name || "（无名）").join("、") || "无"}）`);
    const mixer = clip ? new THREE.AnimationMixer(model.scene) : null;
    mixer?.clipAction(clip!).play();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    await prewarmScene(renderer, scene, camera);
    let framed = "";
    return {
      /** The picture at layer time `time`, `width` × `height` pixels (the layer's box on screen). */
      frame(time: number, width: number, height: number) {
        const w = Math.max(2, Math.min(4096, Math.round(width)));
        const h = Math.max(2, Math.min(4096, Math.round(height)));
        if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
        mixer?.setTime(time);
        pivot.rotation.y = THREE.MathUtils.degToRad((source.spin ?? 0) * time);
        const shape = `${w}x${h}`;
        if (framed !== shape) {
          // Framed in the rest pose, turned to the front: the picture does not jump as it moves.
          const turn = pivot.rotation.y;
          pivot.rotation.y = 0;
          mixer?.setTime(0);
          camera.aspect = w / h;
          const middle = frameObject(camera, pivot, { azimuth: source.azimuth, elevation: source.elevation, turning: Boolean(source.spin) });
          pivot.rotation.y = turn;
          mixer?.setTime(time);
          const toward = camera.position.clone().sub(middle);
          const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toward).normalize();
          key.position.copy(camera.position).addScaledVector(side, toward.length() * 0.6).add(new THREE.Vector3(0, toward.length() * 0.8, 0));
          key.target.position.copy(middle);
          framed = shape;
        }
        renderer.render(scene, camera);
        return { image: canvas, width: w, height: h };
      },
      dispose() {
        mixer?.stopAllAction();
        disposeObject(scene);
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.width = canvas.height = 1;
      },
      animations: model.animations.map((item) => ({ name: item.name, duration: item.duration })),
    };
  } catch (error) {
    disposeObject(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}
