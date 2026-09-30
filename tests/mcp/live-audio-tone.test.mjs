import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { createServer } from "vite";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "Tone adapter prepares without eager native contexts and preserves host ownership across voice replacements",
  { timeout: 60000 },
  async () => {
    const f = fixture({ browser: true });
    let server, browser;
    try {
      server = await createServer(projectConfig(f.root, "test-film"));
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      await page.mouse.click(2, 2);
      const result = await page.evaluate(async () => {
        const native = window.AudioContext,
          contexts = [];
        window.AudioContext = class extends native {
          constructor(...args) {
            super(...args);
            contexts.push(this);
          }
        };
        const { createToneAudio } =
          await import("/src/engine/audio-adapters.ts");
        const raw = new AudioContext(),
          destination = raw.createGain();
        destination.connect(raw.destination);
        const shared = [],
          module = createToneAudio(
            ({ Tone, toneContext, when, duration, destination, rate }) => {
              const synth = new Tone.Synth({
                context: toneContext,
                volume: -20,
              });
              shared.push(synth.context.rawContext === raw);
              synth.connect(destination);
              synth.triggerAttackRelease("A3", duration / rate, when);
              return {
                dispose() {
                  synth.dispose();
                },
              };
            },
          );
        await module.prepareAudio(raw);
        const afterPrepare = contexts.length;
        const options = {
          trackId: "tone",
          context: raw,
          destination,
          when: raw.currentTime + 0.04,
          offset: 0,
          duration: 0.2,
          rate: 1,
        };
        const first = module.createAudio(options),
          afterFirst = contexts.length;
        await raw.resume();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const second = module.createAudio({
          ...options,
          when: raw.currentTime + 0.04,
        });
        first.dispose();
        const afterReplacement = contexts.length,
          stateWithSecond = raw.state;
        second.dispose();
        module.disposeAudio(raw);
        const stateAfterDispose = raw.state;
        await module.prepareAudio(raw);
        const third = module.createAudio({
          ...options,
          when: raw.currentTime + 0.04,
        });
        const afterRestart = contexts.length;
        third.dispose();
        module.disposeAudio(raw);
        const finalState = raw.state;
        destination.disconnect();
        for (const owned of contexts)
          if (owned.state !== "closed") await owned.close();
        return {
          afterPrepare,
          afterFirst,
          afterReplacement,
          afterRestart,
          stateWithSecond,
          stateAfterDispose,
          finalState,
          shared,
        };
      });
      assert.equal(
        result.afterPrepare,
        1,
        "adapter prepare must not import Tone's eager native singleton",
      );
      // Tone's class defaults may lazily instantiate its own default context on
      // first synthesis. The adapter does not overwrite or dispose that singleton.
      assert(result.afterFirst >= 1);
      assert.equal(result.afterReplacement, result.afterFirst);
      assert.equal(result.afterRestart, result.afterFirst);
      assert(
        result.shared.every(Boolean),
        "every adapter voice must use the borrowed host context",
      );
      assert.equal(result.stateWithSecond, "running");
      assert.equal(result.stateAfterDispose, "running");
      assert.equal(result.finalState, "running");
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);
