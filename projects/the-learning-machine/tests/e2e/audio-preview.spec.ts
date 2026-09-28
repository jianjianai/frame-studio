import { expect, test } from '@playwright/test';
import '../../../../src/engine/debug';

type Probe = {
  context?: AudioContext & { playbackStats?: { toJSON(): { underrunDuration: number; underrunEvents: number } } };
  meter?: AnalyserNode;
  created: number;
  connected: number;
  peak: number;
};
declare global { interface Window { learningAudioProbe: Probe } }

test('first half plays audible audio with a bounded graph, then supports seek, rate and mute', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe: Probe = window.learningAudioProbe = { created: 0, connected: 0, peak: 0 };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) { super(options); probe.context = this; }
      createBufferSource() {
        const source = super.createBufferSource();
        probe.created++;
        let connected = false;
        const connect = source.connect.bind(source) as (target: AudioNode) => AudioNode;
        source.connect = ((target: AudioNode) => {
          if (!connected) { connected = true; probe.connected++; probe.peak = Math.max(probe.peak, probe.connected); }
          return connect(target);
        }) as typeof source.connect;
        const disconnect = source.disconnect.bind(source);
        source.disconnect = (() => {
          if (connected) { connected = false; probe.connected--; }
          disconnect();
        }) as typeof source.disconnect;
        return source;
      }
      createGain() {
        const gain = super.createGain();
        const connect = gain.connect.bind(gain) as (target: AudioNode) => AudioNode;
        gain.connect = ((target: AudioNode) => {
          if (target === this.destination) {
            const meter = this.createAnalyser();
            meter.fftSize = 2048;
            probe.meter = meter;
            connect(meter);
            meter.connect(target);
            return target;
          }
          return connect(target);
        }) as typeof gain.connect;
        return gain;
      }
    };
  });
  await page.goto('/?debug=1#/film/the-learning-machine');
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  await page.evaluate(() => window.__FRAME_STUDIO__!.waitUntilReady!({ audio: true }));
  await page.getByTestId('play-toggle').click();
  const initial = await page.evaluate(() => window.learningAudioProbe.created);
  expect(initial, 'startup must not allocate the whole 153.6-second score').toBeLessThan(200);

  const sustained = await page.evaluate(async () => {
    const probe = window.learningAudioProbe;
    const samples = new Float32Array(probe.meter!.fftSize);
    const readings: { time: number; rms: number }[] = [];
    const before = probe.context!.playbackStats?.toJSON();
    const began = performance.now();
    while (window.__FRAME_STUDIO__!.getState!().time < 78 && performance.now() - began < 90000) {
      await new Promise(resolve => setTimeout(resolve, 250));
      probe.meter!.getFloatTimeDomainData(samples);
      readings.push({ time: window.__FRAME_STUDIO__!.getState!().time, rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) });
    }
    const after = probe.context!.playbackStats?.toJSON();
    window.__FRAME_STUDIO__!.pause!();
    return { readings, before, after, peak: probe.peak, connected: probe.connected, state: window.__FRAME_STUDIO__!.getState!() };
  });
  expect(sustained.state.time).toBeGreaterThanOrEqual(78);
  expect(sustained.peak).toBeLessThan(200);
  expect(sustained.connected).toBe(0);
  // Check actual output in each part of the first half, not merely a running clock.
  for (let start = 0; start < 70; start += 10)
    expect(sustained.readings.some(r => r.time >= start && r.time < start + 10 && r.rms > .003), `audible ${start}-${start + 10}s`).toBe(true);
  if (sustained.before && sustained.after) {
    expect(sustained.after.underrunDuration - sustained.before.underrunDuration).toBeLessThan(.1);
  }

  // Forward cold seek, reverse seek, changing speed and track control rebuild the graph.
  for (const [start, rate] of [[99, 2], [18.3, 1], [0, 2]]) {
    await page.evaluate(async ({ start, rate }) => {
      const api = window.__FRAME_STUDIO__!;
      api.setRate!(rate); await api.captureAt!(start, { audio: true }); await api.play!();
    }, { start: start!, rate: rate! });
    await page.waitForFunction(start => window.__FRAME_STUDIO__!.getState!().time > start + 4, start!, { timeout: 10000 });
    await page.evaluate(() => window.__FRAME_STUDIO__!.pause!());
    expect(await page.evaluate(() => window.learningAudioProbe.connected)).toBe(0);
  }
  // Each track remains independently audible; muting all four produces silence.
  for (const track of ['voice', 'drums', 'music', 'fx', 'none']) {
    const peak = await page.evaluate(async track => {
      const api = window.__FRAME_STUDIO__!, probe = window.learningAudioProbe;
      api.setRate!(1);
      for (const id of ['voice', 'drums', 'music', 'fx']) api.setTrack!(id, { muted: id !== track });
      await api.captureAt!(0, { audio: true }); await api.play!();
      const values = new Float32Array(probe.meter!.fftSize);
      let peak = 0;
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        probe.meter!.getFloatTimeDomainData(values);
        for (const value of values) peak = Math.max(peak, Math.abs(value));
      }
      api.pause!(); return peak;
    }, track);
    if (track === 'none') expect(peak).toBeLessThan(.00001);
    else expect(peak, track).toBeGreaterThan(.003);
  }
  const result = await page.evaluate(() => ({ diagnostics: window.__FRAME_STUDIO__!.getDiagnostics!(), connected: window.learningAudioProbe.connected, peak: window.learningAudioProbe.peak }));
  expect(result.diagnostics.errors).toEqual([]);
  expect(result.connected).toBe(0);
  expect(errors).toEqual([]);
  console.info('R2_PREVIEW_AUDIO', JSON.stringify({ initial, peak: result.peak, before: sustained.before, after: sustained.after, samples: sustained.readings.length, time: sustained.state.time }));
});
