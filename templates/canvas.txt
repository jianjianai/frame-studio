import type { Scene, SceneOptions } from '../../src/engine/types';
export function createScene({ width, height }: SceneOptions): Scene {
 const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
 const ctx = canvas.getContext('2d')!;
 return { canvas, render(time) { ctx.fillStyle = '#e4ead9'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#6e926f'; ctx.beginPath(); ctx.arc(width * .5 + Math.sin(time) * width * .15, height * .5, height * .07, 0, Math.PI * 2); ctx.fill(); }, dispose() { canvas.width = 1; canvas.height = 1; } };
}
