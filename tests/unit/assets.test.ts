import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { waveformFromWav } from "../../scripts/waveforms.mjs";
import { testWav } from "../helpers/wav";
const root = process.cwd();
describe("actual PCM waveforms", () => {
  it("indexes every bin with finite real sound levels", () => {
    const values = waveformFromWav(testWav());
    expect(values).toHaveLength(180);
    expect(values.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(
      true,
    );
    expect(Math.max(...values)).toBeGreaterThan(0.1);
  });
  it("handles metadata chunks before the PCM data", () => {
    const original = testWav();
    const metadata = Buffer.alloc(12);
    metadata.write("LIST", 0);
    metadata.writeUInt32LE(4, 4);
    metadata.write("INFO", 8);
    const withMetadata = Buffer.concat([
      original.subarray(0, 36),
      metadata,
      original.subarray(36),
    ]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    expect(waveformFromWav(withMetadata)).toEqual(waveformFromWav(original));
  });
  it("rejects truncated or unsupported audio instead of fabricating a waveform", () => {
    const data = testWav();
    expect(() => waveformFromWav(data.subarray(0, 100))).toThrow();
    const other = Buffer.from(data);
    other.writeUInt16LE(3, 20);
    expect(() => waveformFromWav(other)).toThrow();
  });
});
describe("local asset imports", () => {
  it("keeps source bytes and makes duplicate-safe indexed copies", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frame-import-"));
    mkdirSync(path.join(dir, "projects/story/public"), { recursive: true });
    writeFileSync(path.join(dir, "projects/story/project.ts"), "");
    writeFileSync(path.join(dir, "projects/story/public/assets.json"), "[]");
    const source = path.join(dir, "original.svg");
    const original = readFileSync(
      path.join(root, "projects/paper-wings/public/art/paper-plane.svg"),
    );
    writeFileSync(source, original);
    try {
      for (let i = 0; i < 2; i++) {
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, "scripts/import-asset.mjs"),
            "story",
            source,
            "--license",
            "original fixture",
          ],
          { cwd: dir, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
      }
      expect(readFileSync(source)).toEqual(original);
      const catalog = JSON.parse(
        readFileSync(
          path.join(dir, "projects/story/public/assets.json"),
          "utf8",
        ),
      ) as { url: string; license: string }[];
      expect(catalog).toHaveLength(2);
      expect(catalog[0].url).not.toBe(catalog[1].url);
      for (const item of catalog) {
        expect(
          existsSync(
            path.join(
              dir,
              "projects/story/public",
              item.url.replace("films/story/", ""),
            ),
          ),
        ).toBe(true);
        expect(item.license).toBe("original fixture");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
  it("rejects a glTF with missing external resources", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frame-model-"));
    mkdirSync(path.join(dir, "projects/story/public"), { recursive: true });
    writeFileSync(path.join(dir, "projects/story/project.ts"), "");
    const source = path.join(dir, "missing.gltf");
    writeFileSync(
      source,
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "missing.bin", byteLength: 100 }],
      }),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/import-asset.mjs"), "story", source],
        { cwd: dir, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("self-contained GLB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
