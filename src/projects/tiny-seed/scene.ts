import { gsap } from "gsap";
import { interpolate } from "flubber";
import type { Scene, SceneOptions } from "../../engine/types";
import { clamp, mix, phase, smooth, seeded } from "../../engine/math";
import { cameraCurve } from "../../engine/camera-curve";

export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const growth = { roots: 0, stem: 0, leaves: 0, flower: 0 };
  const timeline = gsap
    .timeline({ paused: true })
    .to(growth, { roots: 1, duration: 6, ease: "sine.inOut" }, 7)
    .to(growth, { stem: 1, duration: 8, ease: "power2.inOut" }, 10.5)
    .to(growth, { leaves: 1, duration: 5.7, ease: "sine.inOut" }, 14)
    .to(growth, { flower: 1, duration: 4.5, ease: "sine.inOut" }, 19.8);
  const leafMorph = interpolate(
    "M0 0C-4-8 4-12 10-6C15 0 10 6 0 0Z",
    "M0 0C27-75 91-92 155-89C132-18 68 16 0 0Z",
    { maxSegmentLength: 5 },
  );
  const rng = seeded(5129);
  const grit = Array.from({ length: 390 }, () => ({
    x: 295 + rng() * 1010,
    y: 660 + rng() * 165,
    r: 1 + rng() * 3.2,
    a: rng(),
  }));
  const grass = Array.from({ length: 130 }, () => ({
    x: 310 + rng() * 980,
    y: 655 + (rng() - 0.5) * 31,
    h: 10 + rng() * 29,
    b: rng() * 5,
  }));
  const motes = Array.from({ length: 35 }, () => ({
    x: 120 + rng() * 1330,
    y: 120 + rng() * 480,
    r: 0.8 + rng() * 1.5,
    p: rng() * 6.28,
  }));
  const grain = document.createElement("canvas");
  grain.width = 800;
  grain.height = 450;
  const gc = grain.getContext("2d")!;
  for (let i = 0; i < 14000; i++) {
    gc.fillStyle = rng() > 0.5 ? "rgba(45,65,43,.05)" : "rgba(255,251,219,.2)";
    gc.fillRect(rng() * 800, rng() * 450, 1, 1);
  }
  function seed(
    x: number,
    y: number,
    rotation: number,
    scale: number,
    open = 1,
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    const body = ctx.createLinearGradient(-8, 0, 10, 0);
    body.addColorStop(0, "#83583d");
    body.addColorStop(0.48, "#bb9266");
    body.addColorStop(1, "#6e533c");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 7.2, 17.5, 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#e2c28d";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(-1, -12);
    ctx.quadraticCurveTo(-3, 0, 1, 13);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,252,227,.94)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(0, -52);
    ctx.stroke();
    for (let i = 0; i < 15; i++) {
      const a = Math.PI + (i / 14) * Math.PI,
        xx = Math.cos(a) * 38 * open,
        yy = -52 + Math.sin(a) * 18 * open;
      ctx.beginPath();
      ctx.moveTo(0, -48);
      ctx.lineTo(xx, yy);
      ctx.moveTo(xx - 5, yy - 7);
      ctx.lineTo(xx, yy);
      ctx.lineTo(xx + 5, yy - 7);
      ctx.stroke();
    }
    ctx.restore();
  }
  function leaf(
    x: number,
    y: number,
    side: number,
    size: number,
    g: number,
    t: number,
    i: number,
  ) {
    if (g <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(side * size, size);
    ctx.rotate(0.04 + Math.sin(t * 1.15 + i) * 0.055);
    const shape = new Path2D(leafMorph(clamp(g)));
    const color = ctx.createLinearGradient(0, 0, 110, -80);
    color.addColorStop(0, "#3d6d50");
    color.addColorStop(0.48, "#6d975e");
    color.addColorStop(1, "#a4b56a");
    ctx.fillStyle = color;
    ctx.fill(shape);
    ctx.strokeStyle = "rgba(202,212,141,.7)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(69 * g, -30 * g, 143 * g, -82 * g);
    ctx.stroke();
    for (let k = 1; k < 6; k++) {
      const x = k * 22 * g,
        y = -k * 11 * g;
      ctx.strokeStyle = "rgba(180,201,131,.43)";
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 5 * g, y - 13 * g, x + 9 * g, y - 31 * g);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 28 * g, y + 1 * g);
      ctx.stroke();
    }
    const dew = (1 - smooth(phase(t, 17, 24))) * g;
    if (dew > 0) {
      ctx.fillStyle = `rgba(239,249,218,${dew * 0.55})`;
      ctx.beginPath();
      ctx.ellipse(94 * g, -61 * g, 4 * g, 5.5 * g, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,237,${dew * 0.8})`;
      ctx.beginPath();
      ctx.arc(93 * g, -63 * g, 1.4 * g, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  function bee(
    x: number,
    y: number,
    rotation: number,
    landed: number,
    t: number,
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(0.88, 0.88);
    ctx.strokeStyle = "#5c5140";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-8 + i * 9, 7);
      ctx.lineTo(-12 + i * 10, 19 + landed * 3);
      ctx.lineTo(-6 + i * 10, 21 + landed * 3);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(223,237,224,.78)";
    ctx.strokeStyle = "rgba(157,184,174,.65)";
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.rotate(
        side * (0.3 + (0.18 + 0.4 * Math.abs(Math.sin(t * 58))) * (1 - landed)),
      );
      ctx.beginPath();
      ctx.ellipse(side * 9, -18, 10, 21, side * 0.52, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    const fuzz = ctx.createLinearGradient(-20, -12, 20, 15);
    fuzz.addColorStop(0, "#f5dc83");
    fuzz.addColorStop(1, "#bb8d3e");
    ctx.fillStyle = fuzz;
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "#5c5441";
    ctx.lineWidth = 5;
    for (const xx of [-10, 1, 12]) {
      ctx.beginPath();
      ctx.moveTo(xx, -15);
      ctx.quadraticCurveTo(xx - 3, 0, xx, 15);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "#4e5141";
    ctx.beginPath();
    ctx.arc(20, -1, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff8d9";
    ctx.beginPath();
    ctx.arc(23, -4, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4e5141";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(22, -7);
    ctx.quadraticCurveTo(21, -15, 27, -16);
    ctx.moveTo(17, -8);
    ctx.quadraticCurveTo(13, -17, 18, -19);
    ctx.stroke();
    ctx.restore();
  }
  return {
    canvas,
    render(time) {
      const t = clamp(time, 0, 36);
      timeline.seek(t, true);
      ctx.setTransform(width / 1600, 0, 0, height / 900, 0, 0);
      ctx.clearRect(0, 0, 1600, 900);
      const rain = smooth(phase(t, 5, 6.5)) * (1 - smooth(phase(t, 10.5, 12))),
        summer = smooth(phase(t, 16, 24));
      const background = ctx.createLinearGradient(0, 0, 0, 900);
      background.addColorStop(0, "#b7cdc1");
      background.addColorStop(0.62, "#e4e6c9");
      background.addColorStop(1, "#eae0bd");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1600, 900);
      ctx.fillStyle = `rgba(113,149,164,${rain * 0.22})`;
      ctx.fillRect(0, 0, 1600, 900);
      ctx.fillStyle = `rgba(247,212,148,${summer * 0.1})`;
      ctx.fillRect(0, 0, 1600, 900);
      const sun = ctx.createRadialGradient(1180, 145, 10, 1180, 145, 450);
      sun.addColorStop(0, `rgba(255,246,191,${0.8 - rain * 0.6})`);
      sun.addColorStop(1, "rgba(255,243,183,0)");
      ctx.fillStyle = sun;
      ctx.fillRect(650, 0, 950, 800);
      // Defocused meadow silhouettes move more slowly than the hero, instead of decorative diagram rings.
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.filter = "blur(9px)";
      ctx.fillStyle = "#6e9c74";
      for (let i = 0; i < 14; i++) {
        const x = -140 + i * 146 + Math.sin(t * 0.12) * 12,
          yy = 725 + Math.sin(i * 2) * 22;
        ctx.beginPath();
        ctx.moveTo(x, 950);
        ctx.quadraticCurveTo(x - 20, yy - 110, x + 30, yy - 210 - (i % 3) * 42);
        ctx.quadraticCurveTo(x + 49, yy - 80, x + 70, 950);
        ctx.fill();
      }
      ctx.restore();
      const camX = cameraCurve(t, [
        [0, 760],
        [6, 790],
        [12, 800],
        [20, 804],
        [26, 816],
        [30, 847],
        [36, 910],
      ]);
      const camY = cameraCurve(t, [
        [0, 426],
        [6, 618],
        [11, 608],
        [16, 481],
        [21, 394],
        [26, 339],
        [30, 368],
        [36, 460],
      ]);
      const zoom = cameraCurve(t, [
        [0, 1.09],
        [6, 1.77],
        [11, 1.8],
        [16, 1.46],
        [21, 1.5],
        [26, 1.83],
        [30, 1.54],
        [36, 1.02],
      ]);
      ctx.save();
      ctx.translate(800, 450);
      ctx.scale(zoom, zoom);
      ctx.translate(-camX, -camY);
      ctx.fillStyle = "rgba(61,84,56,.09)";
      ctx.beginPath();
      ctx.ellipse(800, 843, 483, 19, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(305, 669);
      ctx.bezierCurveTo(338, 863, 1262, 863, 1295, 669);
      ctx.closePath();
      const soil = ctx.createLinearGradient(0, 657, 0, 833);
      soil.addColorStop(0, "#92724c");
      soil.addColorStop(0.43, "#715640");
      soil.addColorStop(1, "#514b3b");
      ctx.fillStyle = soil;
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = `rgba(36,65,59,${rain * 0.11})`;
      ctx.fillRect(280, 653, 1060, 190);
      for (let i = 0; i < 5; i++) {
        ctx.strokeStyle = `rgba(198,163,105,${0.1 + i * 0.017})`;
        ctx.lineWidth = 8 - i;
        ctx.beginPath();
        ctx.moveTo(290, 692 + i * 29);
        ctx.bezierCurveTo(
          620,
          683 + i * 28,
          1010,
          727 + i * 23,
          1300,
          680 + i * 28,
        );
        ctx.stroke();
      }
      for (const p of grit) {
        ctx.fillStyle =
          p.a > 0.48 ? "rgba(209,178,122,.65)" : "rgba(51,50,35,.46)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r * 1.4, p.r * 0.65, p.a * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (growth.roots > 0) {
        for (let i = 0; i < 11; i++) {
          const g = clamp(growth.roots * 1.45 - i * 0.044),
            spread = (i - 5) * 37,
            depth = 97 + (i % 3) * 12;
          const point = (u: number) => ({
            x:
              800 +
              spread * (u * u * 0.7 + u * 0.3) +
              Math.sin(u * 6 + i) * 4 * u,
            y: 666 + depth * u,
          });
          ctx.strokeStyle = i === 5 ? "#eed7a0" : "#d9c18b";
          ctx.lineWidth = i === 5 ? 3.3 : 1.9;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(800, 665);
          for (let k = 1; k <= 24; k++) {
            const q = point((g * k) / 24);
            ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
          for (let k = 1; k < 5; k++) {
            const at = k * 0.19,
              branch = clamp((g - at) * 3.1);
            if (!branch) continue;
            const q = point(at),
              dir = i < 5 ? -1 : 1;
            ctx.strokeStyle = "#ccb788";
            ctx.lineWidth = 0.85;
            ctx.beginPath();
            ctx.moveTo(q.x, q.y);
            ctx.quadraticCurveTo(
              q.x + dir * 13 * branch,
              q.y + 5 * branch,
              q.x + dir * (22 + k * 2) * branch,
              q.y + (13 - k) * branch,
            );
            ctx.stroke();
          }
          const q = point(g);
          ctx.fillStyle = "rgba(246,230,179,.7)";
          ctx.beginPath();
          ctx.arc(q.x, q.y, 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      const turf = ctx.createLinearGradient(0, 628, 0, 693);
      turf.addColorStop(0, "#a7b984");
      turf.addColorStop(0.5, "#77995f");
      turf.addColorStop(1, "#507a50");
      ctx.fillStyle = turf;
      ctx.beginPath();
      ctx.ellipse(800, 663, 495, 31, 0, 0, Math.PI * 2);
      ctx.fill();
      // Shallow irregular growing patch, a small shadow and rain ripples reveal contact with the soil.
      ctx.fillStyle = "rgba(52,66,39,.19)";
      ctx.beginPath();
      ctx.ellipse(800, 659, 22, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const g of grass) {
        if (Math.abs(g.x - 800) < 36) continue;
        ctx.strokeStyle = g.b > 2.5 ? "#5c824f" : "#799b5f";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.quadraticCurveTo(
          g.x + Math.sin(t * 1.3 + g.b) * 4,
          g.y - g.h * 0.6,
          g.x - 5 + Math.sin(t * 1.3 + g.b) * 7,
          g.y - g.h,
        );
        ctx.stroke();
      }
      if (rain > 0) {
        ctx.strokeStyle = `rgba(234,241,210,${rain * 0.48})`;
        ctx.lineWidth = 1;
        for (let i = 0; i < 11; i++) {
          const age = (t * 1.9 + i * 0.71) % 1;
          ctx.globalAlpha = 1 - age;
          ctx.beginPath();
          ctx.ellipse(
            423 + i * 67,
            659 + Math.sin(i) * 13,
            age * 13 + 1,
            age * 3 + 1,
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (t < 7.7) {
        const falling = smooth(phase(t, 0, 5.8)),
          buried = smooth(phase(t, 5.8, 7.7));
        seed(
          mix(610, 800, falling) + Math.sin(falling * Math.PI * 3) * 34,
          mix(138, 658, falling) + buried * 13,
          Math.sin(t * 1.4) * 0.19 * (1 - falling),
          mix(1.0, 0.67, falling) * (1 - buried * 0.83),
          1 - buried * 0.5,
        );
      }
      if (rain > 0) {
        ctx.save();
        ctx.globalAlpha = rain * 0.64;
        ctx.strokeStyle = "#83aab0";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        for (let i = 0; i < 64; i++) {
          const x = 425 + ((i * 71) % 740),
            yy = 185 + ((t * 285 + i * 47) % 470);
          ctx.beginPath();
          ctx.moveTo(x, yy);
          ctx.lineTo(x - 4, yy + 17);
          ctx.stroke();
        }
        ctx.restore();
      }
      const stemH = growth.stem * 356,
        sway = Math.sin(t * 1.21) * 6.5 * growth.stem,
        fx = 800 + sway,
        fy = 659 - stemH;
      if (growth.stem > 0.0001) {
        const stem = ctx.createLinearGradient(786, 0, 812, 0);
        stem.addColorStop(0, "#386a46");
        stem.addColorStop(0.55, "#749749");
        stem.addColorStop(1, "#a3b563");
        ctx.strokeStyle = stem;
        ctx.lineWidth = 10;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(800, 658);
        ctx.bezierCurveTo(
          789,
          645 - stemH * 0.25,
          812 + sway,
          643 - stemH * 0.74,
          fx,
          fy,
        );
        ctx.stroke();
        ctx.strokeStyle = "rgba(192,208,128,.42)";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(802, 652);
        ctx.bezierCurveTo(
          792,
          640 - stemH * 0.25,
          813 + sway,
          643 - stemH * 0.74,
          fx + 1,
          fy,
        );
        ctx.stroke();
      }
      for (let i = 0; i < 5; i++) {
        const g = clamp(growth.leaves * 1.6 - i * 0.17);
        leaf(
          800 + sway * (i / 5),
          611 - i * 48,
          i % 2 ? -1 : 1,
          0.98 - i * 0.095,
          g,
          t,
          i,
        );
      }
      const mature = smooth(phase(t, 28.8, 31.5));
      if (growth.stem > 0.7) {
        const bloom = clamp(growth.flower);
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(Math.sin(t * 0.73) * 0.028);
        // Dandelion-like petals and later pappus belong to the same stylised plant.
        for (let ring = 0; ring < 3; ring++)
          for (let i = 0; i < 25; i++) {
            const a = (i / 25) * Math.PI * 2 + ring * 0.12,
              g = clamp(bloom * 1.5 - ring * 0.18 - i * 0.003),
              len = (88 - ring * 17) * g * (1 - mature * 0.98);
            ctx.save();
            ctx.rotate(a);
            const petal = ctx.createLinearGradient(0, -8, 0, -len);
            petal.addColorStop(0, "#ddb343");
            petal.addColorStop(0.42, ring === 2 ? "#ffdd75" : "#eabc50");
            petal.addColorStop(1, "#fff0a5");
            ctx.fillStyle = petal;
            ctx.beginPath();
            ctx.moveTo(-4, -4);
            ctx.bezierCurveTo(
              -17 * g,
              -len * 0.45,
              -13 * g,
              -len * 0.89,
              -3 * g,
              -len,
            );
            ctx.lineTo(0, -len + 3);
            ctx.lineTo(4 * g, -len - 2);
            ctx.bezierCurveTo(15 * g, -len * 0.83, 15 * g, -len * 0.33, 4, -4);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        ctx.fillStyle = "#ad9b46";
        ctx.beginPath();
        ctx.ellipse(
          0,
          3,
          13 * (1 - bloom * 0.5),
          17 * (1 - bloom * 0.5),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        if (mature > 0) {
          ctx.fillStyle = "rgba(104,133,101," + mature * 0.07 + ")";
          ctx.beginPath();
          ctx.arc(0, 0, 76 * mature, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowColor = "rgba(67,100,73,.25)";
          ctx.shadowBlur = 1;
          for (let i = 0; i < 145; i++) {
            const a = i * 2.399963,
              r = Math.sqrt(i / 145) * 77 * mature,
              xx = Math.cos(a) * r,
              yy = Math.sin(a) * r,
              alpha = (0.58 + (0.37 * (i % 3)) / 2) * mature;
            ctx.strokeStyle = `rgba(255,254,235,${alpha})`;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(0, 2);
            ctx.lineTo(xx, yy);
            ctx.stroke();
            for (let k = 0; k < 5; k++) {
              const b = (k / 5) * Math.PI * 2;
              ctx.beginPath();
              ctx.moveTo(xx, yy);
              ctx.lineTo(
                xx + Math.cos(b) * 9 * mature,
                yy + Math.sin(b) * 9 * mature,
              );
              ctx.stroke();
            }
            if (i % 6 === 0) {
              ctx.fillStyle = `rgba(255,255,239,${mature * 0.8})`;
              ctx.beginPath();
              ctx.arc(xx, yy, 0.9, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }
      if (t >= 23.8 && t <= 32) {
        const bx = cameraCurve(t, [
          [23.8, 1510],
          [25.1, 1070],
          [26.2, 838],
          [28.1, 830],
          [29.0, 858],
          [30.3, 1100],
          [32, 1620],
        ]);
        const by = cameraCurve(t, [
          [23.8, 265],
          [25.1, 248],
          [26.2, fy - 23],
          [28.1, fy - 21],
          [29, fy - 30],
          [30.3, 226],
          [32, 165],
        ]);
        const landing =
          smooth(phase(t, 26.0, 26.6)) * (1 - smooth(phase(t, 28.2, 29.1)));
        const hover = Math.sin(t * 10) * 3 * (1 - landing);
        bee(
          bx,
          by + hover,
          Math.sin(t * 2.1) * 0.08 * (1 - landing) - 0.15,
          landing,
          t,
        );
        if (t > 26.4 && t < 29.2) {
          for (let i = 0; i < 9; i++) {
            const p = phase(t, 26.4 + i * 0.09, 29.2);
            ctx.fillStyle = `rgba(229,188,77,${Math.sin(p * Math.PI) * 0.52})`;
            ctx.beginPath();
            ctx.arc(
              fx + (i - 4) * 7 + p * 18,
              fy + 8 + Math.sin(p * 4 + i) * 15 + p * 37,
              1.8,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        }
      }
      if (t > 30.55) {
        const p = smooth(phase(t, 30.55, 36));
        seed(
          fx + 32 + 535 * p,
          fy - 42 - 130 * Math.sin(p * Math.PI * 0.8),
          -0.15 + Math.sin(t * 1.2) * 0.15,
          0.61,
        );
      }
      for (const m of motes) {
        const visible = smooth(phase(t, 12, 19));
        ctx.fillStyle = `rgba(250,243,188,${visible * 0.43})`;
        ctx.beginPath();
        ctx.arc(
          m.x + Math.sin(t * 0.22 + m.p) * 19,
          m.y + Math.sin(t * 0.3 + m.p) * 12,
          m.r,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
      ctx.drawImage(grain, 0, 0, 1600, 900);
      const vignette = ctx.createRadialGradient(800, 430, 270, 800, 430, 920);
      vignette.addColorStop(0, "rgba(73,89,60,0)");
      vignette.addColorStop(1, "rgba(73,89,60,.11)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, 1600, 900);
    },
    dispose() {
      timeline.kill();
      canvas.width = 1;
      canvas.height = 1;
      grain.width = 1;
      grain.height = 1;
    },
  };
}
