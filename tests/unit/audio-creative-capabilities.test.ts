import { describe, expect, it } from "vitest";
import { getAuthoringCapabilities } from "../../src/contracts/capabilities.mjs";
import { toneFeatureGroups } from "../../src/contracts/audio-library-catalog.mjs";

describe("AI creative audio discovery", () => {
  it("finds real sample, stretch, analysis and event APIs from the shared catalog", () => {
    for (const name of [
      "Sampler",
      "GrainPlayer",
      "FrequencyShifter",
      "Sequence",
      "FFT",
      "Recorder",
      "UserMedia",
      "formantCompensation",
      "preservePitch",
    ]) {
      const items = getAuthoringCapabilities({
        category: "audio",
        query: name,
      }).items;
      expect(items.length, name).toBeGreaterThan(0);
      expect(items.every((item) => item.category === "audio")).toBe(true);
    }
    const input = getAuthoringCapabilities({ id: "tone-live-input" }).items[0];
    expect(input.supports).toMatchObject({ realtime: true, offline: false });
    expect(input.requirements.join(" ")).toContain("明确允许");
    const stretch = getAuthoringCapabilities({ id: "signalsmith" }).items[0];
    expect(stretch.package).toBe("signalsmith-stretch");
    expect(stretch.reference.key).toBe("audio-creative");
    expect(
      stretch.integration.helpers?.map((helper) => helper.entry).join(" "),
    ).toContain("createSignalsmithNode");
  });

  it("exposes every pinned Tone group without forcing one creative workflow", () => {
    for (const group of toneFeatureGroups) {
      const item = getAuthoringCapabilities({ id: "tone-" + group.id })
        .items[0];
      expect(item.kind).toBe("helper-library");
      expect(item.integration.helpers?.map((helper) => helper.entry)).toEqual(
        group.exports.map((name) => "Tone." + name),
      );
      expect(item.requirements.join(" ")).toContain("绝对时间");
    }
    expect(
      toneFeatureGroups.find((group) => group.id === "effect")?.exports,
    ).toHaveLength(18);
  });
});
