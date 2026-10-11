import { gsap } from "gsap";
import { CustomBounce } from "gsap/CustomBounce";
import { CustomEase } from "gsap/CustomEase";
import { CustomWiggle } from "gsap/CustomWiggle";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { Physics2DPlugin } from "gsap/Physics2DPlugin";

/**
 * GSAP for works drawn on a canvas. Timelines are built paused and seeked to the frame's
 * time (`timeline.seek(time, true)`), so a frame depends on its time only. The plugins that
 * animate SVG elements of a web page get canvas counterparts here: shapes that turn into
 * other shapes, strokes that grow, text split into letters.
 */
gsap.registerPlugin(CustomEase, CustomBounce, CustomWiggle, MorphSVGPlugin, MotionPathPlugin, Physics2DPlugin);
// Nothing moves with the wall clock: an animation that is not seeked stays where it starts.
gsap.globalTimeline.pause();

export { gsap, CustomBounce, CustomEase, CustomWiggle, MorphSVGPlugin, MotionPathPlugin, Physics2DPlugin };

const SVG = "http://www.w3.org/2000/svg";
const pathElement = (d: string) => {
  const element = document.createElementNS(SVG, "path");
  element.setAttribute("d", d);
  return element;
};

export interface MorphOptions {
  /** Which point of `to` the start of `from` moves to; "auto" picks the shortest travel. */
  shapeIndex?: number | "auto";
  /** "rotational" turns the segments instead of moving their points in a straight line. */
  type?: "linear" | "rotational";
  /** How subpaths of different shapes are paired. */
  map?: "size" | "position" | "complexity";
}

/**
 * One shape turning into another (MorphSVG on the canvas): returns `progress → path data`
 * for `new Path2D(…)`. 0 is `from`, 1 is `to`; the timing and easing come from the caller,
 * usually a value that a paused timeline animates.
 */
export function morphPath(from: string, to: string, options: MorphOptions = {}): (progress: number) => string {
  let raw: Parameters<typeof MorphSVGPlugin.rawPathToString>[0] | null = null;
  const tween = gsap.to(pathElement(from), {
    morphSVG: { shape: to, ...options, updateTarget: false, render: (path: typeof raw) => (raw = path) },
    duration: 1,
    ease: "none",
    paused: true,
  });
  let last = NaN;
  let shape = from;
  return (progress) => {
    const p = Math.min(1, Math.max(0, progress));
    if (p !== last) {
      tween.progress(p, true);
      if (raw) shape = MorphSVGPlugin.rawPathToString(raw);
      last = p;
    }
    return shape;
  };
}

const lengths = new Map<string, number>();
/** The length of SVG path data, in its own units. */
export function pathLength(d: string): number {
  let length = lengths.get(d);
  if (length === undefined) {
    length = pathElement(d).getTotalLength();
    if (lengths.size > 500) lengths.delete(lengths.keys().next().value!);
    lengths.set(d, length);
  }
  return length;
}

/**
 * Stroke the part of a path between `start` and `end` (fractions of its length) with the
 * context's current stroke style: a line that draws itself (DrawSVG on the canvas).
 */
export function strokePath(ctx: CanvasRenderingContext2D, d: string, end: number, start = 0): void {
  const from = Math.min(1, Math.max(0, start));
  const to = Math.min(1, Math.max(from, end));
  if (to <= from) return;
  const length = pathLength(d);
  ctx.save();
  ctx.setLineDash([length * (to - from), length * 2]);
  ctx.lineDashOffset = -length * from;
  ctx.stroke(new Path2D(d));
  ctx.restore();
}

/** One letter of `splitText`: where it sits, and values a timeline may animate. */
export interface Glyph {
  text: string;
  /** Position among all letters, in its word and line. */
  index: number;
  word: number;
  line: number;
  /** Left end of the letter on its baseline (with textAlign "left"), and its advance. */
  x: number;
  y: number;
  width: number;
  /** Animatable: draw with globalAlpha = alpha, rotated (radians) and scaled around the letter's center. */
  alpha: number;
  scale: number;
  rotation: number;
}

