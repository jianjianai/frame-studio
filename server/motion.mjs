import sharp from "sharp";
import { formatTime } from "./render.mjs";

/**
 * Motion of a stretch of a work, from consecutive small frames (8-bit luma): how the picture
 * moves as a whole (pan, zoom, roll: a similarity transform per pair of frames, coarse-to-fine
 * Lucas–Kanade with robust weights, so a few moving things or fixed captions do not drag it),
 * how much moves inside it, cuts, and what makes motion look rough — starts and stops without
 * easing, sudden changes of speed, one-frame jumps, things that change within one frame,
 * frames that repeat while the picture moves, long holds.
 */

const LEVELS = 4;
/** A still picture shorter than this is a beat to read or breathe, not worth a mention. */
const HOLD_SECONDS = 1.5;

/** 1-2-1 blur in both directions: gradients of drawn pictures (hard edges, text) need it. */
function blurred(luma, w, h) {
  const row = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const at = y * w;
    for (let x = 0; x < w; x++) {
      const left = luma[at + (x > 0 ? x - 1 : x)];
      const right = luma[at + (x < w - 1 ? x + 1 : x)];
      row[at + x] = (left + 2 * luma[at + x] + right) / 4;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w,
      here = y * w,
      down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) out[here + x] = (row[up + x] + 2 * row[here + x] + row[down + x]) / 4;
  }
  return out;
}

function half(img, w, h) {
  const hw = w >> 1,
    hh = h >> 1;
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const at = 2 * y * w + 2 * x;
      out[y * hw + x] = (img[at] + img[at + 1] + img[at + w] + img[at + w + 1]) / 4;
    }
  return { img: out, w: hw, h: hh };
}

/** Levels from fine (0) to coarse, each with its gradients. */
export function pyramid(luma, w, h) {
  const levels = [];
  let img = blurred(luma, w, h),
    lw = w,
    lh = h;
  for (let level = 0; level < LEVELS && Math.min(lw, lh) >= 16; level++) {
    const gx = new Float32Array(lw * lh),
      gy = new Float32Array(lw * lh);
    for (let y = 1; y < lh - 1; y++)
      for (let x = 1; x < lw - 1; x++) {
        const at = y * lw + x;
        gx[at] = (img[at + 1] - img[at - 1]) / 2;
        gy[at] = (img[at + lw] - img[at - lw]) / 2;
      }
    levels.push({ img, gx, gy, w: lw, h: lh });
    ({ img, w: lw, h: lh } = half(img, lw, lh));
  }
  return levels;
}

/** Solve the 4×4 system M d = v (Gaussian elimination with pivoting); null when singular. */
function solve4(M, v) {
  const a = [0, 1, 2, 3].map((i) => [M[i * 4], M[i * 4 + 1], M[i * 4 + 2], M[i * 4 + 3], v[i]]);
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-9) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[4] / row[i]);
}

/**
 * The similarity transform that carries frame A onto frame B: content at x (centred
 * coordinates) in A is at [a −b; b a]·x + t in B. Translation in pixels of level 0.
 */
