import { describe, expect, it } from "vitest";
import { MotionTrack, analyzeMotion, motionText, motionChart } from "../server/motion.mjs";

// Frames of a textured world seen through a moving window (analysis size, like the renderer's).
const W = 180,
  H = 320,
  fps = 30;
const world = (x, y) => 128 + 50 * Math.sin(x * 0.07) * Math.cos(y * 0.05) + 40 * Math.sin((x + 2 * y) * 0.031) + 30 * Math.cos((x - y) * 0.11);
function view(cx, cy = 0, zoom = 1, paint) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let value = world(cx + (x - W / 2) / zoom, cy + (y - H / 2) / zoom);
      if (paint) value = paint(x, y, value);
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  return out;
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const analyse = (frames) => {
  const track = new MotionTrack({ width: W, height: H, design: { width: 1080, height: 1920 }, fps });
  frames.forEach((luma, index) => track.add({ time: index / fps, luma, ms: 1 }));
  return analyzeMotion(track);
};
const kinds = (analysis) => analysis.events.map((event) => `${event.kind}@${event.time.toFixed(2)}`);

describe("motion analysis", () => {
  it("measures a pan in the work's pixels and finds nothing wrong with an eased one", () => {
    // 60 analysis pixels in one second, eased in and out: 360 design pixels.
    const frames = [...Array.from({ length: 31 }, (_, index) => view(60 * ease(index / 30))), ...Array.from({ length: 5 }, () => view(60))];
    const analysis = analyse(frames);
    expect(analysis.events).toEqual([]);
    expect(analysis.moves).toHaveLength(1);
    const [move] = analysis.moves;
    // The slow ends of the ease read as standing still; the move is the rest of the 360 pixels.
    expect(move.distance).toBeGreaterThan(320);
    expect(move.distance).toBeLessThan(370);
    // The window moves right, so the picture moves left.
    expect(Math.abs(move.direction)).toBeCloseTo(Math.PI, 1);
    expect(move).toMatchObject({ from: null, to: null, speedUp: null, slowDown: null });
    expect(motionText(analysis, { design: { width: 1080, height: 1920 } }).join("\n")).toMatch(
      /往 ← 移 3\d\d px，最快 \d{3,4} px\/s（0:00\.\d\d，\d\.\d 个画面宽\/秒）：缓入；缓出/,
    );
  });

  it("finds starts and stops without easing, one-frame jumps, pops, holds, repeats and cuts", () => {
    const frames = [];
    for (let index = 0; index < 150; index++) {
      const t = index / fps;
      let cx = t < 1 ? 0 : t < 2 ? 50 * (t - 1) : 50;
      if (index === 70) cx += 12; // one frame out of place
      const paint = t >= 2.8 && t < 3.6 ? (x, y, value) => (x > 20 && x < 50 && y > 30 && y < 60 ? 255 : value) : undefined;
      // A cut at 4 s to another place that moves on twos.
      frames.push(t < 4 ? view(cx, 0, 1, paint) : view(600 + 4 * Math.floor((index - 120) / 2), 300));
    }
    const analysis = analyse(frames);
    const found = kinds(analysis);
    // One still second before the pan is a beat, not a hold.
    expect(found.some((item) => item.startsWith("hold"))).toBe(false);
    expect(found).toContain("jump@2.33");
    expect(found).toContain("pop@2.80");
    expect(found.some((item) => item.startsWith("repeat@4."))).toBe(true);
    expect(analysis.cuts.map((time) => time.toFixed(2))).toEqual(["4.00"]);
    const [pan] = analysis.moves;
    expect(pan.speedUp).toMatchObject({ start: true, time: 1 });
    expect(pan.slowDown).toMatchObject({ stop: true });
    expect(pan.start).toBeCloseTo(1, 2);
    expect(pan.end).toBeCloseTo(2, 2);
    expect(pan.peak).toBeLessThan(330); // the jump is not part of it
    const text = motionText(analysis, { design: { width: 1080, height: 1920 } }).join("\n");
    expect(text).toMatch(/- 0:01\.00–0:02\.00（1\.00 秒）往 ← 移 30\d px，最快 30\d px\/s/);
    expect(text).toMatch(/起步突然：第一帧就到 30\d px\/s，没有缓入；停得突然：最后一帧还有 30\d px\/s，没有缓出/);
    expect(text).toContain("0:02.33 单帧跳动：整个画面跳开 72 px，下一帧又回来");
    expect(text).toContain("切换（或一闪、很快的甩镜）：0:04.00");
    expect(text).toMatch(/0:04\.\d\d–0:0\d\.\d\d 有 \d+ 帧和前一帧一模一样/);
  });

  it("tells a shake from jumps, and a wobble from a move", () => {
    // A phone that buzzes: out and back three times, a still frame between.
    const offsets = [0, 0, 0, 3, 0, 0, -3, 0, 0, 3, 0, 0, 0, 0];
    const analysis = analyse(offsets.map((dx) => view(40 + dx)));
    expect(kinds(analysis)).toEqual(["shake@0.07"]);
    expect(analysis.moves).toEqual([]);
    expect(motionText(analysis, { design: { width: 1080, height: 1920 } }).join("\n")).toContain("画面来回抖动（一帧最多晃 18 px");
  });

  it("names holds of a second and a half and more, unless something changes in them", () => {
    const still = Array.from({ length: 60 }, () => view(0));
    const moving = Array.from({ length: 10 }, (_, index) => view(4 * index));
    expect(kinds(analyse([...still, ...moving]))).toEqual(["hold@0.00"]);
    const flash = still.map((frame, index) => (index === 30 ? view(0, 0, 1, (x, y, value) => (x < 40 && y < 40 ? 255 : value)) : frame));
    expect(kinds(analyse([...flash, ...moving])).filter((item) => item.startsWith("hold"))).toEqual([]);
  });

  it("draws the curves with a row of frames", async () => {
    const frames = Array.from({ length: 31 }, (_, index) => view(2 * index));
    const analysis = analyse(frames);
    const sharp = (await import("sharp")).default;
    const thumb = await sharp({ create: { width: 180, height: 320, channels: 3, background: "#456" } })
      .png()
      .toBuffer();
    const chart = await motionChart(analysis, {
      start: 0,
      end: 1,
      thumbs: [
        { time: 0, png: thumb },
        { time: 1, png: thumb },
      ],
    });
    const meta = await sharp(chart).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1000);
  });
});
