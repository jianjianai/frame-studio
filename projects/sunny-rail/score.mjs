import { makeScore, instrument, midiNote } from '../../src/engine/score.mjs';
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
