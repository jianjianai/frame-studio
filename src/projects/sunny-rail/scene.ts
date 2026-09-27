import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { gsap } from "gsap";
import { disposeObject } from "../../engine/three-assets";
import { clamp, easeInOut, phase, seeded } from "../../engine/math";
import type { Scene, SceneOptions } from "../../engine/types";
export function createScene({ width, height, quality }: SceneOptions): Scene {
  const renderer = new THREE.WebGLRenderer({
    antialias: quality !== "draft",
    preserveDrawingBuffer: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ecd4bf");
  scene.fog = new THREE.Fog("#ecd4bf", 42, 95);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.045);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;
  room.dispose();
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 130);
  const hemi = new THREE.HemisphereLight("#fff6df", "#869789", 1.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#ffe2b7", 2.6);
  sun.position.set(-8, 18, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(
    quality === "high" ? 2048 : quality === "draft" ? 512 : 1024,
  );
  sun.shadow.camera.left = -15;
  sun.shadow.camera.right = 15;
  sun.shadow.camera.top = 13;
  sun.shadow.camera.bottom = -13;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const material = (c: string, roughness = 0.7, metalness = 0.05) =>
    new THREE.MeshStandardMaterial({ color: c, roughness, metalness });
  const cream = material("#e6d8ba");
  const green = material("#8dac89");
  const greenDark = material("#486d63");
  const orange = material("#d88351");
  const roof = material("#477677");
  const dark = material("#334f56");
  const railMat = material("#8c9c97", 0.4, 0.65);
  const wood = material("#aa9276");
  const glass = material("#244c59", 0.16, 0.25);
  const gold = material("#e7b869", 0.42, 0.4);
  const white = material("#f6e9ce");
  const mesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    parent: THREE.Object3D = scene,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    parent: THREE.Object3D = scene,
    radius = 0.06,
  ) =>
    mesh(
      new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)),
      mat,
      x,
      y,
      z,
      parent,
    );
  const island = mesh(
    new THREE.CylinderGeometry(9.7, 9.4, 0.85, 100),
    cream,
    0,
    -0.48,
  );
  island.scale.z = 0.73;
  const edge = mesh(
    new THREE.CylinderGeometry(9.75, 9.5, 0.19, 100),
    wood,
    0,
    -0.92,
  );
  edge.scale.z = 0.73;
  const floor = mesh(
    new THREE.PlaneGeometry(220, 220),
    material("#ddc4b0"),
    0,
    -1.08,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  const lawn = mesh(
    new THREE.CylinderGeometry(5.6, 5.7, 0.18, 64),
    green,
    0,
    0.01,
    -0.15,
  );
  lawn.scale.z = 0.59;
  // Oval rails, individually placed sleepers and bridge supports remain coherent in all camera angles.
  const track = (a: number, offset = 0) =>
    new THREE.Vector3(
      Math.sin(a) * (7.4 + offset),
      0.21 + Math.pow(Math.max(0, Math.sin(a)), 8) * 0.32,
      Math.cos(a) * (4.7 + offset),
    );
  for (const offset of [-0.29, 0.29]) {
    const curve = new THREE.CatmullRomCurve3(
      Array.from({ length: 161 }, (_, i) =>
        track((i / 160) * Math.PI * 2, offset),
      ),
    );
    mesh(new THREE.TubeGeometry(curve, 200, 0.045, 7, false), railMat);
  }
  for (let i = 0; i < 110; i++) {
    const a = (i / 110) * Math.PI * 2;
    const p = track(a);
    const sleeper = box(0.13, 0.08, 0.92, wood, p.x, p.y - 0.1, p.z);
    const tangent = track(a + 0.001).sub(p);
    sleeper.rotation.y = -Math.atan2(tangent.z, tangent.x);
    if (p.y > 0.34 && i % 4 === 0)
      box(0.3, p.y + 0.18, 0.8, cream, p.x, p.y / 2 - 0.14, p.z);
  }
  // A small river cut into the landscape.
  const riverShape = new THREE.Shape();
  riverShape.moveTo(-5.8, -1.4);
  riverShape.bezierCurveTo(-1, -0.4, -2, -2, 1.5, -1.8);
  riverShape.bezierCurveTo(4, -1.6, 2, -3.2, 6.2, -3);
  riverShape.lineTo(6.5, -2.6);
  riverShape.bezierCurveTo(3, -2.7, 4, -1.1, 1.5, -1.25);
  riverShape.bezierCurveTo(-2, -1.5, -1, 0.1, -5.9, -0.9);
  riverShape.closePath();
  const river = mesh(
    new THREE.ShapeGeometry(riverShape),
    material("#8bbbbb", 0.27),
    0,
    0.13,
  );
  river.rotation.x = -Math.PI / 2;
  const mountains: THREE.Mesh[] = [];
  for (const [x, z, r, h] of [
    [-0.7, -1.0, 1.8, 4.8],
    [1.3, -1.9, 1.35, 3.7],
    [-2.4, -2.1, 1.25, 3.2],
  ]) {
    mountains.push(
      mesh(
        new THREE.ConeGeometry(r, h, 6),
        material(x > 0 ? "#9dae90" : "#90a38a"),
        x,
        h / 2,
        z,
      ),
    );
    mesh(new THREE.ConeGeometry(r * 0.24, h * 0.24, 6), white, x, h * 0.89, z);
  }
  // Platform and station, including a pitched roof, doors, glass, and a readable clock face.
  box(5.9, 0.25, 1.45, white, -0.8, 0.13, 3.1);
  box(3.8, 1.65, 1.5, cream, -1.7, 0.97, 1.96);
  const roofGroup = new THREE.Group();
  roofGroup.position.set(-1.7, 1.88, 1.96);
  scene.add(roofGroup);
  for (const side of [-1, 1]) {
    const r = box(4.2, 0.16, 1.17, roof, 0, 0.24, side * 0.44, roofGroup);
    r.rotation.x = side * 0.55;
  }
  box(0.6, 1.28, 0.065, glass, -1.7, 0.8, 2.73);
  for (const x of [-2.85, -0.57]) {
    box(0.67, 0.69, 0.07, glass, x, 1.12, 2.74);
    box(0.73, 0.065, 0.12, white, x, 0.75, 2.78);
    box(0.05, 0.7, 0.1, cream, x, 1.12, 2.81);
  }
  const clockFace = mesh(
    new THREE.CircleGeometry(0.24, 40),
    white,
    -1.7,
    1.64,
    2.76,
  );
  clockFace.castShadow = false;
  box(0.024, 0.15, 0.02, dark, -1.7, 1.68, 2.79);
  const hand = box(0.13, 0.022, 0.02, dark, -1.65, 1.63, 2.79);
  hand.rotation.z = -0.3;
  for (const x of [-3.9, 1.9]) {
    box(0.055, 1.15, 0.055, dark, x, 0.74, 3.1);
    mesh(new THREE.SphereGeometry(0.12, 16, 12), gold, x, 1.36, 3.1);
    box(0.7, 0.1, 0.3, wood, x, 0.52, 2.9);
  }
  // Windmill with rotating blades.
  const mill = new THREE.Group();
  mill.position.set(-4.6, 0, -0.8);
  scene.add(mill);
  mesh(new THREE.CylinderGeometry(0.35, 0.65, 2.2, 20), white, 0, 1.1, 0, mill);
  mesh(new THREE.ConeGeometry(0.68, 0.85, 20), orange, 0, 2.53, 0, mill);
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.0, 0.42);
  mill.add(rotor);
  mesh(new THREE.SphereGeometry(0.16, 16, 12), gold, 0, 0, 0.04, rotor);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Group();
    blade.rotation.z = (i * Math.PI) / 2;
    rotor.add(blade);
    box(0.08, 1.85, 0.075, wood, 0, 0.92, 0, blade);
    box(0.33, 1.0, 0.055, white, 0.13, 1.16, 0.04, blade);
  }
  // Stylised trees, rocks, flowerbeds and a fence build a real environment instead of an empty geometric demo.
  const random = seeded(1994);
  for (let i = 0; i < 29; i++) {
    const a = random() * Math.PI * 2,
      r = 2.8 + random() * 2.2;
    const x = Math.sin(a) * r,
      z = Math.cos(a) * r * 0.56 - 0.35;
    if (z > 1.7 && x < 1.7) continue;
    const s = 0.65 + random() * 0.5;
    mesh(
      new THREE.CylinderGeometry(0.075, 0.1, 0.65 * s, 8),
      wood,
      x,
      0.31 * s,
      z,
    );
    mesh(
      new THREE.ConeGeometry(0.52 * s, 1.55 * s, 7),
      i % 2 ? greenDark : green,
      x,
      1.1 * s,
      z,
    );
    mesh(
      new THREE.ConeGeometry(0.41 * s, 1.2 * s, 7),
      i % 2 ? greenDark : green,
      x,
      1.6 * s,
      z,
    );
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const x = Math.sin(a) * 8.6,
      z = Math.cos(a) * 5.75;
    const stone = mesh(
      new THREE.DodecahedronGeometry(0.16 + (i % 3) * 0.05),
      i % 2 ? cream : green,
      x,
      0.13,
      z,
    );
    stone.scale.set(1.4, 0.55, 1);
  }
  for (let i = 0; i < 12; i++) {
    const x = 2.3 + i * 0.22;
    box(0.04, 0.32, 0.04, white, x, 0.25, 2.55);
    if (i < 11) box(0.23, 0.04, 0.04, white, x + 0.11, 0.35, 2.55);
  }
  for (let i = 0; i < 15; i++) {
    const x = 3.0 + random() * 1.5,
      z = 1.2 + random() * 0.8;
    mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      i % 2 ? gold : orange,
      x,
      0.22,
      z,
    );
  }
  const wheels: THREE.Mesh[] = [];
  const makeTrain = (engine: boolean) => {
    const group = new THREE.Group();
    scene.add(group);
    box(engine ? 1.8 : 1.6, 0.25, 0.96, dark, 0, 0.43, 0, group);
    for (const x of [-0.55, 0.55])
      for (const z of [-0.51, 0.51]) {
        const wheel = mesh(
          new THREE.CylinderGeometry(0.25, 0.25, 0.1, 20),
          dark,
          x,
          0.33,
          z,
          group,
        );
        wheel.rotation.x = Math.PI / 2;
        wheels.push(wheel);
        const hub = mesh(
          new THREE.CylinderGeometry(0.11, 0.11, 0.12, 16),
          gold,
          x,
          0.33,
          z,
          group,
        );
        hub.rotation.x = Math.PI / 2;
        wheels.push(hub);
      }
    if (engine) {
      box(0.85, 1.0, 0.95, orange, -0.49, 1.06, 0, group);
      box(1.0, 0.12, 1.09, roof, -0.49, 1.61, 0, group);
      const boiler = mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 1.11, 24),
        orange,
        0.36,
        0.97,
        0,
        group,
      );
      boiler.rotation.z = Math.PI / 2;
      mesh(
        new THREE.CylinderGeometry(0.11, 0.16, 0.48, 16),
        dark,
        0.68,
        1.49,
        0,
        group,
      );
      mesh(
        new THREE.CylinderGeometry(0.19, 0.19, 0.1, 16),
        gold,
        0.68,
        1.76,
        0,
        group,
      );
      for (const z of [-0.48, 0.48])
        box(0.44, 0.39, 0.035, glass, -0.5, 1.18, z, group);
      box(0.045, 0.44, 0.035, cream, -0.49, 1.18, 0.51, group);
      const nose = mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.09, 24),
        gold,
        0.95,
        0.97,
        0,
        group,
      );
      nose.rotation.z = Math.PI / 2;
      box(0.2, 0.16, 0.93, dark, 1.05, 0.4, 0, group);
    } else {
      box(1.6, 0.89, 0.91, cream, 0, 1.01, 0, group);
      box(1.78, 0.15, 1.06, roof, 0, 1.5, 0, group);
      box(1.62, 0.2, 0.96, orange, 0, 0.67, 0, group);
      for (const x of [-0.48, 0, 0.48])
        for (const z of [-0.465, 0.465])
          box(0.32, 0.4, 0.04, glass, x, 1.09, z, group);
    }
    return group;
  };
  const train = [makeTrain(true), makeTrain(false), makeTrain(false)];
  const steam: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const m = mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshStandardMaterial({
        color: "#fff7e2",
        transparent: true,
        opacity: 0.6,
        roughness: 1,
      }),
      0,
      0,
      0,
    );
    m.castShadow = false;
    steam.push(m);
  }
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 3; i++) {
    const group = new THREE.Group();
    scene.add(group);
    for (let j = 0; j < 4; j++) {
      const m = mesh(
        new THREE.SphereGeometry(0.65 + (j % 2) * 0.3, 16, 12),
        white,
        (j - 1.5) * 0.64,
        (j % 2) * 0.2,
        0,
        group,
      );
      m.scale.set(1, 0.65, 0.7);
      m.castShadow = false;
    }
    clouds.push(group);
  }
  const cam = { x: 17, y: 12, z: 20, tx: 0, ty: 1, tz: 0 };
  const timeline = gsap
    .timeline({ paused: true })
    .to(
      cam,
      {
        x: 11,
        y: 6.6,
        z: 14,
        tx: 1,
        ty: 1.2,
        tz: 0,
        duration: 9,
        ease: "sine.inOut",
      },
      0,
    )
    .to(
      cam,
      {
        x: 15,
        y: 9,
        z: -10,
        tx: 0,
        ty: 1,
        tz: -0.6,
        duration: 10,
        ease: "sine.inOut",
      },
      9,
    )
    .to(
      cam,
      {
        x: -12,
        y: 10,
        z: -11,
        tx: -1,
        ty: 1,
        tz: 0,
        duration: 9,
        ease: "sine.inOut",
      },
      19,
    )
    .to(
      cam,
      {
        x: 17,
        y: 12,
        z: 20,
        tx: 0,
        ty: 1,
        tz: 0,
        duration: 8,
        ease: "sine.inOut",
      },
      28,
    );
  return {
    canvas: renderer.domElement,
    render(time) {
      const t = clamp(time, 0, 36);
      timeline.seek(t, true);
      const progress = easeInOut(phase(t, 0.5, 35)),
        theta = progress * Math.PI * 2;
      train.forEach((group, i) => {
        const a = theta - i * 0.285,
          p = track(a),
          tangent = track(a + 0.001).sub(p);
        group.position.copy(p);
        group.rotation.y = -Math.atan2(tangent.z, tangent.x);
      });
      wheels.forEach(
        (w) => (w.rotation.y = (-progress * Math.PI * 2 * 7.4) / 0.25),
      );
      rotor.rotation.z = -t * 0.65;
      clouds.forEach((c, i) =>
        c.position.set(
          -6 + i * 6 + Math.sin(t * 0.15 + i) * 0.6,
          6.5 + (i % 2) * 0.7,
          -4 + i * 1.6,
        ),
      );
      steam.forEach((m, i) => {
        const life = (((t * 1.2 + i / 8) % 1) + 1) % 1;
        const a = theta - life * 0.13;
        const p = track(a);
        m.position.set(p.x, p.y + 1.9 + life * 1.25, p.z);
        m.scale.setScalar(0.5 + life * 1.9);
        (m.material as THREE.MeshStandardMaterial).opacity = (1 - life) * 0.36;
      });
      camera.position.set(cam.x, cam.y, cam.z);
      camera.lookAt(cam.tx, cam.ty, cam.tz);
      renderer.render(scene, camera);
    },
    dispose() {
      timeline.kill();
      disposeObject(scene);
      env.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
