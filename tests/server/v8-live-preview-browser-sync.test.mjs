import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";

const fixtureModule = `
import {createPlayerSession} from '/src/engine/player-session.ts';
import {openVideoSource,clearVideoSourceCache,videoSourceDiagnostics} from '/src/engine/media-source.ts';
window.createSyncSession=()=>{
  window.syncSound={active:0,started:0,disposed:0,offsets:[]};window.syncSnapshots=[];window.syncErrors=[];
  const project={
    id:'test-film',title:'Real shared clock',renderer:'canvas',duration:40,fps:24,
    composition:{width:320,height:180},beats:[],subtitles:[],livePreview:true,
    audioTracks:[{id:'tone',name:'Tone',kind:'generated',start:0,duration:40}],
    loadAudio:async()=>({createAudio({context,destination,when,offset,duration,rate}){
      const stats=window.syncSound,node=context.createOscillator();node.frequency.value=437;
      node.connect(destination);node.start(when);node.stop(when+duration/rate);
      stats.active++;stats.started++;stats.offsets.push(offset);let closed=false;
      return {dispose(){if(closed)return;closed=true;stats.active--;stats.disposed++;try{node.stop();}catch{}node.disconnect();}};
    }}),
    load:async()=>({async createScene({width,height,quality}){
      const source=await openVideoSource('__v8-sync-video.mp4?v=sync',width,undefined,quality);
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');let pending;
      return {canvas,async prepareFrame(time,{signal}){pending=await source.frame(Math.min(time,39.99),signal);},
        render(){if(pending)context.drawImage(pending.image,0,0,width,height);},dispose(){source.dispose();canvas.width=canvas.height=1;}};
    }})
  };
  window.syncProject=project;
  window.sync=createPlayerSession({canvas:document.querySelector('canvas'),project,quality:'draft',embedded:false,
    initial:{time:0,playing:false,buffering:false,rate:1,loop:false,volume:.65,muted:false},controls:{},
    subtitles:()=>false,segmentEnd:()=>null,onSegmentEnd:()=>{},onSnapshot:s=>window.syncSnapshots.push({...s}),
    onLoading:()=>{},onError:e=>{if(e)window.syncErrors.push(e);},onFps:()=>{},onTrackControl:()=>{}});
  window.syncMedia={clearVideoSourceCache,videoSourceDiagnostics};
  document.querySelector('button').onclick=()=>window.sync.api.play();
};
`;

