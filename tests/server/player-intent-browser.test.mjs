import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fixture, repo } from "../mcp/helpers.mjs";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { browserOptions } from "../../scripts/browser.mjs";

const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const scene = [
  'export function createScene({width,height}) {',
  'const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;',
  'const ctx=canvas.getContext("2d");',
  'return {canvas,async render(time) {',
  'const gate=window.__renderGate;if(gate?.armed){gate.entered++;await gate.promise;}',
  'ctx.fillStyle="#223344";ctx.fillRect(0,0,width,height);',
  'ctx.fillStyle="#ffffff";ctx.fillText(String(time),10,20);',
  '},dispose(){}};}',
].join("\n");
const harness = [
  'import {createPlayerSession} from "/src/engine/player-session";',
  'import {findProject} from "/src/projects";',
  'const project=findProject("test-film");window.__events=[];',
  'window.__mountSession=(playing=false)=>{',
  'const canvas=document.createElement("canvas");document.body.append(canvas);',
  'const events={starting:[],snapshots:0,errors:[]};window.__events.push(events);',
  'const session=createPlayerSession({canvas,project,quality:"draft",embedded:false,',
  'initial:{time:0,playing,buffering:false,rate:1,loop:false,volume:.65,muted:false},',
  'controls:{},subtitles:()=>false,segmentEnd:()=>null,onSegmentEnd:()=>{},',
  'onSnapshot:()=>events.snapshots++,onLoading:()=>{},onStarting:v=>events.starting.push(v),',
  'onError:v=>{if(v)events.errors.push(v);},onFps:()=>{},onTrackControl:()=>{}});',
  'window.__session=session;window.__FRAME_STUDIO__=session.api;window.__project=project;return session;};',
  'window.__mountSession(new URLSearchParams(location.search).has("initialPlaying"));',
].join("\n");
const init = () => {
  window.__gates = {};
  window.__ops = {};
  window.__makeGate = id => {
    const gate = { armed: true, entered: 0 };
    gate.promise = new Promise(resolve => {
      gate.release = () => { gate.armed = false; resolve(); };
    });
    window.__renderGate = window.__gates[id] = gate;
  };
  if (new URLSearchParams(location.search).has("initGate")) window.__makeGate("initial");
};
const arm = (page, id = "A") => page.evaluate(id => window.__makeGate(id), id);
const entered = (page, id = "A") => page.waitForFunction(id => window.__gates[id]?.entered > 0, id);
const release = (page, id = "A") => page.evaluate(id => window.__gates[id].release(), id);
const done = (page, id) => page.waitForFunction(id => window.__ops[id] === "done", id);
async function paused(page, expectedTime) {
  const result = await page.evaluate(async () => {
    const api = window.__FRAME_STUDIO__, before = api.getState().time;
    await new Promise(resolve => setTimeout(resolve, 150));
    return { before, after: api.getState(), starting: api.getDiagnostics().audio.starting };
  });
  assert.equal(result.after.playing, false);
  assert.equal(result.starting, false);
  assert.ok(Math.abs(result.after.time - result.before) < 0.001, JSON.stringify(result));
  if (expectedTime !== undefined)
    assert.ok(Math.abs(result.after.time - expectedTime) < 0.01, JSON.stringify(result));
}

