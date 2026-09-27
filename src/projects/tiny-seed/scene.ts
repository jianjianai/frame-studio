import { gsap } from "gsap";
import { interpolate } from "flubber";
import type { Scene, SceneOptions } from "../../engine/types";
import { clamp, mix, phase, smooth, seeded } from "../../engine/math";
export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const state = { roots: 0, stem: 0, leaves: 0, flower: 0 };
  const timeline = gsap
    .timeline({ paused: true })
    .to(state, { roots: 1, duration: 6, ease: "sine.inOut" }, 8)
    .to(state, { stem: 1, duration: 8, ease: "power2.inOut" }, 11)
    .to(state, { leaves: 1, duration: 6, ease: "sine.inOut" }, 15)
    .to(state, { flower: 1, duration: 5, ease: "back.out(1.25)" }, 20);
  const morphLeaf = interpolate(
    "M0 0C-4-8 4-12 10-6C15 0 10 6 0 0Z",
    "M0 0C25-90 113-108 157-101C146-41 92 17 0 0Z",
    { maxSegmentLength: 6 },
  );
  const rand = seeded(42);
  const specks = Array.from({ length: 160 }, () => ({
    x: 310 + rand() * 1000,
    y: 649 + rand() * 157,
    r: 1 + rand() * 3,
  }));
  const leaf = (
    x: number,
    y: number,
    rot: number,
    s: number,
    growth: number,
    color: string,
  ) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(s, s);
    const d = new Path2D(morphLeaf(clamp(growth)));
    ctx.fillStyle = color;
    ctx.fill(d);
    ctx.strokeStyle = "#8eb49b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(69 * growth, -28 * growth, 141 * growth, -91 * growth);
    ctx.stroke();
    ctx.restore();
  };
  const drawSeed = (
    x: number,
    y: number,
    angle: number,
    scale: number,
    parachute = true,
  ) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#8c553b";
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 21, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d6ab77";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(2, 12);
    ctx.stroke();
    if (parachute) {
      ctx.strokeStyle = "#fffdf0";
      ctx.lineWidth = 2;
      for (let i = 0; i < 11; i++) {
        const a = Math.PI + (i / 10) * Math.PI;
        const ex = Math.cos(a) * 45,
          ey = -47 + Math.sin(a) * 27;
        ctx.beginPath();
        ctx.moveTo(0, -18);
        ctx.lineTo(0, -49);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex - 6, ey - 5);
        ctx.lineTo(ex, ey);
        ctx.lineTo(ex + 6, ey - 5);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  return {
    canvas,
    render(time) {
      const t = clamp(time, 0, 36);
      timeline.seek(t, true);
      ctx.setTransform(width / 1600, 0, 0, height / 900, 0, 0);
      ctx.clearRect(0, 0, 1600, 900);
      const bg = ctx.createLinearGradient(0, 0, 0, 900);
      bg.addColorStop(0, "#dfebe0");
      bg.addColorStop(1, "#f1eddb");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1600, 900);
      const lightX = 1150 + Math.sin(t * 0.08) * 100;
      const sun = ctx.createRadialGradient(lightX, 180, 15, lightX, 180, 250);
      sun.addColorStop(0, "#fff2c4");
      sun.addColorStop(1, "rgba(255,244,203,0)");
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, 1600, 650);
      ctx.save();
      ctx.globalAlpha = 0.27;
      ctx.strokeStyle = "#b3cbbb";
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.ellipse(
          800,
          550,
          470 + i * 20,
          310 + i * 13,
          0,
          Math.PI,
          Math.PI * 2,
        );
        ctx.stroke();
      }
      ctx.restore();
      // A visible soil cross-section makes rainfall -> roots -> growth readable without words.
      ctx.fillStyle = "rgba(63,89,68,.08)";
      ctx.beginPath();
      ctx.ellipse(800, 828, 480, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(307, 650);
      ctx.bezierCurveTo(340, 850, 1260, 850, 1293, 650);
      ctx.closePath();
      ctx.fillStyle = "#73533d";
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#906746";
      ctx.beginPath();
      ctx.ellipse(800, 660, 540, 80, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const p of specks) {
        ctx.fillStyle = p.r > 2.5 ? "#c09a68" : "#533f35";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r * 1.8, p.r, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (state.roots > 0) {
        ctx.lineCap = "round";
        for (let i = 0; i < 11; i++) {
          const spread = (i - 5) * 45;
          const length = 76 + (i % 3) * 20;
          ctx.strokeStyle = i % 2 ? "#dbbb8a" : "#e9cea2";
          ctx.lineWidth = i === 5 ? 4 : 2.2;
          ctx.setLineDash([420 * state.roots, 900]);
          ctx.beginPath();
          ctx.moveTo(800, 655);
          ctx.bezierCurveTo(
            800 + spread * 0.24,
            690,
            800 + spread * 0.5,
            730,
            800 + spread,
            655 + length,
          );
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.restore();
      ctx.fillStyle = "#668b65";
      ctx.beginPath();
      ctx.ellipse(800, 650, 493, 39, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#86a576";
      ctx.beginPath();
      ctx.ellipse(800, 640, 472, 31, 0, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 52; i++) {
        const x = 360 + i * 17;
        const y = 642 + Math.sin(i * 1.7) * 14;
        if (Math.abs(x - 800) < 40) continue;
        ctx.strokeStyle = i % 2 ? "#638651" : "#567c57";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.sin(t + i) * 5, y - 12, x - 3, y - 18);
        ctx.stroke();
      }
      if (t < 7) {
        const p = smooth(phase(t, 0, 6));
        drawSeed(
          mix(510, 800, p) + Math.sin(p * Math.PI * 3) * 35,
          mix(145, 665, p),
          Math.sin(t * 1.6) * 0.2 * (1 - p),
          mix(1.1, 0.7, p),
        );
      }
      const rain = smooth(phase(t, 5, 7)) * (1 - smooth(phase(t, 10, 12)));
      if (rain > 0) {
        ctx.save();
        ctx.globalAlpha = rain * 0.7;
        ctx.strokeStyle = "#7dacad";
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        for (let i = 0; i < 56; i++) {
          const x = 435 + ((i * 71) % 740);
          const y = 200 + ((t * 220 + i * 43) % 440);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y + 21);
          ctx.stroke();
        }
        ctx.restore();
      }
      const stemHeight = state.stem * 382;
      const sway = Math.sin(t * 1.5) * 9 * state.stem;
      ctx.strokeStyle = "#477353";
      ctx.lineWidth = 15;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(800, 641);
      ctx.bezierCurveTo(
        780,
        620 - stemHeight * 0.3,
        826 + sway,
        620 - stemHeight * 0.7,
        800 + sway,
        641 - stemHeight,
      );
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const g = clamp(state.leaves * 1.7 - i * 0.21);
        const y = 580 - i * 62;
        if (g <= 0) continue;
        const side = i % 2 === 0 ? -1 : 1;
        ctx.save();
        ctx.translate(801 + sway * (i / 4), y);
        ctx.scale(side, 1);
        leaf(
          0,
          0,
          0.15 + Math.sin(t * 1.3 + i) * 0.07,
          0.8 - i * 0.06,
          g,
          i % 2 ? "#648f67" : "#416f57",
        );
        ctx.restore();
      }
      const flowerX = 800 + sway,
        flowerY = 641 - stemHeight;
      if (state.stem > 0.75) {
        const bloom = clamp(state.flower, 0, 1.08);
        ctx.save();
        ctx.translate(flowerX, flowerY);
        ctx.rotate(Math.sin(t * 0.7) * 0.04);
        for (let i = 0; i < 16; i++) {
          ctx.save();
          ctx.rotate((i / 16) * Math.PI * 2 + 0.12);
          ctx.translate(0, -18 * bloom);
          ctx.scale(Math.max(0.08, bloom), Math.max(0.08, bloom));
          ctx.fillStyle = i % 2 ? "#e9bb56" : "#f5d17a";
          ctx.beginPath();
          ctx.moveTo(-13, -8);
          ctx.bezierCurveTo(-46, -38, -24, -98, 0, -105);
          ctx.bezierCurveTo(29, -85, 43, -37, 13, -8);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = "#725033";
        ctx.beginPath();
        ctx.arc(0, 0, 15 + 27 * bloom, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ad864d";
        for (let i = 0; i < 76; i++) {
          const a = i * 2.39996,
            r = Math.sqrt(i) * 3.8 * bloom;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (t >= 24 && t < 33) {
        const p = phase(t, 24, 33);
        const a = p * Math.PI * 2.5;
        const radius = 160 * (1 - Math.sin(p * Math.PI) * 0.65);
        const x = flowerX + Math.cos(a) * radius,
          y = flowerY - 14 + Math.sin(a) * 65;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.cos(a) * 0.25);
        ctx.fillStyle = "#d1e9e5";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(
            s * 9,
            -15,
            10,
            18 * (0.4 + Math.abs(Math.sin(t * 37)) * 0.6),
            s * 0.65,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.fillStyle = "#e3b34f";
        ctx.beginPath();
        ctx.ellipse(0, 0, 23, 14, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = "#494f42";
        ctx.lineWidth = 6;
        for (const x of [-9, 4, 16]) {
          ctx.beginPath();
          ctx.moveTo(x, -17);
          ctx.lineTo(x, 17);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = "#364a41";
        ctx.beginPath();
        ctx.arc(22, -1, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff7de";
        ctx.beginPath();
        ctx.arc(24, -4, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (t > 30) {
        const p = smooth(phase(t, 30, 36));
        drawSeed(
          flowerX + 400 * p,
          flowerY - 120 * Math.sin(p * Math.PI),
          p * 0.3,
          0.7,
        );
      }
    },
    dispose() {
      timeline.kill();
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
