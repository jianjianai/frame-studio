import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { assetPath } from "../../scripts/project-paths.mjs";
import { projectAudioTracks, projectSchema } from "../../src/engine/types";
import { toSrt } from "../../src/engine/subtitles";
import paper from "../../projects/paper-wings/project";
import rail from "../../projects/sunny-rail/project";
import seed from "../../projects/tiny-seed/project";
for (const p of [paper, rail, seed])
  describe(p.id, () => {
    it("has valid metadata and timeline markers", () => {
      expect(projectSchema.safeParse(p).success).toBe(true);
      expect(new Set(p.beats.map((b) => b.at)).size).toBe(p.beats.length);
      expect(p.beats.every((b, i) => i === 0 || b.at > p.beats[i - 1].at)).toBe(
        true,
      );
    });
    it("resolves the declared local files or generated audio entrypoint", async () => {
      const tracks = projectAudioTracks(p);
      expect(tracks.length).toBeGreaterThan(0);
      for (const track of tracks) {
        if (track.kind === "file")
          expect(
            fs.statSync(assetPath(process.cwd(), track.src, p.id)).size,
          ).toBeGreaterThan(0);
      }
      if (tracks.some((track) => track.kind === "generated")) {
        expect(p.loadAudio).toBeTypeOf("function");
        const audio = await p.loadAudio!();
        expect(audio.createAudio).toBeTypeOf("function");
        expect(audio.prepareSegment).toBeTypeOf("function");
        expect(audio.disposeAudio).toBeTypeOf("function");
      }
      // PCM content and complete playback are verified by the browser audio tests.
    });
    it("exports subtitles that retain every cue", () => {
      const srt = toSrt(p.subtitles);
      expect(srt.match(/-->/g)?.length).toBe(p.subtitles.length);
      expect(srt).toContain(p.subtitles[0].text);
    });
  });