test("Player cancels obsolete visual starts across UI, API, restore and session lifecycle",
  { timeout: 120000 }, async t => {
    const f = fixture({ browser: true });
    let server, browser;
    const errors = [];
    try {
      // Only private scene/entries are instrumented; actual implementation copies stay unchanged.
      for (const name of ["src/ui/Player.tsx", "src/engine/player-session.ts", "src/engine/audio.ts", "src/engine/renderer.ts"])
        assert.equal(sha(path.join(f.root, name)), sha(path.join(repo, name)), name);
      fs.writeFileSync(f.file("scene.ts"), scene);
      const projectFile = f.file("project.ts");
      fs.writeFileSync(projectFile, fs.readFileSync(projectFile, "utf8").replace(/duration:\s*2\b/, "duration: 10"));
      const main = path.join(f.root, "src/main.tsx");
      fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace(
        "<Player key={id} project={project} />",
        '<Player key={id} project={project} embedded={new URLSearchParams(location.search).has("embedded")} />',
      ));
      fs.writeFileSync(path.join(f.root, "session-harness.ts"), harness);
      fs.writeFileSync(path.join(f.root, "session.html"), '<!doctype html><html><body><script type="module" src="/session-harness.ts"></script></body></html>');
      fs.writeFileSync(path.join(f.root, "intent-host-loading.html"), '<!doctype html><html><body><iframe title="Actual Player" src="/?debug=1&embedded=1&initGate=1#/film/test-film"></iframe></body></html>');
      const cfg = projectConfig(f.root, "test-film");
      cfg.server.port = Number(process.env.FRAME_TEST_PORT || 0);
      cfg.server.strictPort = true;
      server = await createServer(cfg); await server.listen();
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      const options = browserOptions();
      browser = await chromium.launch({ ...options, args: [...options.args, "--autoplay-policy=no-user-gesture-required"] });
      const open = async (route = "/?debug=1#/film/test-film", ready = true) => {
        const page = await browser.newPage();
        page.setDefaultTimeout(15000);
        page.on("pageerror", error => errors.push(String(error)));
        await page.addInitScript(init);
        await page.goto(origin + route);
        if (ready) await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
        return page;
      };
      const check = (name, work) => t.test(name, async () => {
        try { await work(); } catch (error) { console.error(name, error.stack); throw error; }
      });
      await check("API pause, seek and frame cancel a render-in-flight start", async () => {
        const page = await open();
        try {
          for (const action of ["pause", "seek", "frame"]) {
            await page.evaluate(() => window.__FRAME_STUDIO__.frame(0));
            await arm(page);
            await page.evaluate(() => { void window.__FRAME_STUDIO__.play().then(() => { window.__ops.play = "done"; }); });
            await entered(page);
            assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().audio.starting), true);
            await page.evaluate(action => {
              const api = window.__FRAME_STUDIO__;
              window.__ops[action] = "pending";
              Promise.resolve(action === "pause" ? api.pause() : api[action](0.45))
                .then(() => { window.__ops[action] = "done"; });
            }, action);
            assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().audio.starting), false);
            await release(page); await done(page, action); await done(page, "play");
            await paused(page, action === "pause" ? 0 : 0.45);
            await page.evaluate(() => { window.__ops = {}; });
          }
        } finally { await page.close(); }
      });
      await check("loader Pause cancels; old A cannot clear the newer B loader", async () => {
        const page = await open();
        try {
          const toggle = page.getByTestId("play-toggle");
          await arm(page, "A"); await toggle.click(); await entered(page, "A");
          assert.equal(await toggle.getAttribute("aria-label"), "暂停");
          await toggle.click(); await release(page, "A"); await paused(page, 0);
          await arm(page, "A2"); await toggle.click(); await entered(page, "A2");
          await toggle.click(); await arm(page, "B"); await toggle.click();
          await release(page, "A2"); await entered(page, "B");
          assert.equal(await toggle.getAttribute("aria-label"), "暂停");
          assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().audio.starting), true);
          await release(page, "B");
          await page.waitForFunction(() => window.__FRAME_STUDIO__.getState().playing && window.__FRAME_STUDIO__.getState().time > 0.05);
          await toggle.click(); await paused(page);
        } finally { await page.close(); }
      });
      await check("restore reserves intent before ready and before frame preparation", async () => {
        const page = await open("/intent-host-loading.html", false);
        try {
          await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.__FRAME_STUDIO__);
          const frame = page.frames().find(frame => frame.url().includes("embedded=1"));
          await entered(frame, "initial");
          const command = state => page.evaluate(state => {
            document.querySelector("iframe").contentWindow.postMessage({
              type: "frame-player-command", command: "restore-session", state,
            }, "*");
          }, state);
          const state = { time: 0.3, playing: true, rate: 1.25, loop: false, volume: 0.4, muted: false };
          await command(state);
          await frame.waitForFunction(() => window.__FRAME_STUDIO__.getDiagnostics().audio.starting);
          await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({
            type: "frame-player-command", command: "pause",
          }, "*"));
          await frame.waitForFunction(() => !window.__FRAME_STUDIO__.getDiagnostics().audio.starting);
          await release(frame, "initial"); await frame.waitForFunction(() => window.__FRAME_STUDIO__.ready);
          await paused(frame, 0);
          await arm(frame); await command(state); await entered(frame);
          await frame.evaluate(() => window.__FRAME_STUDIO__.pause());
          await release(frame); await paused(frame, 0.3);
          await command({ ...state, playing: false, time: 0.4 });
          await frame.waitForFunction(() => Math.abs(window.__FRAME_STUDIO__.getState().time - 0.4) < 0.01);
          await paused(frame, 0.4);
          await command(state);
          await frame.waitForFunction(() => window.__FRAME_STUDIO__.getState().playing && window.__FRAME_STUDIO__.getState().time > 0.35);
          assert.equal(await frame.evaluate(() => window.__FRAME_STUDIO__.getState().rate), 1.25);
          await frame.evaluate(() => window.__FRAME_STUDIO__.pause()); await paused(frame);
        } finally { await page.close(); }
      });
      await check("active/repeated play, seek/rate and buffering seek/update preserve continuity", async () => {
        const page = await open("/session.html");
        try {
          // Hold the actual final native resume after startSource has set clock.playing,
          // proving repeat play also awaits the brief playing && buffering overlap.
          await page.evaluate(() => {
            const context = window.__session.audio.context;
            const resume = context.resume.bind(context);
            let calls = 0;
            window.__resumeEntered = false;
            const gate = new Promise(resolve => { window.__releaseResume = resolve; });
            context.resume = async () => {
              await resume();
              if (++calls === 2) { window.__resumeEntered = true; await gate; }
            };
            window.__restoreResume = () => { context.resume = resume; };
            window.__firstDone = window.__secondDone = false;
            void window.__FRAME_STUDIO__.play().then(() => { window.__firstDone = true; });
          });
          await page.waitForFunction(() => window.__resumeEntered);
          assert.equal(await page.evaluate(() => window.__session.audio.clock.playing && window.__session.audio.buffering), true);
          await page.evaluate(async () => {
            const generation = window.__session.audio.generation;
            void window.__FRAME_STUDIO__.play().then(() => { window.__secondDone = true; });
            await new Promise(resolve => setTimeout(resolve, 50));
            if (window.__firstDone || window.__secondDone) throw Error("Resume readiness was bypassed");
            if (window.__session.audio.generation !== generation) throw Error("Repeat play replaced resume generation");
            window.__releaseResume();
          });
          await page.waitForFunction(() => window.__firstDone && window.__secondDone && !window.__session.audio.buffering);
          await page.evaluate(() => window.__restoreResume());
          const continuity = await page.evaluate(async () => {
            const sound = window.__session.audio;
            const before = { generation: sound.generation, graph: sound.graph, time: sound.clock.time() };
            await window.__FRAME_STUDIO__.play();
            return { sameGeneration: before.generation === sound.generation,
              sameGraph: before.graph === sound.graph, playing: sound.clock.playing,
              timeAdvanced: sound.clock.time() >= before.time };
          });
          assert.deepEqual(continuity, { sameGeneration: true, sameGraph: true, playing: true, timeAdvanced: true });
          await page.evaluate(async () => { window.__FRAME_STUDIO__.setRate(1.5); await window.__FRAME_STUDIO__.seek(0.5); });
          await page.waitForFunction(() => window.__FRAME_STUDIO__.getState().playing && window.__FRAME_STUDIO__.getState().time > 0.55);
          assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getState().rate), 1.5);
          // Gate an actual running renderer; its slow-frame callback enters real transport buffering.
          await arm(page); await entered(page);
          await page.waitForFunction(() => window.__session.audio.buffering && !window.__session.audio.clock.playing);
          await page.evaluate(async () => {
            const generation = window.__session.audio.generation;
            window.__repeatDone = false;
            void window.__FRAME_STUDIO__.play().then(() => { window.__repeatDone = true; });
            await new Promise(resolve => setTimeout(resolve, 50));
            if (window.__repeatDone) throw Error("Repeated play resolved before buffering completed");
            if (generation !== window.__session.audio.generation) throw Error("Repeated play restarted buffering");
            const seek = window.__FRAME_STUDIO__.seek(0.7);
            const update = window.__session.updateProject({ ...window.__project }, { visualChanged: false, audioChanged: false });
            window.__gates.A.release();
            await Promise.all([seek, update]);
          });
          await page.waitForFunction(() => window.__FRAME_STUDIO__.getState().playing && window.__FRAME_STUDIO__.getState().time > 0.75);
          await page.evaluate(() => window.__FRAME_STUDIO__.pause()); await paused(page);
        } finally { await page.close(); }
      });
      await check("visibility and source replacement cancel pending starts", async () => {
        const page = await open("/session.html");
        try {
          for (const kind of ["visibility", "update"]) {
            await page.evaluate(() => window.__FRAME_STUDIO__.frame(0));
            await arm(page);
            await page.evaluate(() => { void window.__FRAME_STUDIO__.play().then(() => { window.__ops.play = "done"; }); });
            await entered(page);
            await page.evaluate(kind => {
              if (kind === "visibility") {
                Object.defineProperty(document, "hidden", { configurable: true, value: true });
                document.dispatchEvent(new Event("visibilitychange"));
              } else {
                void window.__session.updateProject({ ...window.__project }, { visualChanged: false, audioChanged: false })
                  .then(() => { window.__ops.update = "done"; });
              }
            }, kind);
            assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().audio.starting), false);
            await release(page); await done(page, "play");
            if (kind === "update") await done(page, "update");
            await paused(page, 0);
            await page.evaluate(() => { delete document.hidden; window.__ops = {}; });
          }
        } finally { await page.close(); }
      });
      await check("initial autoplay and disposed sessions cannot start or publish late state", async () => {
        const page = await open("/session.html?initGate=1&initialPlaying=1", false);
        try {
          await entered(page, "initial");
          await page.evaluate(() => window.__FRAME_STUDIO__.pause());
          await release(page, "initial"); await page.waitForFunction(() => window.__FRAME_STUDIO__.ready);
          await paused(page, 0);
          await arm(page);
          await page.evaluate(() => { void window.__FRAME_STUDIO__.play().then(() => { window.__ops.old = "done"; }); });
          await entered(page);
          await page.evaluate(() => {
            window.__oldSession = window.__session; window.__oldSession.dispose();
            window.__atDispose = JSON.stringify(window.__events[0]); window.__mountSession(false);
          });
          await release(page); await done(page, "old");
          await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
          assert.equal(await page.evaluate(() => JSON.stringify(window.__events[0])), await page.evaluate(() => window.__atDispose));
          assert.equal(await page.evaluate(() => window.__oldSession.audio.clock.playing), false);
          await paused(page, 0);
          await page.evaluate(() => window.__session.dispose());
        } finally { await page.close(); }
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close(); await server?.close(); f.close();
    }
  });
