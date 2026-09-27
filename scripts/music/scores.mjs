// Original, explicitly voiced miniatures. Beat positions are a score, not a random-note loop.
// Instrument samples are supplied separately by GeneralUser GS; see production/music/README.md.
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
function makeScore(id, duration, bpm, meter, instruments, cues) {
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
const instrument = (channel, program, name, volume, pan = 64, reverb = 36) => ({
  channel,
  program,
  name,
  volume,
  pan,
  reverb,
});

export function paperWings() {
  const s = makeScore(
    "paper-wings",
    32,
    96,
    4,
    [
      instrument(0, 0, "Grand piano", 88, 51, 34),
      instrument(1, 46, "Concert harp", 59, 86, 46),
      instrument(2, 73, "Flute", 75, 62, 42),
      instrument(3, 48, "Chamber strings", 66, 78, 50),
      instrument(4, 42, "Cello", 62, 40, 42),
      instrument(5, 8, "Celesta", 50, 89, 46),
    ],
    [
      { at: 0.28, label: "A · piano invitation" },
      { at: 5.28, label: "Woodwind answer / take flight" },
      { at: 10.28, label: "B · strings lift over the forest" },
      { at: 17.78, label: "Sea reveal / broaden the theme" },
      { at: 25.28, label: "Decrescendo / approach the lighthouse" },
      { at: 28.78, label: "D major arrival / let the room decay" },
    ],
  );
  const bars = [
    ["D2", ["D3", "A3", "F#4", "E5"]],
    ["B1", ["B2", "F#3", "A3", "D4"]],
    ["G2", ["G3", "B3", "D4", "F#4"]],
    ["A2", ["A3", "C#4", "E4", "B4"]],
    ["F#2", ["A3", "D4", "F#4", "A4"]],
    ["B1", ["B3", "D4", "F#4", "A4"]],
    ["E2", ["G3", "B3", "D4", "F#4"]],
    ["A2", ["G3", "A3", "C#4", "E4"]],
    ["G2", ["G3", "B3", "D4", "A4"]],
    ["A2", ["A3", "C#4", "E4", "G4"]],
    ["A2", ["A3", "D4", "E4", "F#4"]],
    ["D2", ["D3", "A3", "D4", "F#4", "E5"]],
  ];
  bars.forEach(([bass, voicing], bar) => {
    const b = bar * 4;
    if (bar < 11) {
      s.note(0, b, bass, 2.8, 48);
      const order = bar < 2 ? [0, 2, 1, 3] : [0, 1, 2, 3, 2, 1];
      order.forEach((j, k) =>
        s.note(
          bar >= 4 ? 1 : 0,
          b + k * (bar < 2 ? 1 : 0.5),
          voicing[j],
          1.25,
          bar >= 7 ? 48 : 43,
        ),
      );
      if (bar >= 2)
        s.chord(
          3,
          b,
          voicing.slice(1).map(midiNote),
          3.86,
          bar >= 7 ? 56 : 45,
          0.045,
        );
      if (bar >= 4) s.note(4, b, bass, 3.8, 52);
    } else {
      s.chord(0, b + 1.6, voicing, 3.0, 60, 0.028);
      s.note(4, b, bass, 3.6, 47);
      s.chord(3, b, voicing.slice(1), 3.7, 47, 0.04);
      s.note(5, b + 2, "D6", 1.1, 43);
    }
  });
  // A: an invitation, an answer; B: the same identity reaches higher, then comes home.
  const melody = [
    [
      [0, "F#4", 0.82, 69],
      [1, "A4", 0.42, 72],
      [1.5, "D5", 1.25, 78],
      [3, "E5", 0.6, 68],
    ],
    [
      [0, "F#5", 1.2, 77],
      [1.5, "D5", 0.45, 68],
      [2, "B4", 1.45, 71],
    ],
    [
      [0, "D5", 0.8, 75],
      [1, "B4", 0.42, 69],
      [1.5, "A4", 0.4, 66],
      [2, "G4", 1.25, 70],
      [3.5, "B4", 0.4, 66],
    ],
    [
      [0, "C#5", 1.0, 73],
      [1.5, "B4", 0.42, 68],
      [2, "A4", 1.65, 67],
    ],
    [
      [0, "F#5", 0.75, 80],
      [1, "E5", 0.43, 75],
      [1.5, "D5", 0.42, 74],
      [2, "A4", 1.2, 71],
      [3.5, "D5", 0.42, 77],
    ],
    [
      [0, "F#5", 0.84, 80],
      [1, "A5", 0.42, 79],
      [1.5, "F#5", 0.4, 75],
      [2, "E5", 0.85, 72],
      [3, "D5", 0.76, 70],
    ],
    [
      [0, "G5", 1.2, 80],
      [1.5, "F#5", 0.4, 75],
      [2, "E5", 0.7, 76],
      [3, "B4", 0.7, 70],
    ],
    [
      [0, "C#5", 0.8, 78],
      [1, "E5", 0.4, 80],
      [1.5, "F#5", 0.4, 83],
      [2, "A5", 1.7, 86],
    ],
    [
      [0, "B5", 0.84, 82],
      [1, "A5", 0.5, 78],
      [2, "F#5", 0.8, 75],
      [3, "D5", 0.8, 73],
    ],
    [
      [0, "E5", 1.2, 76],
      [1.5, "D5", 0.42, 72],
      [2, "C#5", 1.55, 69],
    ],
    [
      [0, "D5", 0.9, 70],
      [1.3, "E5", 0.6, 66],
      [2.3, "C#5", 1.25, 64],
    ],
    [[0, "D5", 2.8, 66]],
  ];
  melody.forEach((m, bar) => s.phrase(bar < 2 ? 0 : 2, bar, m));
  // The piano returns under the flute, with gaps rather than perpetual arpeggiation.
  s.phrase(0, 7, [
    [0.25, "A4", 0.7, 52],
    [1.25, "B4", 0.7, 57],
    [2.75, "C#5", 0.8, 53],
  ]);
  s.phrase(0, 8, [
    [0.25, "D5", 0.8, 54],
    [1.75, "B4", 0.8, 50],
    [3, "A4", 0.7, 47],
  ]);
  s.phrase(5, 8, [[0, "G6", 1.2, 40]]);
  s.swell(3, [
    [0, 42],
    [6, 54],
    [12, 80],
    [17, 68],
    [21, 91],
    [25, 72],
    [29, 53],
    [32, 28],
  ]);
  return s;
}

export function sunnyRail() {
  const s = makeScore(
    "sunny-rail",
    36,
    112,
    4,
    [
      instrument(0, 0, "Jazz piano", 81, 48, 25),
      instrument(1, 24, "Nylon guitar", 70, 84, 26),
      instrument(2, 32, "Upright bass", 99, 64, 18),
      instrument(3, 11, "Vibraphone", 73, 39, 38),
      instrument(4, 71, "Clarinet", 71, 75, 38),
      instrument(9, 40, "Brush kit", 59, 62, 25),
    ],
    [
      { at: 0.28, label: "Station bell / piano pickup" },
      { at: 4.57, label: "A · guitar, bass and brushes roll in" },
      { at: 13.14, label: "Clarinet answers the vibraphone" },
      { at: 17.42, label: "B · borrowed minor colour at the windmill" },
      { at: 25.99, label: "Theme returns / approaching home" },
      { at: 32.42, label: "F6/9 cadence, wheels slow, room tail" },
    ],
  );
  const bars = [
    ["F2", ["A3", "C4", "D4", "G4"]],
    ["D2", ["F3", "A3", "C4", "E4"]],
    ["G2", ["F3", "A3", "Bb3", "D4"]],
    ["C2", ["E3", "Bb3", "D4", "A4"]],
    ["A2", ["G3", "B3", "C4", "E4"]],
    ["D2", ["F#3", "C4", "E4", "A4"]],
    ["G2", ["F3", "Bb3", "D4", "A4"]],
    ["C2", ["E3", "G3", "Bb3", "D4"]],
    ["Bb1", ["F3", "A3", "D4", "C5"]],
    ["Bb1", ["F3", "Ab3", "Db4", "G4"]],
    ["A1", ["F3", "A3", "C4", "G4"]],
    ["F#2", ["A3", "C4", "D4", "F#4"]],
    ["G2", ["F3", "Bb3", "D4", "A4"]],
    ["C2", ["E3", "Bb3", "D4", "G4"]],
    ["F2", ["F3", "A3", "C4", "D4"]],
    ["F2", ["F3", "A3", "C4", "D4", "G4"]],
  ];
  const swing = (x) =>
    Math.floor(x) + (Math.abs((x % 1) - 0.5) < 0.001 ? 0.57 : x % 1);
  bars.forEach(([bass, vs], bar) => {
    const b = bar * 4,
      r = midiNote(bass),
      next = midiNote(bars[Math.min(15, bar + 1)][0]);
    if (bar < 15) {
      const walking = [r, r + 7, r + 12, next + (next > r ? -1 : 1)];
      walking.forEach((p, k) => s.note(2, b + k, p, 0.78, k === 0 ? 71 : 61));
      [0, 2.5].forEach((off, k) =>
        s.chord(1, b + swing(off), vs, 0.7, k ? 55 : 63, 0.022),
      );
      if (bar >= 2) {
        s.note(9, b, 36, 0.2, 39);
        s.note(9, b + 2, 36, 0.2, 33);
        s.note(9, b + 1, 38, 0.22, 38);
        s.note(9, b + 3, 38, 0.22, 42);
        for (let k = 0; k < 8; k++)
          s.note(9, b + swing(k / 2), 42, 0.15, k % 2 ? 23 : 32);
        if (bar % 4 === 3 && bar !== 11) {
          s.note(9, b + 3.57, 38, 0.12, 27);
          s.note(9, b + 3.82, 38, 0.1, 22);
        }
      }
      if (bar < 2 || (bar >= 8 && bar < 12)) s.chord(0, b + 1.57, vs, 1.1, 48);
    } else {
      s.note(2, b, r, 3.25, 64);
      s.chord(0, b, vs, 4.5, 63, 0.037);
      s.chord(1, b, vs, 3.6, 53, 0.034);
      s.note(3, b + 0.5, "F5", 2.7, 54);
      s.note(9, b, 49, 0.5, 27);
    }
  });
  const melody = [
    [
      [0.5, "A4", 0.8],
      [1.5, "C5", 0.4],
      [2, "D5", 0.6],
      [3, "C5", 0.5],
    ],
    [
      [0, "A4", 1.1],
      [1.5, "F4", 0.7],
      [3, "E4", 0.5],
    ],
    [
      [0, "G4", 0.4],
      [0.5, "A4", 0.4],
      [1, "Bb4", 0.8],
      [2.5, "D5", 0.8],
    ],
    [
      [0, "E5", 0.7],
      [1, "D5", 0.4],
      [1.5, "C5", 0.6],
      [2.5, "A4", 0.9],
    ],
    [
      [0, "C5", 0.8],
      [1.5, "E5", 0.8],
      [3, "G5", 0.6],
    ],
    [
      [0, "F#5", 1.1],
      [1.5, "E5", 0.4],
      [2, "D5", 0.9],
      [3.5, "C5", 0.35],
    ],
    [
      [0, "Bb4", 0.6],
      [1, "A4", 0.4],
      [1.5, "G4", 1.1],
      [3, "D5", 0.6],
    ],
    [
      [0, "E5", 0.5],
      [1, "D5", 0.4],
      [1.5, "C5", 0.6],
      [2.5, "G4", 0.85],
    ],
    [
      [0, "F5", 1.2],
      [1.5, "D5", 0.6],
      [2.5, "C5", 1],
    ],
    [
      [0, "Db5", 1.15],
      [1.5, "C5", 0.5],
      [2.5, "Ab4", 1],
    ],
    [
      [0, "A4", 0.6],
      [1, "C5", 0.4],
      [1.5, "D5", 0.7],
      [2.5, "F5", 0.9],
    ],
    [
      [0, "F#5", 0.8],
      [1.5, "E5", 0.7],
      [2.5, "D5", 1.0],
    ],
    [
      [0, "Bb4", 0.5],
      [0.5, "D5", 0.45],
      [1, "F5", 0.8],
      [2.5, "A5", 0.7],
      [3.5, "G5", 0.3],
    ],
    [
      [0, "E5", 0.8],
      [1.5, "D5", 0.45],
      [2, "C5", 0.8],
      [3, "Bb4", 0.65],
    ],
    [
      [0, "A4", 0.9],
      [1.5, "G4", 0.65],
      [2.5, "F4", 1.1],
    ],
    [[0, "F4", 3.0]],
  ];
  melody.forEach((m, bar) =>
    s.phrase(
      bar < 2 ? 0 : bar >= 6 && bar < 12 ? 4 : 3,
      bar,
      m.map(([b, p, d]) => [swing(b), p, d, bar >= 12 ? 78 : 72]),
    ),
  );
  s.phrase(0, 12, [
    [0.5, "G4", 0.55, 47],
    [2, "A4", 0.65, 48],
  ]);
  s.phrase(0, 13, [
    [0.5, "G4", 0.5, 49],
    [2.5, "E4", 0.9, 48],
  ]);
  return s;
}

export function tinySeed() {
  const s = makeScore(
    "tiny-seed",
    36,
    90,
    3,
    [
      instrument(0, 0, "Intimate piano", 86, 58, 49),
      instrument(1, 46, "Harp", 59, 85, 52),
      instrument(2, 42, "Cello", 61, 40, 46),
      instrument(3, 48, "Soft strings", 60, 79, 56),
      instrument(4, 8, "Celesta", 49, 90, 50),
      instrument(5, 73, "Flute", 60, 56, 48),
    ],
    [
      { at: 0.28, label: "A · three-note seed motif / space" },
      { at: 6.28, label: "Rain, darker harmony and low register" },
      { at: 12.28, label: "Cello takes root / rising line" },
      { at: 20.28, label: "B · full phrase as petals unfold" },
      { at: 26.28, label: "Bee lands / music makes room" },
      { at: 30.28, label: "Gmaj9 home chord / a new seed departs" },
    ],
  );
  const bars = [
    ["G2", ["G3", "D4", "A4", "B4"]],
    ["F#2", ["A3", "D4", "F#4"]],
    ["E2", ["G3", "B3", "D4", "F#4"]],
    ["B2", ["A3", "D4", "F#4"]],
    ["C3", ["G3", "B3", "D4", "E4"]],
    ["B2", ["G3", "B3", "D4"]],
    ["A2", ["G3", "B3", "C4", "E4"]],
    ["D3", ["A3", "C4", "E4", "F#4"]],
    ["E3", ["G3", "B3", "D4", "F#4"]],
    ["C3", ["G3", "B3", "D4", "E4"]],
    ["G2", ["G3", "B3", "D4", "A4"]],
    ["D3", ["A3", "C4", "E4", "F#4"]],
    ["C3", ["G3", "B3", "D4", "E4"]],
    ["A2", ["G3", "B3", "C4", "E4"]],
    ["D3", ["A3", "C4", "D4", "F#4"]],
    ["G2", ["G3", "B3", "D4", "A4"]],
  ];
  bars.forEach(([bass, vs], bar) => {
    const b = bar * 3;
    if (bar < 15) {
      s.note(0, b, bass, 2.65, bar < 4 ? 41 : 48);
      if (bar >= 4)
        [0, 1, 2, 3].forEach((j, k) =>
          s.note(
            1,
            b + k * 0.5,
            vs[j % vs.length],
            1.35,
            42 + Math.min(bar, 11),
          ),
        );
      if (bar >= 6) {
        s.note(2, b, bass, 2.92, 49);
        s.chord(3, b, vs.slice(1), 2.9, bar >= 10 ? 52 : 41, 0.045);
      }
    } else {
      s.note(2, b, bass, 4.25, 45);
      s.chord(0, b, vs, 4.7, 55, 0.05);
      s.chord(3, b, vs.slice(1), 4.1, 45, 0.05);
      s.note(4, b + 1.5, "G5", 2.1, 43);
      s.note(1, b + 3, "D6", 1.6, 39);
      s.note(1, b + 4.0, "G6", 1.25, 34);
    }
  });
  const melody = [
    [
      [0, "G4", 0.9, 61],
      [1.5, "B4", 0.65, 63],
    ],
    [
      [0, "A4", 0.8, 62],
      [1, "F#4", 1.4, 56],
    ],
    [
      [0, "G4", 0.7, 60],
      [1, "B4", 0.55, 62],
      [2, "E5", 0.8, 66],
    ],
    [
      [0, "D5", 1.4, 60],
      [2, "B4", 0.7, 53],
    ],
    [
      [0, "E5", 0.8, 65],
      [1, "D5", 0.6, 61],
      [2, "B4", 0.6, 60],
    ],
    [
      [0, "D5", 0.6, 63],
      [1, "B4", 0.6, 58],
      [2, "G4", 0.75, 56],
    ],
    [
      [0, "A4", 1.25, 62],
      [1.5, "B4", 0.55, 65],
      [2.25, "C5", 0.55, 68],
    ],
    [
      [0, "D5", 1.3, 67],
      [1.5, "E5", 0.55, 69],
      [2.25, "F#5", 0.55, 70],
    ],
    [
      [0, "G5", 1.0, 74],
      [1.5, "F#5", 0.6, 69],
      [2.25, "E5", 0.6, 68],
    ],
    [
      [0, "E5", 0.6, 70],
      [1, "G5", 0.6, 74],
      [2, "B5", 0.85, 76],
    ],
    [
      [0, "A5", 1.25, 78],
      [1.5, "G5", 0.6, 74],
      [2.25, "D5", 0.55, 69],
    ],
    [
      [0, "F#5", 0.8, 74],
      [1, "E5", 0.65, 71],
      [2, "D5", 0.8, 68],
    ],
    [
      [0, "E5", 0.95, 67],
      [1.5, "D5", 0.6, 63],
      [2.25, "B4", 0.55, 60],
    ],
    [
      [0, "C5", 1.4, 61],
      [2, "B4", 0.75, 57],
    ],
    [
      [0, "A4", 0.85, 60],
      [1, "F#4", 0.7, 57],
      [2, "D4", 0.6, 54],
    ],
    [[0, "G4", 3.9, 58]],
  ];
  melody.forEach((m, bar) => s.phrase(bar >= 8 && bar < 12 ? 5 : 0, bar, m));
  s.phrase(4, 10, [
    [0, "G6", 1.3, 42],
    [2, "D6", 0.8, 37],
  ]);
  s.swell(3, [
    [0, 30],
    [10, 39],
    [15, 62],
    [20, 88],
    [24, 92],
    [27, 65],
    [31, 47],
    [35, 28],
  ]);
  s.swell(2, [
    [0, 45],
    [12, 59],
    [18, 78],
    [24, 71],
    [31, 53],
    [35, 28],
  ]);
  return s;
}
export function allScores() {
  return [paperWings(), sunnyRail(), tinySeed()];
}
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
  const header = Buffer.alloc(14);
  header.write("MThd");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(480, 12);
  const track = Buffer.alloc(8);
  track.write("MTrk");
  track.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, track, Buffer.from(bytes)]);
}