test(
  "V8 real movie starvation pauses generated audio and the shared clock, then resumes without drift over a slow Range connection",
  { timeout: 180000 },
  async (t) => {
    const owned = path.join(root, ".cache/v8-sync-browser", randomUUID());
    fs.mkdirSync(owned, { recursive: true });
    const movie = path.join(owned, "fixture.mp4");
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=12:duration=40",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "600k",
        "-minrate",
        "600k",
        "-maxrate",
        "600k",
        "-bufsize",
        "1200k",
        "-x264-params",
        "nal-hrd=cbr",
        "-g",
        "12",
        "-movflags",
        "+faststart",
        "-an",
        "-y",
        movie,
      ],
      { timeout: 45000, windowsHide: true },
    );
    let server, browser;
    const ranges = [];
    let delayed = 0;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: path.join(owned, "vite"),
        appType: "custom",
        logLevel: "error",
        optimizeDeps: { include: ["mediabunny", "zod"] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
          {
            name: "v8-shared-clock-fixture",
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                if (request.url === "/__v8-sync") {
                  response.setHeader("Content-Type", "text/html");
                  response.end(
                    '<!doctype html><html><body><button>Play</button><canvas></canvas><script type="module" src="/__v8-sync-entry.js"></script></body></html>',
                  );
                } else if (request.url === "/__v8-sync-entry.js") {
                  response.setHeader("Content-Type", "text/javascript");
                  response.end(fixtureModule);
                } else if (request.url?.startsWith("/__v8-sync-video.mp4")) {
                  const size = fs.statSync(movie).size,
                    range = /^bytes=(\d+)-(\d*)$/.exec(
                      request.headers.range || "",
                    );
                  const start = range ? Number(range[1]) : 0,
                    end =
                      range && range[2]
                        ? Math.min(Number(range[2]), size - 1)
                        : size - 1;
                  ranges.push({ start, end });
                  response.statusCode = range ? 206 : 200;
                  response.setHeader("Content-Type", "video/mp4");
                  response.setHeader("Accept-Ranges", "bytes");
                  response.setHeader("Content-Length", end - start + 1);
                  if (range)
                    response.setHeader(
                      "Content-Range",
                      `bytes ${start}-${end}/${size}`,
                    );
                  // A seek into uncached bytes experiences a real stalled response body,
                  // independent of browser cache and the decoder's compressed lookahead.
                  const delay = start > size * 0.4 ? 1200 : 0;
                  if (delay) delayed++;
                  const stream = fs.createReadStream(movie, { start, end });
                  let timer;
                  response.on("close", () => {
                    clearTimeout(timer);
                    stream.destroy();
                  });
                  if (delay)
                    timer = setTimeout(() => stream.pipe(response), delay);
                  else stream.pipe(response);
                } else next();
              });
            },
          },
        ],
      });
      await server.listen();
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      browser = await launchBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(45000);
      await page.goto(origin + "/__v8-sync");
      await page.waitForFunction(() => window.createSyncSession);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 600,
        downloadThroughput: 96 * 1024,
        uploadThroughput: 48 * 1024,
        connectionType: "cellular3g",
      });
      const began = Date.now();
      await page.evaluate(async () => {
        window.createSyncSession();
        await window.sync.ready;
      });
      await page.getByRole("button", { name: "Play" }).click();
      await page.waitForFunction(
        () => window.sync.snapshot().playing && window.syncSound.active > 0,
      );
      await page.evaluate(() => {
        window.syncSeek = window.sync.api.seek(30);
      });
      await page.waitForFunction(
        () =>
          window.sync.snapshot().buffering &&
          !window.sync.snapshot().playing &&
          window.syncSound.active === 0,
      );
      const waiting = await page.evaluate(() => ({
        state: window.sync.snapshot(),
        sound: { ...window.syncSound },
        media: window.syncMedia.videoSourceDiagnostics(),
      }));
      await page.waitForTimeout(350);
      const stalled = await page.evaluate(() => ({
        state: window.sync.snapshot(),
        sound: { ...window.syncSound },
      }));
      assert.ok(
        Math.abs(stalled.state.time - waiting.state.time) < 0.025,
        "movie buffering freezes the same clock used by generated audio",
      );
      assert.equal(
        stalled.sound.active,
        0,
        "no generated voice continues while the movie waits for bytes",
      );
      await page.evaluate(() => window.syncSeek);
      await page.waitForFunction(
        () =>
          window.sync.snapshot().playing &&
          !window.sync.snapshot().buffering &&
          window.syncSound.active > 0,
      );
      const recovered = await page.evaluate(() => ({
        state: window.sync.snapshot(),
        sound: { ...window.syncSound },
        errors: window.syncErrors,
      }));
      assert.ok(
        recovered.state.time >= 30 && recovered.state.time < 33,
        "resumes from selected position rather than elapsed network time",
      );
      assert.ok(
        Math.abs(recovered.sound.offsets.at(-1) - stalled.state.time) < 0.1,
        "audio restarts at the frozen common anchor",
      );
      assert.ok(
        recovered.sound.active <= 1,
        "recovery cannot duplicate the generated voice",
      );
      assert.deepEqual(recovered.errors, []);
      assert.ok(waiting.media.network.active <= waiting.media.network.limit);
      assert.ok(
        delayed > 0,
        "the test exercised an actual uncached, stalled Range body",
      );
      const switched = await page.evaluate(async () => {
        const before = window.sync.snapshot(),
          voices = window.syncSound.started,
          context = window.sync.audio.context,
          snapshotsAt = window.syncSnapshots.length;
        const standard = await window.sync.updateProject(window.syncProject, {
          quality: "standard",
          visualChanged: true,
          audioChanged: false,
          revision: 1,
        });
        const economy = await window.sync.updateProject(window.syncProject, {
          quality: "draft",
          visualChanged: true,
          audioChanged: false,
          revision: 2,
        });
        return {
          before,
          after: window.sync.snapshot(),
          voices,
          voicesAfter: window.syncSound.started,
          voicesActive: window.syncSound.active,
          sameContext: context === window.sync.audio.context,
          buffered: window.syncSnapshots
            .slice(snapshotsAt)
            .some((state) => state.buffering),
          standard,
          economy,
          diagnostics: window.sync.api.getDiagnostics(),
        };
      });
      await page.waitForFunction(
        () =>
          window.sync.snapshot().playing && !window.sync.snapshot().buffering,
      );
      const stableQuality = await page.evaluate(() => ({
        state: window.sync.snapshot(),
        voicesActive: window.syncSound.active,
        voicesAfter: window.syncSound.started,
      }));
      switched.after = stableQuality.state;
      switched.voicesActive = stableQuality.voicesActive;
      switched.voicesAfter = stableQuality.voicesAfter;
      assert.equal(switched.standard, true);
      assert.equal(switched.economy, true);
      assert.equal(
        switched.after.playing,
        true,
        "manual quality replacement preserves playing state",
      );
      assert.ok(
        switched.after.time >= switched.before.time &&
          switched.after.time < switched.before.time + 2,
        "quality changes keep the current timeline position",
      );
      assert.equal(
        switched.sameContext,
        true,
        "quality changes retain the original audio context",
      );
      assert.ok(
        switched.voicesActive <= 1,
        "quality changes never duplicate generated audio",
      );
      if (switched.voicesAfter !== switched.voices)
        assert.equal(
          switched.buffered,
          true,
          "audio reschedules only when actual video starvation freezes the common clock",
        );
      assert.equal(switched.diagnostics.livePreview.updates, 2);
      await page.evaluate(() => {
        window.sync.dispose();
        window.syncMedia.clearVideoSourceCache();
      });
      await page.waitForFunction(
        () =>
          window.syncSound.active === 0 &&
          window.syncMedia.videoSourceDiagnostics().reservedDecodedBytes === 0,
      );
      t.diagnostic(
        JSON.stringify({
          elapsedMs: Date.now() - began,
          movieBytes: fs.statSync(movie).size,
          ranges,
          delayed,
          frozenAt: stalled.state.time,
          resumedAt: recovered.state.time,
        }),
      );
    } finally {
      await browser?.close();
      await server?.close();
      fs.rmSync(owned, { recursive: true, force: true });
    }
  },
);
