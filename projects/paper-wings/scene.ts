import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Texture,
} from "pixi.js";
import { assetUrl, type SceneOptions, type Scene } from "../../src/engine/types";
import { clamp, mix, phase, smooth, seeded } from "../../src/engine/math";
import { cameraCurve } from "../../src/engine/camera-curve";

// Positions are authored against the musical phrases; interpolation is C1 and reversible.
export function flight(t: number) {
  return {
    x: cameraCurve(t, [
      [0, 550],
      [2, 620],
      [5, 1060],
      [10, 2010],
      [15, 2980],
      [20, 4070],
      [24, 4950],
      [27.2, 5560],
      [28.5, 5680],
      [29.2, 5680],
      [32, 5680],
    ]),
    y: cameraCurve(t, [
      [0, 533],
      [2, 470],
      [5, 355],
      [8, 276],
      [12, 356],
      [15, 285],
      [18, 344],
      [21, 290],
      [24, 410],
      [27.2, 514],
      [28.5, 626],
      [29.2, 679],
      [32, 679],
    ]),
  };
}
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
    background: "#eed9bf",
    preference: "webgl",
    preserveDrawingBuffer: true,
    resolution: 1,
  });
  const stage = new Container();
  stage.scale.set(width / 1600, height / 900);
  app.stage.addChild(stage);
  const owned: Texture[] = [];
  try {
    const [cloudTexture, towerTexture] = await Promise.all(
      ["cloud", "lighthouse"].map((n) => Assets.load(assetUrl(`films/paper-wings/art/${n}.svg`))),
    );
    const backdrop = document.createElement("canvas");
    backdrop.width = 1600;
    backdrop.height = 900;
    const bc = backdrop.getContext("2d")!;
    const sky = bc.createLinearGradient(0, 0, 0, 900);
    sky.addColorStop(0, "#a9c5c3");
    sky.addColorStop(0.48, "#eedbc2");
    sky.addColorStop(1, "#f8d6ac");
    bc.fillStyle = sky;
    bc.fillRect(0, 0, 1600, 900);
    const sunlight = bc.createRadialGradient(1180, 228, 5, 1180, 228, 260);
    sunlight.addColorStop(0, "#ffefba");
    sunlight.addColorStop(0.34, "#f4c28d");
    sunlight.addColorStop(0.42, "#f1c18e");
    sunlight.addColorStop(1, "rgba(249,209,151,0)");
    bc.fillStyle = sunlight;
    bc.fillRect(870, 0, 700, 570);
    const disc = bc.createLinearGradient(0, 150, 0, 315);
    disc.addColorStop(0, "#f8d49e");
    disc.addColorStop(1, "#eab17c");
    bc.fillStyle = disc;
    bc.beginPath();
    bc.arc(1180, 228, 82, 0, Math.PI * 2);
    bc.fill();
    const bgTexture = Texture.from(backdrop);
    owned.push(bgTexture);
    stage.addChild(new Sprite(bgTexture));
    const rand = seeded(4097);
    const far = new Graphics();
    for (let i = 0; i < 17; i++) {
      const x = i * 410 - 900,
        h = 150 + rand() * 180;
      far
        .moveTo(x, 710)
        .bezierCurveTo(x + 110, 650 - h, x + 270, 620 - h, x + 450, 710)
        .closePath()
        .fill({ color: i % 2 ? "#a7bcb1" : "#b9c8ba", alpha: 0.8 });
      far
        .moveTo(x + 94, 639 - h * 0.67)
        .quadraticCurveTo(x + 245, 632 - h, x + 406, 694)
        .stroke({ color: "#eee5c9", alpha: 0.24, width: 3 });
    }
    stage.addChild(far);
    const clouds = Array.from({ length: 11 }, (_, i) => {
      const s = new Sprite(cloudTexture);
      s.scale.set(0.25 + (i % 4) * 0.12);
      s.alpha = 0.36 + (i % 3) * 0.12;
      stage.addChild(s);
      return s;
    });
    const world = new Container();
    stage.addChild(world);
    const ocean = new Graphics().rect(-1300, 570, 10000, 900).fill("#78a99d");
    for (let i = 0; i < 18; i++)
      ocean
        .rect(-1300, 570 + i * 34, 10000, 36)
        .fill({ color: "#2d7477", alpha: i * 0.017 });
    world.addChild(ocean);
    const waves = new Graphics();
    world.addChild(waves);
    const hills = new Graphics();
    hills
      .moveTo(-1400, 630)
      .bezierCurveTo(-300, 460, 1100, 600, 1700, 571)
      .bezierCurveTo(2300, 464, 2890, 511, 3420, 651)
      .lineTo(3200, 1060)
      .lineTo(-1400, 1060)
      .closePath()
      .fill("#9ab99a");
    hills
      .moveTo(-1400, 737)
      .bezierCurveTo(200, 535, 1070, 662, 1840, 669)
      .bezierCurveTo(2500, 529, 3100, 625, 3340, 731)
      .lineTo(3310, 1050)
      .lineTo(-1400, 1100)
      .closePath()
      .fill("#638f76");
    hills
      .moveTo(-1400, 849)
      .bezierCurveTo(130, 715, 1740, 724, 2430, 785)
      .bezierCurveTo(2800, 707, 3040, 698, 3310, 764)
      .lineTo(3410, 802)
      .lineTo(3280, 842)
      .lineTo(3215, 1090)
      .lineTo(-1400, 1100)
      .closePath()
      .fill("#355f58");
    // Headland face, sea foam and real open water between the forest and lighthouse.
    hills
      .moveTo(3215, 722)
      .lineTo(3390, 784)
      .lineTo(3334, 827)
      .lineTo(3380, 892)
      .lineTo(3200, 1060)
      .lineTo(3010, 1020)
      .closePath()
      .fill("#bcad8d");
    hills
      .moveTo(3210, 734)
      .lineTo(3387, 785)
      .lineTo(3330, 810)
      .lineTo(3207, 783)
      .closePath()
      .fill("#7c9574");
    for (let i = 0; i < 8; i++)
      hills
        .moveTo(3220 - i * 12, 820 + i * 28)
        .lineTo(3310 - i * 12, 833 + i * 28)
        .stroke({ color: "#887e68", alpha: 0.35, width: 4 });
    world.addChild(hills);
    const town = new Graphics();
    const house = (x: number, y: number, s: number, color: string) => {
      const h = new Graphics();
      h.roundRect(-44, -77, 88, 77, 3).fill(color);
      h.poly([-55, -76, 0, -126, 57, -76]).fill("#466567");
      h.moveTo(-51, -79)
        .lineTo(0, -124)
        .lineTo(53, -79)
        .stroke({ color: "#f5d7af", width: 3 });
      h.rect(23, -116, 12, 29).fill("#536b69");
      h.roundRect(-11, -32, 22, 32, 10).fill("#46615d");
      for (const xx of [-28, 18]) {
        h.roundRect(xx, -56, 16, 22, 2).fill("#ffe8b2");
        h.moveTo(xx + 8, -56)
          .lineTo(xx + 8, -34)
          .moveTo(xx, -46)
          .lineTo(xx + 16, -46)
          .stroke({ color: "#9b9d7c", width: 1.4 });
      }
      h.moveTo(-42, -6).lineTo(42, -6).stroke({ color: "#c2a988", width: 2 });
      h.position.set(x, y);
      h.scale.set(s);
      town.addChild(h);
    };
    for (let i = 0; i < 13; i++)
      house(
        150 + i * 108,
        650 + Math.sin(i * 0.8) * 22,
        0.54 + (i % 3) * 0.13,
        ["#eac49c", "#d3d4ad", "#e7d6b5"][i % 3],
      );
    town
      .moveTo(80, 694)
      .bezierCurveTo(500, 671, 620, 750, 1500, 735)
      .stroke({ color: "#c9bd98", width: 14 });
    town
      .moveTo(80, 694)
      .bezierCurveTo(500, 671, 620, 750, 1500, 735)
      .stroke({ color: "#e5d4ae", width: 3, alpha: 0.7 });
    world.addChild(town);
    const tree = (x: number, y: number, s: number, near = false) => {
      const g = new Graphics();
      g.moveTo(0, 6)
        .quadraticCurveTo(3, -65, -5, -175)
        .moveTo(-1, -98)
        .lineTo(-48, -153)
        .moveTo(0, -70)
        .lineTo(55, -143)
        .stroke({ color: near ? "#284f49" : "#5a7560", width: 9 });
      for (const [xx, yy, rx, ry] of [
        [-32, -147, 51, 43],
        [25, -166, 52, 45],
        [-7, -205, 58, 48],
        [51, -128, 45, 35],
        [-49, -118, 40, 31],
      ])
        g.ellipse(xx, yy, rx, ry).fill(near ? "#315d51" : "#658e6b");
      g.ellipse(-17, -211, 36, 22).fill({
        color: near ? "#749276" : "#aac090",
        alpha: 0.34,
      });
      g.position.set(x, y);
      g.scale.set(s);
      return g;
    };
    const grove = new Container();
    world.addChild(grove);
    for (let i = 0; i < 40; i++) {
      const x = 1350 + i * 45 + rand() * 24,
        y = 643 + Math.sin(i * 1.73) * 32;
      if (i % 3 === 0) grove.addChild(tree(x, y, 0.48 + rand() * 0.23));
      else {
        const g = new Graphics().rect(-4, -16, 8, 30).fill("#55705a");
        g.poly([-31, -17, 0, -127, 34, -17]).fill(
          i % 2 ? "#3b6d5c" : "#72986f",
        );
        g.poly([-23, -60, 0, -143, 26, -60]).fill(
          i % 2 ? "#507e64" : "#8fab7c",
        );
        g.position.set(x, y);
        g.scale.set(0.58 + rand() * 0.25);
        grove.addChild(g);
      }
    }
    const bridge = new Graphics();
    bridge
      .moveTo(2650, 678)
      .quadraticCurveTo(2860, 618, 3090, 683)
      .stroke({ color: "#dabf99", width: 21 });
    bridge
      .moveTo(2650, 665)
      .quadraticCurveTo(2860, 605, 3090, 670)
      .stroke({ color: "#efdbb7", width: 4 });
    for (let i = 0; i < 8; i++)
      bridge
        .moveTo(2680 + i * 52, 660 - Math.sin((i / 7) * Math.PI) * 28)
        .lineTo(2680 + i * 52, 712)
        .stroke({ color: "#b39b7b", width: 5 });
    world.addChild(bridge);
    const island = new Graphics();
    island
      .moveTo(5250, 830)
      .bezierCurveTo(5400, 796, 5470, 751, 5610, 752)
      .bezierCurveTo(5890, 719, 6030, 794, 6260, 837)
      .lineTo(6510, 1030)
      .lineTo(5300, 1030)
      .closePath()
      .fill("#b39f7f");
    island
      .moveTo(5240, 837)
      .bezierCurveTo(5500, 727, 5770, 741, 6000, 780)
      .quadraticCurveTo(6120, 798, 6260, 837)
      .quadraticCurveTo(5590, 790, 5240, 854)
      .closePath()
      .fill("#6c8d68");
    for (let i = 0; i < 15; i++)
      island
        .moveTo(5340 + i * 54, 852 + Math.sin(i) * 15)
        .lineTo(5300 + i * 56, 963 + (i % 3) * 20)
        .stroke({ color: "#857c69", width: 4, alpha: 0.45 });
    world.addChild(island);
    const tower = new Sprite(towerTexture);
    tower.position.set(5650, 373);
    world.addChild(tower);
    const porch = new Graphics();
    porch.roundRect(5638, 644, 84, 42, 7).fill("#bb7153");
    porch.roundRect(5648, 652, 64, 6, 3).fill("#2e5552");
    porch.rect(5674, 686, 11, 95).fill("#5b7160");
    porch
      .moveTo(5635, 644)
      .quadraticCurveTo(5680, 622, 5726, 644)
      .stroke({ color: "#f3dbb6", width: 7 });
    world.addChild(porch);
    const beam = new Graphics();
    world.addChild(beam);
    const trails = new Graphics();
    world.addChild(trails);
    const hero = new Graphics();
    world.addChild(hero);
    const mailboxFront = new Graphics()
      .roundRect(5638, 662, 84, 26, 5)
      .fill("#bb7153");
    mailboxFront
      .moveTo(5673, 674)
      .lineTo(5682, 680)
      .lineTo(5691, 674)
      .stroke({ color: "#ffe4b7", width: 2 });
    world.addChild(mailboxFront);
    const foreground = new Container();
    stage.addChild(foreground);
    const nearTrees = [
      { x: 1780, y: 910, s: 1.17 },
      { x: 2980, y: 960, s: 1.33 },
    ].map((p) => {
      const g = tree(0, p.y, p.s, true);
      foreground.addChild(g);
      return { ...p, g };
    });
    const birds = new Graphics();
    stage.addChild(birds);
    // Fine stationary paper grain is a material treatment, not per-frame random flicker.
    const grain = document.createElement("canvas");
    grain.width = 800;
    grain.height = 450;
    const gc = grain.getContext("2d")!;
    for (let i = 0; i < 14500; i++) {
      gc.fillStyle =
        rand() > 0.5 ? "rgba(51,65,53,.045)" : "rgba(255,253,230,.13)";
      gc.fillRect(rand() * 800, rand() * 450, 1, 1);
    }
    const gt = Texture.from(grain);
    owned.push(gt);
    const paper = new Sprite(gt);
    paper.width = 1600;
    paper.height = 900;
    stage.addChild(paper);
    return {
      canvas: app.canvas as HTMLCanvasElement,
      render(time) {
        const t = clamp(time, 0, 32),
          p = flight(t),
          arrival = smooth(phase(t, 26, 32));
        const zoom = cameraCurve(t, [
          [0, 1.09],
          [4, 1.22],
          [10, 1.19],
          [17, 1.05],
          [23, 1.17],
          [27.8, 1.35],
          [32, 0.94],
        ]);
        const follow = smooth(phase(t, 1.2, 4.8));
        const cx = mix(800, p.x + 130 - 220 * arrival, follow),
          cy = cameraCurve(t, [
            [0, 458],
            [8, 418],
            [15, 409],
            [22, 434],
            [28, 497],
            [32, 485],
          ]);
        world.position.set(800, 450);
        world.pivot.set(cx, cy);
        world.scale.set(zoom);
        far.x = -(cx - 800) * 0.2;
        far.y = -smooth(phase(t, 14, 23)) * 68;
        far.alpha = 1 - smooth(phase(t, 14, 21)) * 0.72;
        clouds.forEach((s, i) => {
          s.x = ((i * 296 + t * (2 + (i % 3)) - cx * 0.12 + 4500) % 3450) - 420;
          s.y = 52 + (i % 4) * 77 + Math.sin(t * 0.17 + i) * 7;
        });
        waves.clear();
        for (let i = 0; i < 90; i++) {
          const x = 2800 + ((i * 147 + t * (3 + (i % 3))) % 4050),
            y = 610 + (i % 14) * 31;
          const a = 0.12 + (1 + Math.sin(i * 2.3 + t * 0.9)) * 0.075;
          waves
            .moveTo(x, y)
            .quadraticCurveTo(x + 25, y - 3, x + 60 + (i % 3) * 18, y)
            .stroke({
              color: i % 3 ? "#e4deba" : "#3c827a",
              width: 1.4 + (i % 3) * 0.6,
              alpha: a,
            });
        }
        // Sea shimmer follows the sun, not the camera; it anchors the depth of the bay.
        for (let i = 0; i < 25; i++) {
          const x = 4460 + Math.sin(i * 7 + t * 0.6) * (45 + i * 5),
            y = 614 + i * 10;
          waves
            .moveTo(x, y)
            .lineTo(x + 24 + i * 3, y)
            .stroke({
              color: "#ffe0a7",
              width: 2.4,
              alpha: 0.11 + Math.sin(i + t) * 0.04,
            });
        }
        trails.clear();
        if (t > 2 && t < 27.8) {
          for (let j = 0; j < 2; j++) {
            const q = flight(Math.max(0, t - 0.7));
            trails.moveTo(q.x - 28, q.y + 10 * j);
            for (let k = 12; k >= 0; k--) {
              const q2 = flight(t - k * 0.055);
              trails.lineTo(q2.x - 36, q2.y + j * 10);
            }
            trails.stroke({
              color: "#fff4d9",
              width: 1.6 - j * 0.5,
              alpha: 0.29 - j * 0.11,
            });
          }
        }
        const before = flight(Math.max(0, t - 0.035)),
          after = flight(Math.min(32, t + 0.035));
        const folding = smooth(phase(t, 27.6, 28.45));
        hero.clear();
        hero.position.set(p.x, p.y);
        hero.rotation = mix(
          Math.atan2(after.y - before.y, Math.max(0.1, after.x - before.x)) *
            0.68 +
            Math.sin(t * 1.8) * 0.032,
          0,
          folding,
        );
        hero.scale.set(mix(0.95, 0.66, folding));
        hero.visible = t < 29.2;
        const source = [
            [-90, -25],
            [96, 0],
            [-43, 44],
            [-27, 12],
          ],
          target = [
            [-39, -25],
            [39, -25],
            [39, 25],
            [-39, 25],
          ];
        const poly = source.flatMap((v, i) => [
          mix(v[0], target[i][0], folding),
          mix(v[1], target[i][1], folding),
        ]);
        hero
          .poly(poly)
          .fill("#fff9e9")
          .stroke({ color: "#cdb18b", width: 1.6 });
        if (folding < 1) {
          hero
            .poly([-90, -25, 96, 0, -27, 12])
            .fill({ color: "#fffef1", alpha: 1 - folding });
          hero
            .poly([-27, 12, 96, 0, -43, 44])
            .fill({ color: "#d9c7ac", alpha: (1 - folding) * 0.85 });
          hero
            .moveTo(-90, -25)
            .lineTo(-27, 12)
            .lineTo(96, 0)
            .stroke({ color: "#d4bba0", width: 1.2, alpha: 1 - folding });
        }
        if (folding > 0)
          hero
            .moveTo(-39, -25)
            .lineTo(0, 6)
            .lineTo(39, -25)
            .moveTo(-39, 25)
            .lineTo(-8, 0)
            .moveTo(39, 25)
            .lineTo(8, 0)
            .stroke({ color: "#c6ac8d", width: 1.6, alpha: folding });
        hero.poly([14, -10, 30, -8, 24, -2, 10, -4]).fill("#c96b50");
        beam.clear();
        const lit = smooth(phase(t, 28.7, 29.5));
        // A dark glass window becomes a warm beacon only after the letter enters the slot.
        beam
          .roundRect(5748, 437, 64, 33, 1)
          .fill({ color: "#526c67", alpha: 1 - lit });
        if (lit > 0) {
          beam
            .roundRect(5748, 437, 64, 31, 2)
            .fill({ color: "#fff1b5", alpha: lit * 0.86 });
          const yy = 460 + Math.sin((t - 28.7) * 0.25) * 80;
          beam
            .moveTo(5780, 453)
            .lineTo(6690, yy - 145)
            .lineTo(6690, yy + 95)
            .closePath()
            .fill({ color: "#ffe4a3", alpha: lit * 0.16 });
          for (let i = 6; i > 0; i--)
            beam
              .circle(5780, 452, 12 + i * 12)
              .fill({ color: "#ffe8ad", alpha: lit * 0.04 });
        }
        nearTrees.forEach(({ g, x, y, s }) => {
          g.position.set(800 + (x - cx) * 1.2, 450 + (y - cy) * 1.04);
          g.scale.set(s * zoom);
        });
        birds.clear();
        for (let i = 0; i < 6; i++) {
          const x = ((1750 + i * 87 - t * 16 - cx * 0.27 + 5000) % 2200) - 280,
            y = 238 + (i % 3) * 21 + Math.sin(t * 0.75 + i) * 14,
            flap = Math.sin(t * 5 + i) * 6;
          birds
            .moveTo(x - 12, y + flap)
            .quadraticCurveTo(x - 4, y - 3, x, y + 1)
            .quadraticCurveTo(x + 4, y - 3, x + 12, y + flap)
            .stroke({ color: "#576e68", width: 1.9, alpha: 0.58 });
        }
        app.renderer.render(app.stage);
      },
      dispose() {
        app.destroy(true, { children: true, texture: false });
        owned.forEach((texture) => texture.destroy(true));
      },
    };
  } catch (error) {
    app.destroy(true, { children: true, texture: false });
    owned.forEach((texture) => texture.destroy(true));
    throw error;
  }
}
