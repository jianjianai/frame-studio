import type { ProjectMeta } from "./types";
type Cue = ProjectMeta["subtitles"][number];
export const activeSubtitle = (cues: readonly Cue[], time: number): string =>
  cues.find((s) => time >= s.start && time < s.end)?.text ?? "";
const stamp = (t: number): string => {
  const ms = Math.round(t * 1000);
  return (
    [
      Math.floor(ms / 3600000),
      Math.floor(ms / 60000) % 60,
      Math.floor(ms / 1000) % 60,
    ]
      .map((v) => String(v).padStart(2, "0"))
      .join(":") +
    "," +
    String(ms % 1000).padStart(3, "0")
  );
};
export const toSrt = (cues: readonly Cue[]): string =>
  cues
    .map(
      (s, i) =>
        String(i + 1) +
        "\n" +
        stamp(s.start) +
        " --> " +
        stamp(s.end) +
        "\n" +
        s.text,
    )
    .join("\n\n") + "\n";
export function paintSubtitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
): void {
  if (!text) return;
  ctx.save();
  const size = Math.round(w * 0.022);
  ctx.font = "500 " + size + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > w * 0.81 && line) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  const lineH = size * 1.5;
  const total = lines.length * lineH;
  const y = h * 0.92 - total / 2;
  const width = Math.max(...lines.map((s) => ctx.measureText(s).width));
  ctx.fillStyle = "rgba(13,21,24,.7)";
  ctx.beginPath();
  ctx.roundRect(
    (w - width) / 2 - size * 0.8,
    y - size * 0.65,
    width + size * 1.6,
    total + size * 0.2,
    size * 0.3,
  );
  ctx.fill();
  ctx.fillStyle = "#fff";
  lines.forEach((s, i) => ctx.fillText(s, w / 2, y + i * lineH + size * 0.25));
  ctx.restore();
}
