import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { cameraCurve, type CameraKey } from "../../src/engine/camera-curve";
import {
  trainProgress,
  arcLengthLookup,
} from "../../projects/sunny-rail/motion.mjs";
import {
  allScores,
  scoreEvents,
  scoreMidi,
  midiNote,
} from "../../scripts/music/scores.mjs";

const keys: CameraKey[] = [
  [0, 1],
  [4, 1.8],
  [9, 1.3],
  [15, 1.1],
  [20, 1.1],
  [28, 1.65],
  [36, 1],
];
describe("continuous camera curves", () => {
  it("passes through every key and clamps outside the film", () => {
    for (const [t, v] of keys) expect(cameraCurve(t, keys)).toBeCloseTo(v, 9);
    expect(cameraCurve(-1, keys)).toBe(1);
    expect(cameraCurve(99, keys)).toBe(1);
    expect(cameraCurve(2, [])).toBe(0);
    expect(cameraCurve(2, [[0, 8]])).toBe(8);
  });
  it("does not overshoot its framing bounds", () => {
    for (let i = 1; i < keys.length; i++)
      for (let k = 0; k <= 100; k++) {
        const value = cameraCurve(
          keys[i - 1][0] + ((keys[i][0] - keys[i - 1][0]) * k) / 100,
          keys,
        );
        expect(value).toBeGreaterThanOrEqual(
          Math.min(keys[i - 1][1], keys[i][1]) - 1e-9,
        );
        expect(value).toBeLessThanOrEqual(
          Math.max(keys[i - 1][1], keys[i][1]) + 1e-9,
        );
      }
  });
  it("has continuous velocity across all joins, including reversals", () => {
    const eps = 0.0001;
    for (const [t, v] of keys) {
      const left = (v - cameraCurve(t - eps, keys)) / eps;
      const right = (cameraCurve(t + eps, keys) - v) / eps;
      expect(Math.abs(left - right)).toBeLessThan(0.0002);
    }
  });
  it("evaluates independently of seek history", () => {
    const before = cameraCurve(13.735, keys);
    cameraCurve(32, keys);
    cameraCurve(0, keys);
    expect(cameraCurve(13.735, keys)).toBe(before);
  });
});
describe("distance-synchronised train and foley", () => {
  it("departs gently, keeps cruising speed, and comes fully to rest", () => {
    expect(trainProgress(0)).toBe(0);
    expect(trainProgress(1.25)).toBe(0);
    expect(trainProgress(33.2)).toBeCloseTo(1, 12);
    expect(trainProgress(36)).toBeCloseTo(1, 12);
    expect(trainProgress(1.26)).toBeLessThan(0.000001);
    const step1 = trainProgress(10.2) - trainProgress(10),
      step2 = trainProgress(20.2) - trainProgress(20);
    expect(step1).toBeCloseTo(step2, 10);
    let previous = 0;
    for (let t = 0; t <= 36; t += 0.01) {
      const p = trainProgress(t);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = p;
    }
  });
  it("follows equal arc lengths rather than constant angles around the oval", () => {
    const point = (a: number) => ({
      x: Math.sin(a) * 7.4,
      y: 0.21 + Math.pow(Math.max(0, Math.sin(a)), 8) * 0.32,
      z: Math.cos(a) * 4.7,
    });
    const arc = arcLengthLookup(point);
    expect(arc.total).toBeGreaterThan(38);
    expect(arc.total).toBeLessThan(40);
    for (let i = 0; i < 30; i++) {
      const d = (i * arc.total) / 30,
        a = point(arc.parameter(d)),
        b = point(arc.parameter(d + 2.08));
      const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(gap).toBeGreaterThan(2.0);
      expect(gap).toBeLessThan(2.09);
    }
    expect(arc.parameter(-2.08)).toBeCloseTo(
      arc.parameter(arc.total - 2.08),
      10,
    );
  });
});
describe("authored instrumental scores", () => {
  it("keeps three distinct ensembles and phrase structures", () => {
    const scores = allScores();
    expect(scores.map((s) => s.id)).toEqual([
      "paper-wings",
      "sunny-rail",
      "tiny-seed",
    ]);
    expect(
      new Set(scores.map((s) => JSON.stringify(s.notes.map((n) => n.pitch))))
        .size,
    ).toBe(3);
    expect(scores.map((s) => s.bpm)).toEqual([96, 112, 90]);
    expect(scores[2].meter).toBe(3);
    for (const s of scores) {
      expect(s.instruments).toHaveLength(6);
      expect(s.cues.length).toBeGreaterThanOrEqual(6);
    }
  });
  it("uses valid pitch names and rejects ambiguous ones", () => {
    expect(midiNote("C4")).toBe(60);
    expect(midiNote("F#4")).toBe(66);
    expect(midiNote("Bb3")).toBe(58);
    expect(() => midiNote("not a note")).toThrow();
  });
  for (const score of allScores())
    it(score.id + " has a complete legal, deterministic MIDI score", () => {
      expect(score.notes.length).toBeGreaterThan(100);
      for (const note of score.notes) {
        expect(note.t).toBeGreaterThanOrEqual(0);
        expect(note.end).toBeGreaterThan(note.t);
        expect(note.end).toBeLessThan(score.duration);
        expect(note.pitch).toBeGreaterThanOrEqual(0);
        expect(note.pitch).toBeLessThanOrEqual(127);
        expect(note.velocity).toBeGreaterThan(0);
        expect(note.velocity).toBeLessThan(128);
      }
      const events = scoreEvents(score);
      for (let i = 1; i < events.length; i++)
        expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
      const midi = scoreMidi(score);
      expect(midi.subarray(0, 4).toString()).toBe("MThd");
      expect(midi.subarray(14, 18).toString()).toBe("MTrk");
      expect(midi.readUInt32BE(18)).toBe(midi.length - 22);
      expect(midi).toEqual(
        scoreMidi(allScores().find((s) => s.id === score.id)!),
      );
      expect(
        fs.readFileSync(
          `projects/${score.id}/production/music/${score.id}.mid`,
        ),
      ).toEqual(midi);
    });
});
function pcm(bytes: Buffer) {
  let sampleRate = 0,
    channels = 0,
    bits = 0,
    offset = 0,
    size = 0;
  for (let i = 12; i + 8 <= bytes.length;) {
    const tag = bytes.subarray(i, i + 4).toString(),
      len = bytes.readUInt32LE(i + 4);
    if (tag === "fmt ") {
      expect(bytes.readUInt16LE(i + 8)).toBe(1);
      channels = bytes.readUInt16LE(i + 10);
      sampleRate = bytes.readUInt32LE(i + 12);
      bits = bytes.readUInt16LE(i + 22);
    }
    if (tag === "data") {
      offset = i + 8;
      size = len;
      break;
    }
    i += 8 + len + (len % 2);
  }
  return { sampleRate, channels, bits, offset, frames: size / 4 };
}
describe("actual delivered 48 kHz stereo masters", () => {
  const report = {
    tracks: allScores().flatMap(
      (score) =>
        JSON.parse(
          fs.readFileSync(
            `projects/${score.id}/production/music/render-report.json`,
            "utf8",
          ),
        ).tracks,
    ),
  } as {
    tracks: {
      id: string;
      integratedLUFS: number;
      truePeakDBTP: number;
      sha256: string;
    }[];
  };
  for (const score of allScores())
    it(
      score.id +
        " matches measured, unclipped, non-silent PCM and has a quiet tail",
      () => {
        const bytes = fs.readFileSync(
            `projects/${score.id}/public/audio/${score.id}.wav`,
          ),
          info = pcm(bytes),
          r = report.tracks.find((r) => r.id === score.id)!;
        expect(info.sampleRate).toBe(48000);
        expect(info.channels).toBe(2);
        expect(info.bits).toBe(16);
        expect(info.frames / info.sampleRate).toBe(score.duration);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.sha256);
        expect(r.integratedLUFS).toBeGreaterThan(-18.8);
        expect(r.integratedLUFS).toBeLessThan(-17.2);
        expect(r.truePeakDBTP).toBeLessThan(-1.5);
        let energy = 0,
          tail = 0,
          peak = 0,
          l2 = 0,
          r2 = 0,
          lr = 0;
        for (let i = 0; i < info.frames; i += 8) {
          const l = bytes.readInt16LE(info.offset + i * 4) / 32768,
            r = bytes.readInt16LE(info.offset + i * 4 + 2) / 32768;
          energy += l * l + r * r;
          l2 += l * l;
          r2 += r * r;
          lr += l * r;
          peak = Math.max(peak, Math.abs(l), Math.abs(r));
          if (i >= info.frames - info.sampleRate * 0.15) tail += l * l + r * r;
        }
        expect(peak).toBeLessThan(0.9);
        expect(Math.sqrt(energy / ((info.frames / 8) * 2))).toBeGreaterThan(
          0.015,
        );
        expect(lr / Math.sqrt(l2 * r2)).toBeGreaterThan(-0.1);
        expect(
          Math.sqrt(tail / (((info.sampleRate * 0.15) / 8) * 2)),
        ).toBeLessThan(0.003);
      },
    );
});

