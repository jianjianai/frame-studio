/**
 * The stretches of a work that retention is measured over, taken from the work itself: its
 * layers (visual.json; in a music short these are the acts), its shot markers (project.ts
 * beats), its subtitles, and the lyrics of its music — an .lrc next to the song file, put on
 * the work's time through the audio clips that play the song (a cut song keeps each line where
 * it is heard). Segments written into the review (`segments`, e.g. the shots of a scene drawn
 * in code) replace the automatic ones of the same kind.
 *
 * `read(relative)` gives the text of a file under projects/<slug>/ or null.
 */
export async function workSegments({ meta, read }) {
  const duration = Number(meta?.duration) || 0;
  const out = [];
  const text = async (file) => {
    try {
      return await read(file);
    } catch {
      return null;
    }
  };
  const json = async (file) => {
    try {
      return JSON.parse((await text(file)) ?? "null");
    } catch {
      return null;
    }
  };

  // Layers that are a part of the video, not over all of it (lyrics, grain…).
  const visual = await json("visual.json");
  for (const clip of visual?.clips ?? [])
    if (!clip.hidden && clip.duration > 0 && (!duration || clip.duration < duration * 0.9))
      out.push({ kind: "图层", start: clip.start, end: clip.start + clip.duration, label: clip.name || clip.id });

  const beats = [...(meta?.beats ?? [])].filter((beat) => Number.isFinite(beat.at)).sort((a, b) => a.at - b.at);
  beats.forEach((beat, index) => {
    const end = beats[index + 1]?.at ?? duration;
    if (end > beat.at) out.push({ kind: "镜头", start: beat.at, end, label: beat.title || `镜头 ${index + 1}` });
  });

  for (const cue of meta?.subtitles ?? []) if (cue.end > cue.start) out.push({ kind: "字幕", start: cue.start, end: cue.end, label: cue.text });

  out.push(...(await lyricSegments(await json("audio.json"), text)));
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.start - b.start);
}

/** "[00:16.27]Every day…" lines; several time tags share a line; tags like [ar:…] are skipped. */
export function parseLrc(text) {
  const lines = [];
  for (const row of String(text ?? "").split(/\r?\n/)) {
    const tags = [...row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = row.replace(/\[[^\]]*\]/g, "").trim();
    if (!tags.length || !words) continue;
    for (const tag of tags) lines.push({ time: Number(tag[1]) * 60 + Number(tag[2]), text: words });
  }
  return lines.sort((a, b) => a.time - b.time);
}

async function lyricSegments(audio, read) {
  if (!audio?.clips?.length) return [];
  const sources = new Map((audio.sources ?? []).map((source) => [source.id, source]));
  const lyrics = new Map(); // song file → lines
  const playing = [];
  for (const clip of audio.clips) {
    const src = sources.get(clip.source)?.src;
    if (clip.muted || typeof src !== "string" || !src.startsWith("films/")) continue;
    // films/<slug>/music/song.flac → public/music/song.lrc
    const file = `public/${src.split("/").slice(2).join("/")}`.replace(/\.[^./]+$/, ".lrc");
    if (!lyrics.has(file)) lyrics.set(file, parseLrc(await read(file)));
    if (lyrics.get(file).length) playing.push({ clip, lines: lyrics.get(file) });
  }
  if (!playing.length) return [];
  // The song's own track: the one playing lyrics the longest (a muffled copy on another track is left out).
  const totals = new Map();
  for (const { clip } of playing) totals.set(clip.track, (totals.get(clip.track) ?? 0) + clip.duration);
  const track = [...totals].sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  for (const { clip, lines } of playing.filter((item) => item.clip.track === track)) {
    const rate = clip.rate > 0 ? clip.rate : 1;
    const offset = clip.offset ?? 0;
    const until = clip.start + clip.duration;
    lines.forEach((line, index) => {
      const next = lines[index + 1]?.time ?? line.time + 5;
      // A line sung across the cut counts from where the clip starts; slivers under 0.3 s are left out.
      if (next <= offset || line.time >= offset + clip.duration * rate) return;
      const start = clip.start + Math.max(0, line.time - offset) / rate;
      const end = Math.min(until, clip.start + (next - offset) / rate);
      if (end - start >= 0.3) out.push({ kind: "歌词", start: round(start), end: round(end), label: line.text, songTime: line.time });
    });
  }
  return out;
}

const round = (value) => Number(value.toFixed(3));