export function align(pa, pb) {
  let a = 1,
    b = 0,
    tx = 0,
    ty = 0;
  const M = new Float64Array(16),
    v = new Float64Array(4);
  const hist = new Uint32Array(256);
  for (let level = pa.length - 1; level >= 0; level--) {
    if (level < pa.length - 1) {
      tx *= 2;
      ty *= 2;
    }
    const A = pa[level],
      B = pb[level];
    const { w, h } = A;
    const cx = (w - 1) / 2,
      cy = (h - 1) / 2;
    const step = level === 0 ? 2 : 1;
    const rounds = level === 0 ? 4 : 8;
    let k = 16;
    for (let round = 0; round < rounds; round++) {
      M.fill(0);
      v.fill(0);
      hist.fill(0);
      let used = 0;
      for (let y = 1; y < h - 1; y += step) {
        const Y = y - cy;
        for (let x = 1; x < w - 1; x += step) {
          const X = x - cx;
          const u = a * X - b * Y + tx + cx,
            q = b * X + a * Y + ty + cy;
          if (u < 0 || q < 0 || u >= w - 1 || q >= h - 1) continue;
          const x0 = u | 0,
            y0 = q | 0,
            fx = u - x0,
            fy = q - y0;
          const i = y0 * w + x0;
          const w00 = (1 - fx) * (1 - fy),
            w10 = fx * (1 - fy),
            w01 = (1 - fx) * fy,
            w11 = fx * fy;
          const value = B.img[i] * w00 + B.img[i + 1] * w10 + B.img[i + w] * w01 + B.img[i + w + 1] * w11;
          const gx = B.gx[i] * w00 + B.gx[i + 1] * w10 + B.gx[i + w] * w01 + B.gx[i + w + 1] * w11;
          const gy = B.gy[i] * w00 + B.gy[i + 1] * w10 + B.gy[i + w] * w01 + B.gy[i + w + 1] * w11;
          const r = value - A.img[y * w + x];
          const size = r < 0 ? -r : r;
          hist[size < 255 ? size | 0 : 255]++;
          // Huber weights: what the transform cannot explain (a figure moving on its own, a
          // caption fixed to the frame) counts less.
          const weight = size <= k ? 1 : k / size;
          const j0 = gx * X + gy * Y,
            j1 = gy * X - gx * Y;
          const J = [j0, j1, gx, gy];
          for (let m = 0; m < 4; m++) {
            const wj = weight * J[m];
            v[m] += wj * r;
            for (let n = m; n < 4; n++) M[m * 4 + n] += wj * J[n];
          }
          used++;
        }
      }
      if (used < 24) break;
      for (let m = 0; m < 4; m++) for (let n = 0; n < m; n++) M[m * 4 + n] = M[n * 4 + m];
      // A little damping keeps flat pictures (a plain sky) from wandering.
      for (let m = 0; m < 4; m++) M[m * 5] += 1e-3 * M[m * 5] + 1e-6 * used;
      const d = solve4(M, v);
      if (!d) break;
      a -= d[0];
      b -= d[1];
      tx -= d[2];
      ty -= d[3];
      let count = 0,
        median = 0;
      for (let bin = 0; bin < 256; bin++) {
        count += hist[bin];
        if (count * 2 >= used) {
          median = bin + 0.5;
          break;
        }
      }
      k = Math.max(2, 1.345 * 1.4826 * median);
      if (Math.abs(d[2]) + Math.abs(d[3]) < 0.01 && Math.abs(d[0]) + Math.abs(d[1]) < 1e-4) break;
    }
  }
  return { a, b, tx, ty };
}

/**
 * How different B is from A: `raw` (mean absolute difference, grey levels), `residual` (the
 * same after moving A by the transform: what moved on its own), `area` (share of the picture
 * the transform does not explain). What comes in at the edges is new, not changed: left out.
 */
export function difference(pa, pb, p) {
  const A = pa[0],
    B = pb[0];
  const { w, h } = A;
  const cx = (w - 1) / 2,
    cy = (h - 1) / 2;
  let raw = 0,
    residual = 0,
    changed = 0,
    inside = 0;
  for (let y = 0; y < h; y++) {
    const Y = y - cy;
    for (let x = 0; x < w; x++) {
      const at = y * w + x;
      const base = A.img[at];
      raw += Math.abs(B.img[at] - base);
      const X = x - cx;
      const u = p.a * X - p.b * Y + p.tx + cx,
        q = p.b * X + p.a * Y + p.ty + cy;
      if (u < 0 || q < 0 || u >= w - 1 || q >= h - 1) continue;
      const x0 = u | 0,
        y0 = q | 0,
        fx = u - x0,
        fy = q - y0,
        i = y0 * w + x0;
      const r = Math.abs(B.img[i] * (1 - fx) * (1 - fy) + B.img[i + 1] * fx * (1 - fy) + B.img[i + w] * (1 - fx) * fy + B.img[i + w + 1] * fx * fy - base);
      residual += r;
      if (r > 24) changed++;
      inside++;
    }
  }
  // Moved (almost) entirely out of view: as different as it gets.
  if (inside < 0.2 * w * h) return { raw: raw / (w * h), residual: raw / (w * h), area: 1 };
  return { raw: raw / (w * h), residual: residual / inside, area: changed / inside };
}

/**
 * Frames come in one by one (`add`); each pair is measured as it arrives. Sizes: `width` ×
 * `height` analysis pixels; `design` the work's picture size the numbers are reported in.
 */
