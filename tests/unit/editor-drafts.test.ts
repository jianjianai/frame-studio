import { describe, expect, it } from "vitest";
import {
  mergeJsonDraft,
  parseNumberDraft,
  stretchMode,
  stretchPreset,
} from "../../studio/editor-drafts.mjs";
import { audioProcessorSchema } from "../../src/engine/audio-document.mjs";
import {
  defaultToneOptions,
  toneEffectLabels,
} from "../../src/engine/tone-effect-options.mjs";

describe("editor drafts", () => {
  it("preserves signed/fractional values and rejects incomplete numeric text", () => {
    expect(parseNumberDraft("-7", { min: -48, max: 48 })).toEqual({
      value: -7,
    });
    expect(parseNumberDraft(".5")).toEqual({ value: 0.5 });
    expect(parseNumberDraft("1e-3")).toEqual({ value: 0.001 });
    for (const text of ["", "-", ".", "1e", "1e-", "+"])
      expect(
        parseNumberDraft(text, { allowExpression: true }).error,
      ).toBeTruthy();
    expect(parseNumberDraft("4n", { allowExpression: true })).toEqual({
      value: "4n",
    });
    expect(parseNumberDraft('{"4n":2}', { allowExpression: true })).toEqual({
      value: { "4n": 2 },
    });
    expect(parseNumberDraft("8", { max: 4 }).error).toBeTruthy();
  });
  it("merges independent nested edits and deletions while surfacing overlapping edits", () => {
    const base = { wet: 0.25, filter: { Q: 1, type: "lowpass" }, obsolete: 3 };
    const draft = { wet: 0.25, filter: { Q: 2, type: "lowpass" } };
    const current = { ...base, wet: 0.5, filter: { Q: 1, type: "highpass" } };
    expect(mergeJsonDraft(base, draft, current)).toEqual({
      value: { wet: 0.5, filter: { Q: 2, type: "highpass" } },
      conflicts: [],
    });
    const conflict = mergeJsonDraft(
      base,
      { ...base, wet: 0.4 },
      { ...base, wet: 0.5 },
    );
    expect(conflict.conflicts).toEqual(["wet"]);
    expect(
      mergeJsonDraft(
        base,
        { ...base, wet: 0.4 },
        { ...base, wet: 0.5 },
        "current",
      ).value.wet,
    ).toBe(0.5);
    expect(
      mergeJsonDraft({ a: [1] }, { a: [2] }, { a: [3] }).conflicts,
    ).toEqual(["a"]);
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(
      Object.hasOwn(mergeJsonDraft({}, hostile, {}).value, "__proto__"),
    ).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("makes manual windows and presets unambiguous without discarding timbre controls", () => {
    const options = {
      preset: "default",
      blockMs: 500,
      intervalMs: 250,
      formantSemitones: -7,
    };
    expect(stretchMode(options)).toBe("manual");
    const cheaper = stretchPreset(options, "cheaper");
    expect(cheaper).toEqual({
      ...options,
      preset: "cheaper",
      blockMs: 0,
      intervalMs: 0,
    });
    expect(stretchMode(cheaper)).toBe("cheaper");
    const manual = stretchPreset(cheaper, "manual");
    expect(manual.blockMs).toBeGreaterThan(0);
    expect(manual.intervalMs).toBeLessThanOrEqual(manual.blockMs);
    expect(manual.formantSemitones).toBe(-7);
  });
});

describe("shared Tone options contract", () => {
  const parse = (effect: string, options: Record<string, unknown>) =>
    audioProcessorSchema.safeParse({ type: "tone", effect, options });
  it("validates every editor default through the same document schema", () => {
    for (const effect of Object.keys(toneEffectLabels))
      expect(parse(effect, defaultToneOptions(effect)).success, effect).toBe(
        true,
      );
  });
  it("rejects confirmed official scalar violations without inventing upper bounds", () => {
    for (const [effect, options] of [
      ["Reverb", { decay: -1 }],
      ["Reverb", { decay: "-1s" }],
      ["Reverb", { decay: "-1" }],
      ["Reverb", { preDelay: -0.1 }],
      ["BitCrusher", { bits: 17 }],
      ["Chebyshev", { order: 1.5 }],
      ["AutoPanner", { depth: 2 }],
      ["Tremolo", { depth: 2 }],
      ["Vibrato", { depth: 2 }],
      ["StereoWidener", { width: 2 }],
      ["JCReverb", { roomSize: -1 }],
      ["FeedbackDelay", { feedback: 1.1 }],
      ["Reverb", { wet: 2 }],
    ] as [string, Record<string, unknown>][])
      expect(parse(effect, options).success, effect).toBe(false);
    expect(parse("Reverb", { decay: 31 }).success).toBe(true);
    expect(parse("BitCrusher", { bits: 4.5 }).success).toBe(true);
    expect(parse("FrequencyShifter", { frequency: -440 }).success).toBe(true);
    expect(parse("FeedbackDelay", { delayTime: "4n" }).success).toBe(true);
    expect(parse("FeedbackDelay", { delayTime: { "8n": 2 } }).success).toBe(
      true,
    );
    expect(parse("Phaser", { stages: 25 }).success).toBe(true);
    expect(parse("Distortion", { distortion: 2 }).success).toBe(true);
    expect(parse("Reverb", { context: {} }).success).toBe(false);
  });
});
