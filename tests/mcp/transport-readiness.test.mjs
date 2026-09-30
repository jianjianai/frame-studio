import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { createServer } from "vite";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test("realtime transport freezes preparation, waits for voices and cancels readiness across cold seeks", { timeout: 60000 }, async () => {
  const f = fixture({ browser: true });
  let server, browser;
  try {
    server = await createServer(projectConfig(f.root, "test-film"));
    await server.listen();
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/?debug=1#/film/test-film");
    await page.mouse.click(2, 2);
    const result = await page.evaluate(async () => {
      const { AudioTransport } = await import("/src/engine/audio.ts");
      const errors = [], events = [];
      let transport;
      const generator = {
        createAudio({ context, destination, when, duration, rate, trackId }) {
          const event = { trackId, when, audioTime: context.currentTime, playing: transport.clock.playing, contextState: context.state, disposed: false };
          events.push(event);
          const began = performance.now();
          while (performance.now() - began < 180) { /* emulate synchronous PCM synthesis */ }
          const source = context.createBufferSource();
          source.buffer = context.createBuffer(1, 1, context.sampleRate);
          source.loop = true;
          source.connect(destination);
          source.start(when);
          source.stop(when + duration / rate);
          return { ready: new Promise(resolve => setTimeout(resolve, 100)),
            dispose() { event.disposed = true; try { source.stop(); } catch {} source.disconnect(); } };
        },
      };
      transport = new AudioTransport({
        duration: 24, fps: 30, audioTracks: [{ id: "pulse", kind: "generated" }, { id: "harmony", kind: "generated" }],
        loadAudio: async () => generator,
      }, error => errors.push(error.message));
      const snapshots = [];
      for (const start of [19, 0]) {
        transport.seek(start);
        await transport.play();
        const startTime = transport.clock.time();
        await new Promise(resolve => setTimeout(resolve, 150));
        transport.pause();
        const stopped = transport.clock.time();
        await new Promise(resolve => setTimeout(resolve, 80));
        snapshots.push({ start, startTime, stopped, paused: transport.clock.time() });
        transport.setRate(2);
      }
      await transport.dispose();
      // A short voice with slow asynchronous readiness must survive wall timers.
      let disposed = false;
      const slow = new AudioTransport({
        duration: 2, fps: 30, audioTracks: [{ id: "short", kind: "generated", duration: 0.2 }],
        loadAudio: async () => ({ createAudio({ context, destination, when, duration }) {
          const source = context.createBufferSource();
          source.buffer = context.createBuffer(1, 1, context.sampleRate);
          source.loop = true; source.connect(destination); source.start(when); source.stop(when + duration);
          return { ready: new Promise(resolve => setTimeout(resolve, 900)), dispose() { disposed = true; try { source.stop(); } catch {} source.disconnect(); } };
        } }),
      }, error => errors.push(error.message));
      await slow.play();
      const readyState = { disposed, playing: slow.clock.playing, time: slow.clock.time() };
      slow.pause();
      disposed = false;
      const began = performance.now(), playing = slow.play();
      setTimeout(() => slow.pause(), 60);
      await playing;
      const cancelled = { elapsed: performance.now() - began, playing: slow.clock.playing, time: slow.clock.time(), disposed };
      await slow.dispose();
      return { errors, events, snapshots, readyState, cancelled };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.events.length, 4);
    for (let i = 0; i < 4; i += 2) {
      assert.equal(result.events[i].when, result.events[i + 1].when);
      assert.equal(result.events[i].audioTime, result.events[i + 1].audioTime);
      assert.equal(result.events[i].playing, false);
      assert.equal(result.events[i].contextState, "suspended");
    }
    for (const snapshot of result.snapshots) {
      assert(snapshot.startTime >= snapshot.start && snapshot.startTime < snapshot.start + 0.1);
      assert(snapshot.stopped > snapshot.start + 0.05);
      assert.equal(snapshot.paused, snapshot.stopped);
    }
    assert.equal(result.readyState.disposed, false);
    assert.equal(result.readyState.playing, true);
    assert(result.readyState.time < 0.1);
    assert.equal(result.cancelled.playing, false);
    assert(result.cancelled.elapsed < 500);
    assert.equal(result.cancelled.disposed, true);
  } finally { await browser?.close(); await server?.close(); f.close(); }
});