export class MotionTrack {
  constructor({ width, height, design, fps }) {
    Object.assign(this, { width, height, design, fps });
    this.scale = design.width / width;
    this.frames = [];
    this.pairs = [];
    this.previous = null;
  }
  add({ time, luma, ms }) {
    const levels = pyramid(luma, this.width, this.height);
    this.frames.push({ time, ms });
    const previous = this.previous;
    this.previous = { levels, luma };
    if (!previous) return;
    const same =
      Buffer.compare(
        Buffer.from(previous.luma.buffer, previous.luma.byteOffset, previous.luma.byteLength),
        Buffer.from(luma.buffer, luma.byteOffset, luma.byteLength),
      ) === 0;
    const still = { a: 1, b: 0, tx: 0, ty: 0 };
    let p = same ? still : align(previous.levels, levels);
    let diff = same ? { raw: 0, residual: 0, area: 0 } : difference(previous.levels, levels, p);
    // A transform that explains almost none of the change is not motion of the whole picture
    // (a page changing inside a phone, a big element moving on its own): no motion, then.
    if (!same && diff.residual > 0.85 * diff.raw) {
      p = still;
      diff = difference(previous.levels, levels, still);
    }
    const zoom = Math.log(Math.hypot(p.a, p.b));
    this.pairs.push({
      time: this.frames[this.frames.length - 2].time,
      // Design pixels per frame; zoom as log scale per frame; roll in radians per frame.
      dx: p.tx * this.scale,
      dy: p.ty * this.scale,
      zoom: Number.isFinite(zoom) ? zoom : 0,
      roll: Math.atan2(p.b, p.a),
      ...diff,
      same,
    });
  }
}

const quantile = (values, share) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : 0;
};
const median = (values) => quantile(values, 0.5);

/**
 * What the measurements say. Moves: stretches where the picture as a whole moves (pan; zoom
 * and roll count as how fast the picture's corners move, so the three compare on one scale),
 * each with its top speed and how it starts and stops — eased, or at full speed from one frame
 * to the next. Besides: cuts, one-frame jumps, things that change within one frame inside the
 * picture, frames that repeat while it moves, and long holds. Speeds are design pixels per second.
 */
