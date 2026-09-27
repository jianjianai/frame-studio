import { makeScore, instrument, midiNote } from '../../../src/engine/score.mjs';
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
