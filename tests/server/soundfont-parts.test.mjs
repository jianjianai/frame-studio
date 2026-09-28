import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BasicSoundBank,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaLog,
} from "spessasynth_core";
import { splitSoundfont } from "../../scripts/soundfont-parts.mjs";

async function samples(bank, program, drum = false) {
  const synth = new SpessaSynthProcessor(44100, {
    eventsEnabled: false,
    maxBufferSize: 128,
  });
  synth.soundBankManager.addSoundBank(
    SoundBankLoader.fromArrayBuffer(bank),
    "fixture",
  );
  await synth.processorInitialized;
  const channel = drum ? 9 : 0;
  synth.processMessage([0xc0 | channel, program]);
  synth.processMessage([0x90 | channel, drum ? 38 : 60, 100]);
  const output = new Float32Array(128 * 80),
    right = new Float32Array(128);
  for (let i = 0; i < 80; i++) {
    const left = new Float32Array(128);
    right.fill(0);
    synth.process(left, right);
    output.set(left, i * 128);
  }
  synth.destroySynthProcessor();
  return output;
}
for (const [name, file] of [
  ["generated", null],
  ["GeneralUser", process.env.FRAME_TEST_SF2],
])
  test(
    `lossless instrument packages preserve ${name} synthesis`,
    { skip: name === "GeneralUser" && !file },
    async (t) => {
      SpessaLog.setLogLevel(false, false, false);
      const source = file
        ? fs.readFileSync(file)
        : Buffer.from(BasicSoundBank.getSampleSoundBankFile());
      const split = splitSoundfont(source);
      assert(split?.parts.length);
      const selection = [
          [0, false],
          [40, false],
          [73, false],
          [0, true],
        ],
        indices = new Set(
          selection.map(
            ([p, d]) => split.manifest.keys[(d ? "drum:" : "program:") + p],
          ),
        );
      const parts = [...indices].map((index) => split.parts[index].bytes),
        merged = BasicSoundBank.mergeSoundBanks(
          ...parts.map((b) =>
            SoundBankLoader.fromArrayBuffer(
              b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
            ),
          ),
        ).writeSF2();
      for (const [program, drum] of selection) {
        const original = await samples(
            source.buffer.slice(
              source.byteOffset,
              source.byteOffset + source.byteLength,
            ),
            program,
            drum,
          ),
          selected = await samples(merged, program, drum);
        let difference = 0;
        for (let i = 0; i < original.length; i++)
          difference = Math.max(
            difference,
            Math.abs(original[i] - selected[i]),
          );
        assert(
          difference < 1e-7,
          `program ${program} drum ${drum}: ${difference}`,
        );
      }
      t.diagnostic(
        JSON.stringify({
          bank: name,
          originalBytes: source.length,
          selectedBytes: parts.reduce((n, p) => n + p.length, 0),
          presetFiles: split.parts.length,
          totalPackageBytes: split.parts.reduce(
            (n, p) => n + p.bytes.length,
            0,
          ),
        }),
      );
    },
  );
