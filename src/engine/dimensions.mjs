import { z } from "zod";
export const compositionSchema = z.strictObject({ width: z.number().int().min(2).max(8192), height: z.number().int().min(2).max(8192) });
/** @typedef {{width: number, height: number}} FrameSize */
/** @param {{composition?: FrameSize}} [project] @returns {FrameSize} */
export function compositionSize(project = {}) {
  return compositionSchema.parse(project.composition ?? { width: 1920, height: 1080 });
}
/** One pixel-grid policy for preview, screenshots, WebCodecs and FFmpeg. */
/** @param {{composition?: FrameSize}} project @param {number} width @returns {FrameSize} */
export function frameDimensions(project, width) {
  if (!Number.isInteger(width) || width < 2 || width > 3840 || width % 2)
    throw new Error("Frame width must be an even integer from 2 to 3840");
  const composition = compositionSize(project);
  const height = Math.max(2, Math.round(width * composition.height / composition.width / 2) * 2);
  if (height > 3840) throw new Error("Frame height exceeds 3840; choose a smaller width for this aspect ratio");
  return { width, height };
}
/** @param {{composition?: FrameSize}} project @param {number} [longEdge] @returns {FrameSize} */
export function fitComposition(project, longEdge = 1920) {
  if (!Number.isInteger(longEdge) || longEdge < 64 || longEdge > 3840 || longEdge % 2) throw new Error("Invalid preview/export size");
  const composition = compositionSize(project);
  const width = Math.max(2, Math.round(longEdge * composition.width / Math.max(composition.width, composition.height) / 2) * 2);
  return frameDimensions(project, width);
}