export interface SplitTextOptions {
  x?: number;
  y?: number;
  align?: "left" | "center" | "right";
  /** Distance between baselines, as a multiple of the font's height. */
  lineHeight?: number;
  /** Extra space after every letter, in canvas units. */
  letterSpacing?: number;
  /** Wrap longer lines: between any two CJK characters, elsewhere between words. */
  maxWidth?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/**
 * Text laid out letter by letter with the context's current font (SplitText on the canvas).
 * Animate the glyphs with a timeline (`stagger` runs letter after letter), then draw each one:
 * `ctx.fillText(glyph.text, glyph.x, glyph.y)` with textAlign "left". `\n` starts a new line.
 */
export function splitText(ctx: CanvasRenderingContext2D, text: string, options: SplitTextOptions = {}): Glyph[] {
  const { x = 0, y = 0, align = "left", lineHeight = 1.25, letterSpacing = 0, maxWidth } = options;
  const metrics = ctx.measureText("国M");
  const height = (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent || parseFloat(ctx.font) || 16) * lineHeight;
  // Units that may not be broken: a word of a western language, a single CJK character, a space.
  const units: { text: string; word: number; space: boolean }[] = [];
  let word = 0;
  for (const segment of words.segment(text)) {
    const pieces = segment.isWordLike && !CJK.test(segment.segment) ? [segment.segment] : [...graphemes.segment(segment.segment)].map((item) => item.segment);
    for (const piece of pieces) units.push({ text: piece, word, space: /^\s+$/.test(piece) });
    if (segment.isWordLike) word++;
  }
  const advance = (value: string) => ctx.measureText(value).width + [...graphemes.segment(value)].length * letterSpacing;
  const lines: { text: string; word: number }[][] = [[]];
  let width = 0;
  for (const unit of units) {
    if (unit.text === "\n") {
      lines.push([]);
      width = 0;
      continue;
    }
    const size = advance(unit.text);
    const line = lines[lines.length - 1];
    if (maxWidth && width + size > maxWidth && line.length && !unit.space) {
      while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
      lines.push([]);
      width = 0;
    }
    if (unit.space && !lines[lines.length - 1].length) continue;
    lines[lines.length - 1].push(unit);
    width += size;
  }
  const glyphs: Glyph[] = [];
  lines.forEach((line, row) => {
    const letters = line.flatMap((unit) => [...graphemes.segment(unit.text)].map((item) => ({ text: item.segment, word: unit.word })));
    // Each letter starts where the text before it ends, so kerning is kept.
    let before = "";
    const placed = letters.map((letter, index) => {
      const left = ctx.measureText(before).width + index * letterSpacing;
      before += letter.text;
      return { ...letter, left };
    });
    const total = ctx.measureText(before).width + letters.length * letterSpacing;
    const shift = align === "center" ? -total / 2 : align === "right" ? -total : 0;
    for (const letter of placed)
      if (!/^\s+$/.test(letter.text))
        glyphs.push({
          text: letter.text,
          index: glyphs.length,
          word: letter.word,
          line: row,
          x: x + shift + letter.left,
          y: y + row * height,
          width: ctx.measureText(letter.text).width,
          alpha: 1,
          scale: 1,
          rotation: 0,
        });
  });
  return glyphs;
}

/**
 * Draw glyphs of `splitText` with their animated alpha, scale and rotation (around each
 * letter's center), using the context's current font and fill style.
 */
export function drawGlyphs(ctx: CanvasRenderingContext2D, glyphs: Glyph[]): void {
  ctx.save();
  ctx.textAlign = "left";
  const alpha = ctx.globalAlpha;
  for (const glyph of glyphs) {
    if (glyph.alpha <= 0 || glyph.scale === 0) continue;
    ctx.globalAlpha = alpha * Math.min(1, glyph.alpha);
    if (glyph.scale === 1 && !glyph.rotation) ctx.fillText(glyph.text, glyph.x, glyph.y);
    else {
      const center = glyph.x + glyph.width / 2;
      ctx.save();
      ctx.translate(center, glyph.y);
      ctx.rotate(glyph.rotation);
      ctx.scale(glyph.scale, glyph.scale);
      ctx.fillText(glyph.text, -glyph.width / 2, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}
