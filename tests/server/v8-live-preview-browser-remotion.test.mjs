import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { installLivePreview } from "../../server/live-preview-routes.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";

function composition(color, version, { hold = false, fail = false } = {}) {
  return [
    'import {useEffect,useState} from "react";',
    'import {AbsoluteFill,useCurrentFrame,useDelayRender} from "remotion";',
    "export default function Film(){",
    "const frame=useCurrentFrame(),{delayRender,continueRender}=useDelayRender();",
    "const [handle]=useState(()=>" +
      (hold ? 'delayRender("V8 staged first frame")' : "null") +
      ");",
    "useEffect(()=>{const stats=window.__V8_REMOTION__ ||= {mounted:[],unmounted:[]};stats.mounted.push(" +
      version +
      ");if(handle!==null)window.__V8_RELEASE_REMOTION__=()=>continueRender(handle);return()=>stats.unmounted.push(" +
      version +
      ");},[]);",
    fail ? 'throw Error("V8 Remotion candidate render failed");' : "",
    'return <AbsoluteFill data-v8-remotion="' +
      version +
      '" data-frame={frame} style={{background:' +
      JSON.stringify(color) +
      "}}/>;}",
  ].join("\n");
}
const audio = [
  "export function createAudio({context,destination,when,duration,rate}){",
  "const stats=window.__V8_SOUND__ ||= {started:0,active:0,disposed:0};",
  "const contexts=window.__V8_FRAME_CONTEXTS__ ||= [];if(!contexts.includes(context))contexts.push(context);window.__V8_FRAME_CONTEXT__=context;",
  "const node=context.createOscillator();node.frequency.value=437;node.connect(destination);node.start(when);node.stop(when+duration/rate);",
  "stats.started++;stats.active++;let closed=false;return {dispose(){if(closed)return;closed=true;stats.active--;stats.disposed++;try{node.stop();}catch{}node.disconnect();}};}",
].join("\n");

async function state(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=stage-canvas]");
    const surface = [
      ...document.querySelectorAll("[data-remotion-surface]"),
    ].find((element) => element.parentElement === canvas.parentElement);
    const content = surface?.querySelector("[data-v8-remotion]");
    return {
      document: window.__V8_DOCUMENT__,
      live: window.__FRAME_LIVE_STATUS__,
      playback: window.__FRAME_STUDIO__.getState(),
      contexts: window.__V8_CONTEXTS__.length,
      // Remotion supports a native context per Player and suspends retired
      // contexts rather than closing them. Strong test references track state;
      // the Frame generator's context identity remains independent and stable.
      runningContexts: window.__V8_CONTEXTS__.filter(
        (item) => item.context.state === "running",
      ).length,
      contextStates: window.__V8_CONTEXTS__.map((item) => item.context.state),
      frameContexts: window.__V8_FRAME_CONTEXTS__?.length ?? 0,
      frameContext: window.__V8_CONTEXTS__.findIndex(
        (item) => item.context === window.__V8_FRAME_CONTEXT__,
      ),
      sound: { ...window.__V8_SOUND__ },
      version: Number(content?.dataset.v8Remotion),
      frame: Number(content?.dataset.frame),
      color: content ? getComputedStyle(content).backgroundColor : null,
      surfaces: document.querySelectorAll("[data-remotion-surface]").length,
    };
  });
}

