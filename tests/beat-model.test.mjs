import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEAT_THIS_MODEL, beatThisModel } from "../server/audio-analysis.mjs";

describe("Beat This! model in the data folder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is downloaded once into the folder, and a failed download leaves nothing behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-beat-model-"));
    const file = path.join(dir, BEAT_THIS_MODEL.file);
    const calls = [];
    // The host is down first, then answers.
    vi.stubGlobal("fetch", async (url) => {
      calls.push(url);
      return calls.length === 1 ? new Response("down", { status: 503 }) : new Response(new Uint8Array([1, 2, 3]));
    });
    await expect(beatThisModel(dir)).rejects.toMatchObject({ code: "NO_BEAT_MODEL", message: expect.stringContaining("HTTP 503") });
    expect(fs.readdirSync(dir)).toEqual([]);
    // Two analyses asking at once share one download.
    const [first, second] = await Promise.all([beatThisModel(dir), beatThisModel(dir)]);
    expect(first).toBe(file);
    expect(second).toBe(file);
    expect(fs.readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
    expect(calls).toEqual([BEAT_THIS_MODEL.url, BEAT_THIS_MODEL.url]);
    // There already: nothing fetched.
    await beatThisModel(dir);
    expect(calls).toHaveLength(2);
  });
});
