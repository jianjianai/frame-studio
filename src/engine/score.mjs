// Original, explicitly voiced miniatures. Beat positions are a score, not a random-note loop.
// Original instrument samples are loaded by soundfont-audio.ts; each project owns its sources.
const pitches = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function midiNote(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 127) return value;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(value);
  if (!m) throw new Error(`Invalid pitch: ${value}`);
  return (
    12 * (Number(m[3]) + 1) +
    pitches[m[1]] +
    (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0)
  );
}
const clip = (x, a, b) => Math.max(a, Math.min(b, x));
export function makeScore(id, duration, bpm, meter, instruments, cues) {
  const notes = [],
    controls = [],
    start = 0.28;
  const beatSeconds = 60 / bpm;
  const cc = (ch, at, controller, value) =>
    controls.push({
      t: at,
      data: [0xb0 | ch, controller, Math.round(clip(value, 0, 127))],
    });
  instruments.forEach(({ channel, program, volume, pan, reverb }) => {
    controls.push({ t: 0, data: [0xc0 | channel, program] });
    cc(channel, 0, 7, volume);
    cc(channel, 0, 10, pan);
    cc(channel, 0, 91, reverb);
    cc(channel, 0, 93, 0);
  });
  const note = (ch, b, p, d, v = 70, human = true) => {
    if (p === null || p === "-") return;
    const index = notes.length;
    const micro = human ? Math.sin(index * 2.731) * 0.005 : 0;
    const t = Math.max(start, start + b * beatSeconds + micro);
    const end = Math.min(duration - 0.45, t + d * beatSeconds);
    if (end <= t) throw new Error(`Invalid note length for ${id}`);
    notes.push({
      channel: ch,
      t,
      end,
      pitch: midiNote(p),
      velocity: Math.round(
        clip(v + (human ? Math.sin(index * 1.823) * 3 : 0), 1, 115),
      ),
    });
  };
  const phrase = (ch, bar, arr, gain = 1) =>
    arr.forEach(([b, p, d, v]) =>
      note(ch, bar * meter + b, p, d, (v ?? 73) * gain),
    );
  const chord = (ch, b, ps, d, v = 55, strum = 0.018) =>
    ps.forEach((p, i) =>
      note(ch, b + i * strum, p, d - i * strum, v - i * 1.1),
    );
  const swell = (ch, points) => {
    for (let t = 0; t < duration; t += 0.12) {
      let a = points[0],
        b = points.at(-1);
      for (let j = 1; j < points.length; j++)
        if (t <= points[j][0]) {
          a = points[j - 1];
          b = points[j];
          break;
        }
      const p = clip((t - a[0]) / Math.max(0.001, b[0] - a[0]), 0, 1);
      cc(ch, t, 11, a[1] + (b[1] - a[1]) * (p * p * (3 - 2 * p)));
    }
  };
  return {
    id,
    duration,
    bpm,
    meter,
    instruments,
    cues,
    notes,
    controls,
    note,
    phrase,
    chord,
    swell,
  };
}
export const instrument = (channel, program, name, volume, pan = 64, reverb = 36) => ({
  channel,
  program,
  name,
  volume,
  pan,
  reverb,
});

export function scoreEvents(score) {
  return [
    ...score.controls.map((e) => ({ ...e, priority: 0 })),
    ...score.notes.flatMap((n) => [
      { t: n.t, data: [0x90 | n.channel, n.pitch, n.velocity], priority: 2 },
      { t: n.end, data: [0x80 | n.channel, n.pitch, 0], priority: 1 },
    ]),
  ].sort((a, b) => a.t - b.t || a.priority - b.priority);
}
export function scoreMidi(score) {
  const vlq = (n) => {
    const bytes = [n & 127];
    while ((n >>= 7) > 0) bytes.unshift((n & 127) | 128);
    return bytes;
  };
  const tempo = Math.round(60000000 / score.bpm);
  const events = [
    {
      tick: 0,
      data: [
        0xff,
        0x51,
        3,
        (tempo >> 16) & 255,
        (tempo >> 8) & 255,
        tempo & 255,
      ],
    },
    { tick: 0, data: [0xff, 0x58, 4, score.meter, 2, 24, 8] },
    ...scoreEvents(score).map((e) => ({
      tick: Math.round((e.t * 480 * score.bpm) / 60),
      data: e.data,
    })),
  ];
  events.push({
    tick: Math.round((score.duration * 480 * score.bpm) / 60),
    data: [0xff, 0x2f, 0],
  });
  events.sort((a, b) => a.tick - b.tick);
  let last = 0;
  const bytes = [];
  for (const e of events) {
    bytes.push(...vlq(e.tick - last), ...e.data);
    last = e.tick;
  }
  const output = new Uint8Array(22 + bytes.length);
  output.set([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, 77, 84, 114, 107]);
  new DataView(output.buffer).setUint32(18, bytes.length);
  output.set(bytes, 22);
  return output;
}
