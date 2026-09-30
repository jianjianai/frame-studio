import { createHash } from "node:crypto";
import { BasicSoundBank, SoundBankLoader, SpessaLog } from "spessasynth_core";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Lossless, independently verifiable preset files. Originals remain in the export. */
export function splitSoundfont(bytes, { onPart } = {}) {
  SpessaLog.setLogLevel(false, false, false);
  const source = SoundBankLoader.fromArrayBuffer(
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
  );
  if (source.customDefaultModulators) return null;
  const parts = [],
    keys = {},
    presets = new Map();
  for (const drum of [false, true])
    for (let program = 0; program < 128; program++) {
      const preset = source.getPreset(
        { program, bankMSB: 0, bankLSB: 0, isGMGSDrum: drum },
        "gs",
      );
      let index = presets.get(preset);
      if (index === undefined) {
        const bank = new BasicSoundBank("sf2");
        bank.soundBankInfo = { ...source.soundBankInfo };
        bank.clonePreset(preset);
        const binary = Buffer.from(bank.writeSF2()),
          digest = sha(binary);
        index = parts.length;
        const part = { file: digest + ".sf2", sha256: digest, bytes: binary };
        onPart?.(part);
        parts.push(onPart ? { ...part, bytes: binary.length } : part);
        presets.set(preset, index);
      }
      keys[(drum ? "drum:" : "program:") + program] = index;
    }
  return {
    manifest: {
      version: 1,
      sourceSha256: sha(bytes),
      keys,
      parts: parts.map(({ file, sha256, bytes }) => ({
        file,
        sha256,
        bytes: typeof bytes === "number" ? bytes : bytes.length,
      })),
    },
    parts,
  };
}