test(
  "V8 real Remotion DOM: ready first-frame updates preserve shared audio and paused seeks; failed React candidates retain the accepted source",
  { timeout: 120000 },
  async (t) => {
    const owned = path.join(root, ".cache/v8-remotion-browser", randomUUID());
    const projectDir = path.join(owned, "projects/test-film");
    await fsp.mkdir(path.join(projectDir, "public"), { recursive: true });
    const metadata = {
      id: "test-film",
      title: "Remotion live source",
      subtitle: "",
      description: "",
      renderer: "remotion",
      duration: 60,
      fps: 24,
      composition: { width: 320, height: 180 },
      accent: "#fff",
      poster: "",
      tags: [],
      status: "draft",
      beats: [],
      subtitles: [],
      credits: [],
      audioTracks: [
        {
          id: "tone",
          name: "Direct tone",
          kind: "generated",
          gain: 0.4,
          duration: 60,
        },
      ],
    };
    await fsp.writeFile(
      path.join(projectDir, "project.ts"),
      "export default " +
        JSON.stringify(metadata).slice(0, -1) +
        ',load:()=>import("./scene"),loadRemotion:()=>import("./composition"),loadAudio:()=>import("./audio")};',
    );
    await fsp.writeFile(
      path.join(projectDir, "scene.ts"),
      'import {createRemotionScene} from "../../src/engine/remotion-adapter";import project from "./project";export const createScene=options=>createRemotionScene(options,project);',
    );
    await fsp.writeFile(path.join(projectDir, "audio.ts"), audio);
    await fsp.writeFile(
      path.join(projectDir, "composition.tsx"),
      composition("#b91c1c", 1),
    );
    const manager = new LivePreviewSessions({
      root,
      data: path.join(owned, "data"),
      db: { one: async () => ({ deleted: false }) },
      repos: { project: async () => ({ dir: projectDir }) },
    });
    const app = Fastify();
    installLivePreview(app, manager);
    let browser;
    try {
      const link = await manager.start({
        work: {
          id: randomUUID(),
          repo: randomUUID(),
          project: "test-film",
          deleted: false,
        },
      });
      await manager.ready(manager.sessions.get(link.sessionId));
      app.get("/__v8-remotion-host", async (_request, reply) =>
        reply
          .type("text/html")
          .send(
            '<!doctype html><html><body><iframe id="preview" sandbox="allow-scripts allow-downloads" style="width:1400px;height:900px" src="' +
              link.url +
              '?debug=1"></iframe></body></html>',
          ),
      );
      await app.listen({ host: "127.0.0.1", port: 0 });
      browser = await launchBrowser();
      const host = await browser.newPage();
      host.setDefaultTimeout(30000);
      const pageErrors = [],
        consoleErrors = [];
      host.on("console", (value) => {
        if (value.type() === "error") consoleErrors.push(value.text());
      });
      host.on("pageerror", (error) => pageErrors.push(error.message));
      await host.addInitScript((traceCalls) => {
        window.__V8_DOCUMENT__ = Math.random();
        window.__V8_CONTEXTS__ = [];
        const Native = window.AudioContext;
        window.AudioContext = class extends Native {
          constructor(...args) {
            super(...args);
            this.__V8_RECORD__ = { context: this, events: [] };
            window.__V8_CONTEXTS__.push(this.__V8_RECORD__);
            this.addEventListener("statechange", () =>
              this.__V8_RECORD__.events.push({
                op: "state",
                state: this.state,
                at: performance.now(),
              }),
            );
          }
        };
        if (traceCalls) {
          for (const method of ["resume", "suspend"]) {
            window.AudioContext.prototype[method] = function (...args) {
              this.__V8_RECORD__?.events.push({
                op: method,
                state: this.state,
                at: performance.now(),
                stack: new Error().stack,
              });
              return Native.prototype[method].apply(this, args);
            };
          }
        }
      }, process.env.FRAME_REMOTION_TRACE === "1");
      await host.goto(
        "http://127.0.0.1:" + app.server.address().port + "/__v8-remotion-host",
      );
      const iframe = await host.locator("#preview").elementHandle();
      const page = await iframe.contentFrame();
      assert(page, "actual embedded preview frame exists");
      const iframeToken = await iframe.evaluate(
        (element) => (element.__V8_ID__ = Math.random()),
      );
      await page.waitForFunction(
        () =>
          (window.__FRAME_STUDIO__?.ready &&
            window.__FRAME_LIVE_STATUS__?.revision === 1) ||
          window.__FRAME_LIVE_STATUS__?.state === "error",
      );
      assert.equal(
        await page.evaluate(() => window.__FRAME_STUDIO__?.ready),
        true,
        JSON.stringify(
          await page.evaluate(() => ({
            status: window.__FRAME_LIVE_STATUS__,
            text: document.body.innerText,
            diagnostics: window.__FRAME_STUDIO__?.getDiagnostics(),
          })),
        ) + JSON.stringify(consoleErrors),
      );
      const initial = await state(page);
      assert.equal(initial.version, 1);
      assert.equal(initial.color, "rgb(185, 28, 28)");
      await page.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(
        () =>
          window.__FRAME_STUDIO__.getState().playing &&
          window.__V8_SOUND__?.active === 1,
      );
      const playing = await state(page);
      assert.equal(
        playing.frameContexts,
        1,
        "generated audio receives one Frame-owned context",
      );
      assert(
        playing.runningContexts <= 2,
        "native Remotion and Frame share a bounded active budget",
      );
      await fsp.writeFile(
        path.join(projectDir, "composition.tsx"),
        composition("#1d4ed8", 2, { hold: true }),
      );
      await page.waitForFunction(() => window.__V8_RELEASE_REMOTION__);
      const staged = await state(page);
      assert.equal(staged.version, 1, "staging retains the visible old DOM");
      assert.equal(staged.live.sourceRevision, playing.live.sourceRevision);
      assert.equal(staged.sound.started, playing.sound.started);
      assert.equal(staged.sound.active, 1);
      assert.equal(staged.frameContext, playing.frameContext);
      assert(
        staged.runningContexts <= 2,
        "a staged native context must not start playback",
      );
      assert.equal(staged.playback.playing, true);
      assert(staged.playback.time >= playing.playback.time);
      await page.evaluate(() => {
        window.__V8_DOM_ACCEPTANCE__ = [];
        const sample = () => {
          const canvas = document.querySelector("[data-testid=stage-canvas]");
          const surface = [
            ...document.querySelectorAll("[data-remotion-surface]"),
          ].find((element) => element.parentElement === canvas.parentElement);
          const content = surface?.querySelector("[data-v8-remotion]");
          if (content)
            window.__V8_DOM_ACCEPTANCE__.push({
              version: Number(content.dataset.v8Remotion),
              frame: Number(content.dataset.frame),
              revision: window.__FRAME_LIVE_STATUS__.revision,
              time: window.__FRAME_STUDIO__.getState().time,
            });
          if (!window.__V8_STOP_SAMPLING__) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        window.__V8_RELEASE_REMOTION__();
      });
      await page.waitForFunction(
        () => window.__FRAME_LIVE_STATUS__?.revision === 2,
      );
      await page.waitForFunction(
        () => document.querySelectorAll("[data-remotion-surface]").length === 1,
      );
      const blue = await state(page);
      assert.equal(blue.document, initial.document);
      assert.equal(blue.version, 2);
      assert.equal(blue.color, "rgb(29, 78, 216)");
      assert.equal(blue.frameContexts, 1);
      assert.equal(blue.frameContext, playing.frameContext);
      assert.notEqual(
        blue.contextStates[0],
        "running",
        "the original native Player retires without continuing its clock",
      );
      assert(
        blue.runningContexts <= 2,
        "retired native contexts are suspended",
      );
      assert.equal(
        blue.sound.started,
        playing.sound.started,
        "visual updates retain oscillator ownership",
      );
      assert.equal(blue.sound.active, 1);
      assert.equal(blue.playback.playing, true);
      await page.waitForFunction(() =>
        window.__V8_DOM_ACCEPTANCE__.some((value) => value.version === 2),
      );
      const samples = await page.evaluate(() => window.__V8_DOM_ACCEPTANCE__);
      assert(
        samples.every((sample) => sample.version !== 2 || sample.revision >= 2),
        "new DOM and applied revision advance together",
      );
      const first = samples.find((sample) => sample.version === 2);
      assert(
        Math.abs(first.frame / 24 - first.time) < 0.15,
        "first accepted frame follows the existing playhead",
      );

      await fsp.writeFile(
        path.join(projectDir, "composition.tsx"),
        composition("#f59e0b", 3, { fail: true }),
      );
      await page.waitForFunction(
        () =>
          window.__FRAME_LIVE_STATUS__?.state === "error" &&
          /V8 Remotion candidate render failed/.test(
            window.__FRAME_LIVE_STATUS__.error || "",
          ),
      );
      await page.waitForFunction(
        () => document.querySelectorAll("[data-remotion-surface]").length === 1,
      );
      const failed = await state(page);
      assert.equal(failed.version, 2);
      assert.equal(failed.color, blue.color);
      assert.equal(failed.live.sourceRevision, blue.live.sourceRevision);
      assert.equal(failed.live.revision, blue.live.revision);
      assert.equal(failed.sound.started, playing.sound.started);
      assert.equal(failed.sound.active, 1);
      assert.equal(failed.frameContext, playing.frameContext);
      assert(
        failed.contextStates
          .slice(blue.contexts)
          .every((value) => value !== "running"),
        "failed native candidates remain silent",
      );
      assert(
        failed.runningContexts <= 2,
        "failed native candidates do not keep playing",
      );
      assert.equal(failed.playback.playing, true);
      assert(failed.playback.time >= blue.playback.time);

      await fsp.writeFile(
        path.join(projectDir, "composition.tsx"),
        composition("#15803d", 4),
      );
      await page.waitForFunction(
        () =>
          window.__FRAME_LIVE_STATUS__?.revision === 4 &&
          window.__FRAME_LIVE_STATUS__.state === "ready",
      );
      // Renderer disposal waits for the previous in-flight frame; native
      // AudioContext.suspend also completes asynchronously after acceptance.
      await page.waitForFunction(
        () => document.querySelectorAll("[data-remotion-surface]").length === 1,
      );
      await page
        .waitForFunction(
          ({ count, frame }) =>
            window.__V8_CONTEXTS__
              .slice(0, count)
              .every(
                (item, index) =>
                  index === frame || item.context.state !== "running",
              ),
          { count: failed.contexts, frame: playing.frameContext },
        )
        .catch(async (error) => {
          const diagnostics = {
            state: await state(page),
            previousContexts: failed.contexts,
            calls: await page.evaluate(() =>
              window.__V8_CONTEXTS__.map((item, index) => ({
                index,
                state: item.context.state,
                events: item.events,
              })),
            ),
          };
          throw Error(
            "Retired Remotion context wait failed: " +
              JSON.stringify(diagnostics),
            { cause: error },
          );
        });
      const recovered = await state(page);
      assert.equal(recovered.version, 4);
      assert.equal(recovered.color, "rgb(21, 128, 61)");
      assert.equal(recovered.frameContexts, 1);
      assert.equal(recovered.frameContext, playing.frameContext);
      assert(
        recovered.contextStates
          .slice(0, failed.contexts)
          .every(
            (value, index) =>
              index === playing.frameContext || value !== "running",
          ),
        "all previous native Players retire on recovery",
      );
      assert(
        recovered.runningContexts <= 2,
        "retired native contexts are suspended",
      );
      assert.equal(recovered.sound.started, playing.sound.started);
      assert.equal(recovered.sound.active, 1);
      assert.equal(recovered.playback.playing, true);
      await page.evaluate(async () => {
        window.__FRAME_STUDIO__.pause();
        await window.__FRAME_STUDIO__.seek(7.5);
      });
      await fsp.writeFile(
        path.join(projectDir, "composition.tsx"),
        composition("#7c3aed", 5),
      );
      await page.waitForFunction(
        () => window.__FRAME_LIVE_STATUS__?.revision === 5,
      );
      await page.waitForFunction(
        () => document.querySelectorAll("[data-remotion-surface]").length === 1,
      );
      await page.waitForFunction(
        (frame) =>
          window.__V8_CONTEXTS__.every(
            (item, index) =>
              index === frame || item.context.state !== "running",
          ),
        playing.frameContext,
      );
      const paused = await state(page);
      assert.equal(paused.version, 5);
      assert.equal(paused.color, "rgb(124, 58, 237)");
      assert.equal(paused.playback.playing, false);
      assert.equal(paused.playback.time, 7.5);
      assert.equal(paused.frame, 180);
      assert.equal(paused.frameContexts, 1);
      assert.equal(paused.frameContext, playing.frameContext);
      assert(
        paused.contextStates.every(
          (value, index) =>
            index === playing.frameContext || value !== "running",
        ),
        "all native Players stay paused at the selected frame",
      );
      assert(
        paused.runningContexts <= 2,
        "retired native contexts are suspended",
      );
      assert.equal(paused.sound.started, playing.sound.started);
      assert.equal(paused.sound.active, 0);
      assert.equal(paused.document, initial.document);
      assert.equal(
        await host.locator("#preview").evaluate((element) => element.__V8_ID__),
        iframeToken,
        "warm edits preserve the iframe element",
      );
      await page.evaluate(() => {
        window.__V8_STOP_SAMPLING__ = true;
      });
      assert.deepEqual(
        pageErrors.filter(
          (error) => !error.includes("V8 Remotion candidate render failed"),
        ),
        [],
      );
      assert.deepEqual(
        consoleErrors.filter((error) =>
          /localStorage|SecurityError/.test(error),
        ),
        [],
        "Frame preferences avoid opaque localStorage access",
      );
      t.diagnostic(
        JSON.stringify({
          initial,
          staged,
          blue,
          failed,
          recovered,
          paused,
          firstAcceptedFrame: first,
        }),
      );
    } finally {
      await browser?.close();
      await app.close();
      await manager.close();
      await fsp.rm(owned, { recursive: true, force: true });
    }
  },
);