export function analyzeMotion(track) {
  const { fps, design, pairs } = track;
  const long = Math.max(design.width, design.height);
  const radius = Math.hypot(design.width, design.height) / 2;
  const n = pairs.length;
  const around = (index, field, span) =>
    median(
      pairs
        .slice(Math.max(0, index - span), index + span + 1)
        .filter((_, offset) => offset !== Math.min(index, span))
        .map((pair) => pair[field]),
    );
  // Cuts: most of the picture changes and the transform explains none of it.
  const cut = pairs.map((pair, index) => !pair.same && pair.area > 0.3 && pair.residual > Math.max(12, 3 * around(index, "residual", 6)));
  const series = pairs.map((pair, index) => {
    const speed = cut[index] ? NaN : Math.hypot(pair.dx, pair.dy) * fps;
    const turn = cut[index] ? NaN : (Math.abs(pair.zoom) + Math.abs(pair.roll)) * fps * radius;
    return {
      time: pair.time,
      speed,
      turn,
      edge: speed + turn,
      zoomRate: cut[index] ? NaN : pair.zoom * fps,
      raw: pair.raw,
      residual: pair.residual,
      area: pair.area,
      same: pair.same,
      cut: cut[index],
    };
  });
  const still = 0.02 * long; // px/s: slower than this the picture as a whole stands still
  const abrupt = 0.08 * long; // px/s: starting or stopping at this speed or more is felt
  // What changes even in a still picture (film grain, flicker): the quietest tenth.
  const floor = quantile(
    series.filter((item) => !item.cut).map((item) => item.residual),
    0.1,
  );
  const quiet = floor + 1;
  const edge = (k) => (k >= 0 && k < n ? series[k].edge : NaN);
  const moving = (index) => index >= 0 && index < n && !series[index].same && !cut[index] && (edge(index) >= still || series[index].residual > quiet + 1);
  const events = [];
  const near = (index, span = 1) => cut.slice(Math.max(0, index - span), index + span + 1).some(Boolean);
  // The picture goes somewhere for a frame and comes back: a jump once, a shake (a phone that
  // buzzes, a hit) when it goes on.
  // Pan, zoom and roll of a frame as one vector (zoom and roll as the corners' movement).
  const motion = (k) => (k >= 0 && k < n && !cut[k] ? [pairs[k].dx, pairs[k].dy, pairs[k].zoom * radius, pairs[k].roll * radius] : null);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const skip = new Set();
  const flips = [];
  for (let k = 0; k + 1 < n; k++) {
    const a = motion(k),
      b = motion(k + 1);
    if (!a || !b) continue;
    const sa = edge(k),
      sb = edge(k + 1);
    if (dot(a, b) < 0 && Math.min(sa, sb) >= abrupt && Math.max(sa, sb) >= 2 * abrupt && Math.max(sa, sb) <= 3 * Math.min(sa, sb)) flips.push(k);
  }
  for (let i = 0; i < flips.length;) {
    let j = i;
    while (j + 1 < flips.length && flips[j + 1] - flips[j] <= 4) j++;
    const first = flips[i],
      last = flips[j] + 1;
    const calm = (k) => !(k >= 0 && k < n) || !(edge(k) >= 0.3 * Math.max(edge(first), edge(last)));
    if (j > i) {
      const size = Math.max(...[...Array(last - first + 1).keys()].map((k) => edge(first + k)).filter(Number.isFinite)) / fps;
      events.push({ kind: "shake", time: series[first].time, end: series[last].time + 1 / fps, index: first, last, distance: size });
      for (let k = first; k <= last; k++) skip.add(k);
    } else if (calm(first - 1) && calm(last + 1)) {
      events.push({ kind: "jump", time: series[first].time + 1 / fps, index: first, distance: edge(first) / fps });
      skip.add(first);
      skip.add(last);
    }
    i = j + 1;
  }
  // Frames identical to the one before while the picture moves on both sides: it stutters
  // (motion drawn at a lower frame rate than the work's, or a time that sticks).
  const repeats = [];
  const stutter = new Set();
  // (Not a shake: there the picture goes back the way it came around the frame that stays.)
  const reverses = (a, b) => pairs[a].dx * pairs[b].dx + pairs[a].dy * pairs[b].dy < 0 && series[a].speed >= still && series[b].speed >= still;
  for (let index = 1; index < n - 1; index++) {
    if (!series[index].same || skip.has(index - 1) || skip.has(index + 1) || !moving(index - 1) || !moving(index + 1) || reverses(index - 1, index + 1))
      continue;
    for (const k of [index - 1, index, index + 1]) stutter.add(k);
    const last = repeats[repeats.length - 1];
    if (last && series[index].time - last.end <= 0.25) {
      last.end = series[index].time + 1 / fps;
      last.count++;
    } else repeats.push({ kind: "repeat", time: series[index].time, end: series[index].time + 1 / fps, count: 1 });
  }
  // At either end of the stretch the pattern goes on past what was drawn.
  for (const [end, inward, further] of [
    [0, 1, 2],
    [n - 1, n - 2, n - 3],
  ])
    if (series[end]?.same && moving(inward) && stutter.has(further)) stutter.add(end);
  events.push(...repeats);
  // To a new place in one frame and staying there.
  for (let index = 1; index + 1 < n; index++) {
    if (near(index) || stutter.has(index) || skip.has(index) || skip.has(index - 1) || skip.has(index + 1)) continue;
    const now = edge(index);
    if (!(now >= 2 * abrupt && edge(index - 1) < 0.3 * now && edge(index + 1) < 0.3 * now)) continue;
    // Next to a shake it is part of the shake.
    const shake = events.find((event) => event.kind === "shake" && index >= event.index - 4 && index <= event.last + 4);
    if (shake) {
      shake.time = Math.min(shake.time, series[index].time);
      shake.end = Math.max(shake.end, series[index].time + 1 / fps);
      shake.distance = Math.max(shake.distance, now / fps);
    } else events.push({ kind: "skip", time: series[index].time + 1 / fps, index, distance: now / fps });
    skip.add(index);
  }
  // Moves: runs where the picture moves as a whole, ending where it stands still for two frames,
  // at a cut or at a jump.
  const usable = (k) => k >= 0 && k < n && !cut[k] && !skip.has(k) && !stutter.has(k);
  const moves = [];
  for (let index = 0; index < n;) {
    if (!usable(index) || !(edge(index) >= still)) {
      index++;
      continue;
    }
    let end = index;
    while (usable(end + 1) && (edge(end + 1) >= still || (usable(end + 2) && edge(end + 2) >= still))) end++;
    while (end > index && !(edge(end) >= still)) end--;
    const frames = [...Array(end - index + 1).keys()].map((k) => index + k);
    const speeds = frames.map(edge);
    const peak = Math.max(...speeds);
    const top = frames[speeds.indexOf(peak)];
    // A short slow wobble is not a move (estimates of busy pictures wobble that much), nor a
    // twitch of a frame or two that is not fast.
    if ((peak >= abrupt || frames.length >= 0.5 * fps) && (frames.length > 2 || peak >= 2 * abrupt)) {
      const from = index === 0 ? "window" : cut[index - 1] ? "cut" : skip.has(index - 1) || stutter.has(index - 1) ? "other" : null;
      const to = end === n - 1 ? "window" : cut[end + 1] ? "cut" : skip.has(end + 1) || stutter.has(end + 1) ? "other" : null;
      const sum = (field) => frames.reduce((total, k) => total + pairs[k][field], 0);
      const distance = Math.hypot(sum("dx"), sum("dy"));
      const zoom = Math.exp(sum("zoom"));
      const roll = sum("roll");
      const path = speeds.reduce((total, speed) => total + speed / fps, 0);
      const net = distance + Math.abs(Math.log(zoom)) * radius + Math.abs(roll) * radius;
      if (net < 0.3 * path && path >= 0.02 * long)
        events.push({ kind: "shake", time: series[index].time, end: series[end].time + 1 / fps, index, last: end, distance: peak / fps });
      // Less than a hundredth of the picture in all: nobody sees it move.
      else if (net >= 0.01 * long) {
        const sharp = Math.max(abrupt, 0.5 * peak);
        const peakIndex = speeds.indexOf(peak);
        // The sharpest speed-up before the top speed and slow-down after it (from or to
        // standing still at the ends: a start or stop without easing).
        let rise = { size: from ? 0 : speeds[0], at: 0 };
        for (let k = 1; k <= peakIndex; k++) if (speeds[k] - speeds[k - 1] > rise.size) rise = { size: speeds[k] - speeds[k - 1], at: k };
        let fall = { size: to ? 0 : speeds[speeds.length - 1], at: speeds.length };
        for (let k = peakIndex + 1; k < speeds.length; k++) if (speeds[k - 1] - speeds[k] > fall.size) fall = { size: speeds[k - 1] - speeds[k], at: k };
        moves.push({
          start: series[index].time,
          end: series[end].time + 1 / fps,
          peak,
          peakAt: series[top].time,
          distance,
          direction: Math.atan2(sum("dy"), sum("dx")),
          zoom,
          roll: (roll * 180) / Math.PI,
          from,
          to,
          // Speeds in px/s around the sharpest step; `at` the frame time it reaches the new speed.
          speedUp:
            rise.size >= sharp
              ? {
                  time: series[frames[Math.min(rise.at, frames.length - 1)]].time,
                  before: rise.at ? speeds[rise.at - 1] : 0,
                  after: speeds[rise.at],
                  start: rise.at === 0,
                }
              : null,
          slowDown:
            fall.size >= sharp
              ? {
                  time: fall.at >= speeds.length ? series[end].time + 1 / fps : series[frames[fall.at]].time,
                  before: speeds[fall.at - 1],
                  after: fall.at >= speeds.length ? 0 : speeds[fall.at],
                  stop: fall.at >= speeds.length,
                }
              : null,
        });
      }
    }
    index = end + 1;
  }
  // Something inside the picture changes within one frame (pops in, a drawing swapped, a
  // glitch): a spike of changed area against the frames around it.
  const pops = [];
  for (let index = 0; index < n; index++) {
    const item = series[index];
    // While the picture moves fast the transform explains less of it: no pops read there.
    if (
      item.cut ||
      near(index) ||
      item.same ||
      stutter.has(index) ||
      skip.has(index) ||
      skip.has(index - 1) ||
      [index - 1, index, index + 1].some((k) => edge(k) >= 2 * abrupt)
    )
      continue;
    const usual = around(index, "area", 4);
    if (item.area >= Math.max(0.004, 4 * usual) && item.area < 0.3) pops.push({ kind: "pop", time: item.time + 1 / fps, index, area: item.area });
  }
  pops.sort((x, y) => y.area - x.area);
  events.push(...pops.slice(0, 8));
  // Holds: neither the camera nor anything in the picture moves.
  const resting = (k) => edge(k) < still && series[k].residual <= quiet && series[k].area < 0.002;
  for (let index = 0; index < n;) {
    if (!resting(index)) {
      index++;
      continue;
    }
    let end = index;
    while (end + 1 < n && resting(end + 1)) end++;
    const seconds = (end - index + 1) / fps;
    if (seconds >= HOLD_SECONDS) events.push({ kind: "hold", time: series[index].time, end: series[end].time + 1 / fps, seconds });
    index = end + 1;
  }
  events.sort((x, y) => x.time - y.time);
  const cuts = series.filter((item) => item.cut).map((item) => item.time + 1 / fps);
  for (const event of events) {
    const close = cuts.find((time) => Math.abs(time - event.time) <= 0.15 || (event.end !== undefined && Math.abs(time - event.end) <= 0.15));
    if (close !== undefined && event.kind !== "hold" && event.kind !== "repeat") event.cut = close;
  }
  // Where the moves speed up or slow down at once, for the chart.
  const marks = moves.flatMap((move) => [move.speedUp?.time, move.slowDown?.time].filter((time) => time !== undefined));
  return { fps, series, moves, events, marks, cuts, floor, still, abrupt };
}

