import { Application, Assets, Container, Graphics, Sprite } from "pixi.js";
import { gsap } from "gsap";
import { assetUrl, type SceneOptions, type Scene } from "../../engine/types";
import { clamp, easeInOut, phase, smooth } from "../../engine/math";
const flight = (t: number): { x: number; y: number } => {
  const p = easeInOut(phase(t, 0.4, 30.5));
  return {
    x: 430 + 5330 * p,
    y:
      560 -
      70 * p -
      Math.sin(p * Math.PI) * 205 +
      Math.sin(p * Math.PI * 5) * 50,
  };
};
export async function createScene({
  width,
  height,
}: SceneOptions): Promise<Scene> {
  const app = new Application();
  await app.init({
    width,
    height,
    antialias: true,
    autoStart: false,
    sharedTicker: false,
    background: "#eddac2",
    preference: "webgl",
    preserveDrawingBuffer: true,
    resolution: 1,
  });
  const stage = new Container();
  stage.scale.set(width / 1600, height / 900);
  app.stage.addChild(stage);
  try {
    const names = [
      "paper-plane",
      "cloud",
      "mountains",
      "landscape",
      "lighthouse",
      "foreground",
    ];
    const textures = await Promise.all(
      names.map((n) => Assets.load(assetUrl("art/" + n + ".svg"))),
    );
    const sky = new Graphics();
    sky.rect(0, 0, 1600, 900).fill("#f0dcc2");
    sky.rect(0, 650, 1600, 250).fill("#a2c0b7");
    stage.addChild(sky);
    const sun = new Graphics();
    for (let r = 175; r >= 103; r -= 12)
      sun
        .circle(1200, 240, r)
        .fill({ color: "#edb78e", alpha: r === 103 ? 1 : 0.12 });
    sun.circle(1200, 240, 104).fill("#eaaa7d");
    stage.addChild(sun);
    const far = new Sprite(textures[2]);
    far.y = 70;
    far.alpha = 0.85;
    stage.addChild(far);
    const clouds = Array.from({ length: 8 }, (_, i) => {
      const c = new Sprite(textures[1]);
      c.scale.set(0.32 + (i % 3) * 0.13);
      c.y = 95 + (i % 3) * 90;
      c.alpha = 0.66;
      stage.addChild(c);
      return c;
    });
    const water = new Graphics();
    stage.addChild(water);
    const world = new Container();
    stage.addChild(world);
    const landscape = new Sprite(textures[3]);
    world.addChild(landscape);
    const trails = new Graphics();
    world.addChild(trails);
    const lighthouse = new Sprite(textures[4]);
    lighthouse.position.set(5634, 434);
    lighthouse.scale.set(0.9);
    world.addChild(lighthouse);
    const light = new Graphics();
    world.addChild(light);
    const plane = new Sprite(textures[0]);
    plane.anchor.set(0.5);
    plane.scale.set(0.59);
    world.addChild(plane);
    const birds = new Graphics();
    stage.addChild(birds);
    const foreground = new Sprite(textures[5]);
    foreground.y = 45;
    stage.addChild(foreground);
    const camera = { x: 800, y: 450, zoom: 1.05 };
    const timeline = gsap.timeline({ paused: true });
    timeline
      .to(camera, { zoom: 1.18, duration: 6, ease: "sine.inOut" }, 0)
      .to(camera, { x: 1500, y: 430, duration: 5, ease: "power1.inOut" }, 4)
      .to(camera, { x: 2860, y: 410, zoom: 1.12, duration: 8, ease: "none" }, 9)
      .to(
        camera,
        { x: 4450, y: 420, zoom: 1.05, duration: 9, ease: "none" },
        17,
      )
      .to(
        camera,
        { x: 5420, y: 460, zoom: 0.92, duration: 6, ease: "power2.out" },
        26,
      );
    return {
      canvas: app.canvas as HTMLCanvasElement,
      render(time) {
        const t = clamp(time, 0, 32);
        timeline.seek(t, true);
        const follow = flight(t);
        const arrival = smooth(phase(t, 26, 32));
        camera.x =
          800 + (follow.x + 180 - 400 * arrival - 800) * smooth(phase(t, 2, 6));
        world.position.set(800, 450);
        world.pivot.set(camera.x, camera.y);
        world.scale.set(camera.zoom);
        far.x = -(camera.x - 800) * 0.18 - 40;
        sun.x = -(camera.x - 800) * 0.035;
        clouds.forEach((c, i) => {
          c.x =
            ((i * 410 + t * (3 + (i % 3)) - camera.x * 0.1 + 3300) % 3300) -
            500;
          c.y = 80 + (i % 3) * 96 + Math.sin(t * 0.25 + i) * 7;
        });
        water.clear();
        for (let i = 0; i < 21; i++) {
          const x = ((i * 151 + t * 8 - camera.x * 0.17 + 4000) % 2100) - 260;
          const y = 755 + (i % 5) * 31;
          water
            .moveTo(x, y)
            .bezierCurveTo(x + 40, y - 4, x + 70, y + 5, x + 110, y)
            .stroke({ color: "#e5e1c7", width: 2, alpha: 0.28 });
        }
        const p = flight(t),
          prev = flight(Math.max(0, t - 0.045));
        plane.position.set(p.x, p.y);
        plane.rotation =
          Math.atan2(p.y - prev.y, Math.max(0.1, p.x - prev.x)) * 0.75 +
          Math.sin(t * 1.6) * 0.025;
        plane.scale.set(0.59, 0.59 * (0.94 + Math.sin(t * 1.2) * 0.045));
        trails.clear();
        if (t > 1 && t < 30) {
          for (let j = 0; j < 2; j++) {
            const q0 = flight(Math.max(0, t - 0.9));
            trails.moveTo(q0.x - 38, q0.y + j * 12);
            for (let i = 14; i >= 0; i--) {
              const q = flight(Math.max(0, t - i * 0.06));
              trails.lineTo(q.x - 45, q.y + j * 12);
            }
            trails.stroke({
              color: "#fff8e7",
              width: 2 - j * 0.5,
              alpha: 0.38 - j * 0.15,
            });
          }
        }
        light.clear();
        const lit = smooth(phase(t, 27, 30));
        if (lit > 0) {
          light
            .moveTo(5750, 500)
            .lineTo(6500, 340 + Math.sin(t * 0.35) * 130)
            .lineTo(6500, 650 + Math.sin(t * 0.35) * 130)
            .closePath()
            .fill({ color: "#ffe8a8", alpha: lit * 0.18 });
          for (let i = 4; i > 0; i--)
            light
              .circle(5750, 500, 15 + i * 16)
              .fill({ color: "#ffecc0", alpha: lit * 0.06 });
        }
        birds.clear();
        for (let i = 0; i < 5; i++) {
          const x =
            ((1200 + i * 70 - t * 21 - camera.x * 0.25 + 4500) % 2200) - 300;
          const y = 300 + i * 13 + Math.sin(t * 1.3 + i) * 13;
          const flap = Math.sin(t * 5 + i) * 8;
          birds
            .moveTo(x - 13, y + flap)
            .quadraticCurveTo(x - 4, y - 3, x, y + 2)
            .quadraticCurveTo(x + 5, y - 3, x + 13, y + flap)
            .stroke({ color: "#667f78", width: 2 });
        }
        foreground.x = -clamp((camera.x - 800) * 1.1, 0, 9000);
        if (camera.x > 3300 && camera.x < 4600)
          foreground.x = 1700 - (camera.x - 3300) * 2.2;
        app.renderer.render(app.stage);
      },
      dispose() {
        timeline.kill();
        app.destroy(true, { children: true, texture: false });
      },
    };
  } catch (error) {
    app.destroy(true, { children: true });
    throw error;
  }
}