it("asset rebuild preserves mastered audio, curated licensing and unrelated imports", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "frame-demo-assets-"),
  );
  const root = process.cwd();
  try {
    for (const score of allScores())
      fs.mkdirSync(path.join(temporary, "projects", score.id, "public/audio"), {
        recursive: true,
      });
    fs.mkdirSync(path.join(temporary, "projects/paper-wings/public/imports"), {
      recursive: true,
    });
    const originals = new Map<string, Buffer>();
    for (const score of allScores()) {
      const bytes = fs.readFileSync(
        path.join(
          root,
          "projects",
          score.id,
          "public/audio",
          score.id + ".wav",
        ),
      );
      originals.set(score.id, bytes);
      fs.writeFileSync(
        path.join(
          temporary,
          "projects",
          score.id,
          "public/audio",
          score.id + ".wav",
        ),
        bytes,
      );
    }
    fs.writeFileSync(
      path.join(temporary, "projects/paper-wings/public/ASSET-LICENSES.md"),
      "KEEP-CURATED-LICENSE",
    );
    fs.writeFileSync(
      path.join(temporary, "projects/paper-wings/public/imports/retained.svg"),
      "<svg/>",
    );
    fs.writeFileSync(
      path.join(temporary, "projects/paper-wings/public/assets.json"),
      JSON.stringify([
        {
          url: "films/paper-wings/imports/retained.svg",
          name: "retained.svg",
          type: "image",
          bytes: 6,
          license: "retained-license",
        },
      ]),
    );
    execFileSync(
      process.execPath,
      [
        path.join(root, "scripts/prepare-assets.mjs"),
        "--project",
        "paper-wings",
      ],
      { cwd: temporary, timeout: 25000, windowsHide: true, stdio: "pipe" },
    );
    for (const [id, bytes] of originals)
      expect(
        createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(temporary, "projects", id, "public/audio", id + ".wav"),
            ),
          )
          .digest("hex"),
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(
      fs.readFileSync(
        path.join(temporary, "projects/paper-wings/public/ASSET-LICENSES.md"),
        "utf8",
      ),
    ).toBe("KEEP-CURATED-LICENSE");
    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(temporary, "projects/paper-wings/public/assets.json"),
        "utf8",
      ),
    ) as { url: string; license: string }[];
    expect(
      catalog.find((a) => a.url === "films/paper-wings/imports/retained.svg")
        ?.license,
    ).toBe("retained-license");
    expect(
      catalog.find((a) => a.url === "films/paper-wings/art/cloud.svg")?.license,
    ).toContain("Original");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);