const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const arrow = (angle) => ARROWS[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
const px = (value) => `${Math.round(value)} px/s`;
const MOVES_SHOWN = 12;

/** The analysis as lines for the AI (it reads only text): the moves, cuts, then the rest by time. */
export function motionText(analysis, { design }) {
  const widths = (value) => (value / design.width >= 0.3 ? `，${(value / design.width).toFixed(1)} 个画面宽/秒` : "");
  const lines = [];
  if (analysis.moves.length) {
    lines.push("画面整体的运动（速度按作品画面像素/秒，推拉和旋转按画面边缘移动的速度算）：");
    for (const move of analysis.moves.slice(0, MOVES_SHOWN)) {
      const what = [];
      if (move.distance >= 5) what.push(`往 ${arrow(move.direction)} 移 ${Math.round(move.distance)} px`);
      if (Math.abs(Math.log(move.zoom)) >= 0.003)
        what.push(`${move.zoom > 1 ? "推近（变大）" : "拉远（变小）"}到 ${move.zoom.toFixed(Math.abs(move.zoom - 1) >= 0.05 ? 2 : 3)} 倍`);
      if (Math.abs(move.roll) >= 0.3) what.push(`${move.roll > 0 ? "顺时针" : "逆时针"}转 ${Math.abs(move.roll).toFixed(1)}°`);
      const seconds = move.end - move.start;
      const shape = [];
      if (move.from === "window") shape.push("范围开始前已经在动");
      else if (move.from === "cut") shape.push("切进来就在动");
      else if (move.from) shape.push("接在抖动或跳动后面");
      if (move.speedUp?.start) shape.push(`起步突然：第一帧就到 ${px(move.speedUp.after)}，没有缓入`);
      else if (move.speedUp) shape.push(`加速突然：${formatTime(move.speedUp.time)} 一帧内 ${px(move.speedUp.before)} → ${px(move.speedUp.after)}`);
      else if (!move.from) shape.push("缓入");
      if (move.slowDown?.stop) shape.push(`停得突然：最后一帧还有 ${px(move.slowDown.before)}，没有缓出`);
      else if (move.slowDown) shape.push(`减速突然：${formatTime(move.slowDown.time)} 一帧内 ${px(move.slowDown.before)} → ${px(move.slowDown.after)}`);
      else if (!move.to) shape.push("缓出");
      if (move.to === "window") shape.push("到范围结束还在动");
      else if (move.to === "cut") shape.push("一直动到切换");
      else if (move.to) shape.push("后面接着抖动或跳动");
      lines.push(
        `- ${formatTime(move.start)}–${formatTime(move.end)}（${seconds.toFixed(2)} 秒${seconds <= 0.2 ? "，一闪而过" : ""}）${what.join("、") || "原地晃了一下"}，最快 ${px(move.peak)}（${formatTime(move.peakAt)}${widths(move.peak)}）：${shape.join("；")}`,
      );
    }
    if (analysis.moves.length > MOVES_SHOWN) lines.push(`- 另外还有 ${analysis.moves.length - MOVES_SHOWN} 段运动，缩短时间范围看`);
  } else lines.push("画面整体没有动（镜头不动）。");
  if (analysis.cuts.length) lines.push(`切换（或一闪、很快的甩镜）：${analysis.cuts.map(formatTime).join("、")}`);
  const describe = (event) => {
    switch (event.kind) {
      case "jump":
        return `${formatTime(event.time)} 单帧跳动：整个画面跳开 ${Math.round(event.distance)} px，下一帧又回来`;
      case "shake":
        return `${formatTime(event.time)}–${formatTime(event.end)} 画面来回抖动（一帧最多晃 ${Math.round(event.distance)} px；手机震动、撞击这类故意的晃动不用改）`;
      case "skip":
        return `${formatTime(event.time)} 单帧跳位：前后几乎不动，这一帧整个画面一下移了 ${Math.round(event.distance)} px`;
      case "pop":
        return `${formatTime(event.time)} 局部突变：画面里${event.area >= 0.01 ? `约 ${Math.round(event.area * 100)}%` : "不到 1%"} 的地方一帧内变了（弹出、换图，或是穿帮）`;
      case "hold":
        return `${formatTime(event.time)}–${formatTime(event.end)} 画面完全静止 ${event.seconds.toFixed(1)} 秒（镜头和画面里的东西都不动）`;
      case "repeat":
        return `${formatTime(event.time)}–${formatTime(event.end)} 有 ${event.count} 帧和前一帧一模一样（画面在动时重复，看起来会顿；动画的帧率可能比作品低）`;
      default:
        return "";
    }
  };
  const shown = analysis.events.slice(0, 12);
  if (shown.length) {
    lines.push("其他值得看一眼的地方（故意的效果可以不改）：");
    lines.push(
      ...shown.map((event) => "- " + describe(event) + (event.cut !== undefined ? `（紧挨着 ${formatTime(event.cut)} 的切换，是转场的一部分就不用管）` : "")),
    );
    if (analysis.events.length > shown.length) lines.push(`- 另外还有 ${analysis.events.length - shown.length} 处，缩短时间范围看`);
  } else lines.push(`没有单帧跳动、局部突变、重复帧或 ${HOLD_SECONDS} 秒以上的完全静止。`);
  return lines;
}

const escapeXml = (text) => String(text).replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Round numbers for an axis: about `count` steps from 0 to `max`. */
function niceStep(max, count) {
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * power).find((step) => step >= raw) ?? 10 * power;
}
const label = (value) => String(value >= 10 ? Math.round(value) : value >= 1 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100);

/**
 * One picture for the AI: a row of frames across the stretch, then the curves — how fast the
 * whole picture moves (pan; zoom and roll as corner speed) and how much moves inside it — with
 * cuts as grey lines, holds shaded, and the problems as red dots on the curve they belong to.
 */
export async function motionChart(analysis, { start, end, thumbs = [] }) {
  const W = 1000,
    left = 70,
    right = 20,
    plotW = W - left - right;
  const cell = thumbs.length ? plotW / thumbs.length : 0;
  let thumbH = 0;
  if (thumbs.length) {
    const first = await sharp(thumbs[0].png).metadata();
    thumbH = Math.min(150, Math.round(((cell - 6) * first.height) / first.width)) + 24;
  }
  const panels = [
    {
      title: "画面整体的速度（px/s，按画面边缘算；虚线是其中推拉和旋转的部分）",
      h: 170,
      lines: [
        { key: "edge", color: "#4f8cff" },
        { key: "turn", color: "#f0a03c", dash: true },
      ],
      kinds: ["jump", "skip"],
      marks: true,
    },
    { title: "画面里自己在动的量（去掉整体运动后的灰度差）", h: 110, lines: [{ key: "residual", color: "#46b37a" }], kinds: ["pop", "repeat"] },
  ];
  const H = thumbH + panels.reduce((sum, panel) => sum + panel.h + 34, 0) + 34;
  const x = (time) => left + ((time - start) / Math.max(1e-6, end - start)) * plotW;
  const parts = [`<rect width="${W}" height="${H}" fill="#16191d"/>`];
  const composites = [];
  for (const [index, thumb] of thumbs.entries()) {
    const meta = await sharp(thumb.png).metadata();
    const scale = Math.min((cell - 6) / meta.width, (thumbH - 24) / meta.height);
    const tw = Math.max(1, Math.round(meta.width * scale)),
      th = Math.max(1, Math.round(meta.height * scale));
    const tx = Math.round(left + index * cell + (cell - tw) / 2);
    composites.push({ input: await sharp(thumb.png).resize(tw, th).png().toBuffer(), left: tx, top: 4 });
    parts.push(
      `<text x="${tx + tw / 2}" y="${th + 20}" fill="#c9d1d9" font-size="13" font-family="sans-serif" text-anchor="middle">${escapeXml(formatTime(thumb.time))}</text>`,
    );
  }
  const series = analysis.series;
  let top = thumbH + 10;
  for (const panel of panels) {
    parts.push(`<text x="${left}" y="${top + 14}" fill="#e8edf2" font-size="14" font-family="sans-serif">${escapeXml(panel.title)}</text>`);
    const y0 = top + 22,
      y1 = y0 + panel.h;
    const values = series.flatMap((item) => panel.lines.map((line) => item[line.key])).filter(Number.isFinite);
    const step = niceStep(Math.max(1e-3, ...values), 3);
    const max = Math.max(step, Math.ceil(Math.max(1e-3, ...values) / step) * step);
    const y = (value) => y1 - (value / max) * panel.h;
    parts.push(`<rect x="${left}" y="${y0}" width="${plotW}" height="${panel.h}" fill="#1d2228" stroke="#2c333b"/>`);
    for (let value = step; value <= max + 1e-9; value += step) {
      parts.push(`<line x1="${left}" x2="${left + plotW}" y1="${y(value)}" y2="${y(value)}" stroke="#2c333b"/>`);
      parts.push(`<text x="${left - 6}" y="${y(value) + 4}" fill="#8b949e" font-size="11" font-family="sans-serif" text-anchor="end">${label(value)}</text>`);
    }
    for (const event of analysis.events)
      if (event.kind === "hold" || (event.kind === "shake" && panel.marks))
        parts.push(
          `<rect x="${x(event.time)}" y="${y0}" width="${Math.max(1, x(event.end) - x(event.time))}" height="${panel.h}" fill="#f85149" opacity="0.12"/>`,
        );
    for (const cut of analysis.cuts) parts.push(`<line x1="${x(cut)}" x2="${x(cut)}" y1="${y0}" y2="${y1}" stroke="#6e7681" stroke-width="2"/>`);
    for (const line of panel.lines) {
      let path = "";
      let open = false;
      for (const item of series) {
        const value = item[line.key];
        if (!Number.isFinite(value)) {
          open = false;
          continue;
        }
        path += `${open ? "L" : "M"}${x(item.time + 0.5 / analysis.fps).toFixed(1)},${y(Math.min(value, max)).toFixed(1)}`;
        open = true;
      }
      parts.push(`<path d="${path}" fill="none" stroke="${line.color}" stroke-width="2"${line.dash ? ' stroke-dasharray="5,4"' : ""}/>`);
    }
    for (const event of analysis.events)
      if (panel.kinds.includes(event.kind)) parts.push(`<circle cx="${x(event.time)}" cy="${y1 - 7}" r="5" fill="#f85149"/>`);
    if (panel.marks) for (const time of analysis.marks) parts.push(`<circle cx="${x(time)}" cy="${y1 - 7}" r="5" fill="#f85149"/>`);
    top = y1 + 12;
  }
  // Time axis under the last panel, on round seconds.
  const tick = niceStep(end - start, 8);
  for (let time = Math.ceil(start / tick - 1e-9) * tick; time <= end + 1e-9; time += tick)
    parts.push(
      `<text x="${x(time)}" y="${top + 12}" fill="#8b949e" font-size="12" font-family="sans-serif" text-anchor="middle">${escapeXml(formatTime(time))}</text>`,
    );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).composite(composites).jpeg({ quality: 82 }).toBuffer();
}
