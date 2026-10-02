import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { fixture, repo as root } from "../mcp/helpers.mjs";

const databaseURL = process.env.FRAME_TEST_DATABASE_URL;
const colors = { red: "#b91c1c", blue: "#1d4ed8", green: "#15803d" };
function scene(color, { fail = false } = {}) {
  return `
import { Color } from "three";
const fill = "#" + new Color("${color}").getHexString();
export function createScene({width,height,quality}) {
  ${fail ? 'throw Error("V8 candidate scene initialization failed");' : ""}
  const stats = window.__V8_SCENES__ ||= {created:0,disposed:0,active:0};
  stats.created++; stats.active++;
  const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
  const context=canvas.getContext("2d"); let closed=false;
  return {
    canvas,
    async render(time) {
      context.fillStyle=fill; context.fillRect(0,0,width,height);
      context.fillStyle="#ffffff"; context.fillRect(0,0,Math.floor(time*4)%width,2);
    },
    dispose() { if(closed)return;closed=true;stats.disposed++;stats.active--;canvas.width=1;canvas.height=1; }
  };
}
`;
}
const audio = `
import { FrequencyClass } from "tone/build/esm/core/type/Frequency.js";
export function createAudio({context,destination,when,offset,duration,rate}) {
  // The framework conversion receives Frame\'s context; importing Tone must not create a second clock.
  const frequency=new FrequencyClass(context,"A3").toFrequency();
  const stats=window.__V8_SOUND__ ||= {started:0,disposed:0,active:0,calls:[],gains:[]};
  const oscillator=context.createOscillator();oscillator.frequency.value=frequency;
  oscillator.connect(destination); oscillator.start(when);oscillator.stop(when+duration/rate);
  stats.started++;stats.active++;stats.gains.push(destination.gain);
  stats.calls.push({when,offset,duration,rate});let closed=false;
  return {dispose(){if(closed)return;closed=true;stats.disposed++;stats.active--;try{oscillator.stop();}catch{}oscillator.disconnect();}};
}
`;
function project() {
  return `export default {
    id:"test-film",title:"Live preview acceptance",subtitle:"Continuous source preview",
    description:"Browser transport and network regression fixture",accent:"#1d4ed8",
    poster:"films/test-film/poster.svg",tags:["test"],status:"draft",duration:120,fps:24,renderer:"canvas",
    composition:{width:320,height:180},beats:[],subtitles:[],credits:[],
    load:()=>import("./scene"),loadAudio:()=>import("./audio"),
    loadAudioDocument:()=>import("./audio.json")
  };`;
}
function audioDocument() {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "sine",
        kind: "generated",
        module: "legacy",
        trackId: "main",
        engine: "web-audio",
      },
    ],
    tracks: [{ id: "music", name: "Music" }],
    clips: [
      {
        id: "tone",
        track: "music",
        source: "sine",
        start: 0,
        offset: 0,
        duration: 120,
        gain: 0.8,
      },
    ],
    master: { gain: 1, processors: [{ id: "level", type: "gain", gain: 0.7 }] },
    buses: [],
    linkedVideo: false,
  };
}
async function readPlayback(page) {
  return page.evaluate(() => ({
    state: window.__FRAME_STUDIO__?.getState(),
    diagnostics: window.__FRAME_STUDIO__?.getDiagnostics(),
    contexts: window.__V8_CONTEXTS__?.length,
    sound: window.__V8_SOUND__ && {
      started: window.__V8_SOUND__.started,
      active: window.__V8_SOUND__.active,
      disposed: window.__V8_SOUND__.disposed,
      calls: window.__V8_SOUND__.calls,
      gains: window.__V8_SOUND__.gains.map((g) => g.value),
    },
    scenes: window.__V8_SCENES__,
  }));
}
async function waitColor(page, color) {
  const target = color
    .slice(1)
    .match(/../g)
    .map((hex) => parseInt(hex, 16));
  await page.waitForFunction(
    (expected) => {
      const canvases = [...document.querySelectorAll("canvas")];
      for (const canvas of canvases) {
        if (canvas.width < 100 || canvas.height < 50) continue;
        const context = canvas.getContext("2d");
        if (!context) continue;
        const pixel = context.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
        ).data;
        if (expected.every((value, i) => Math.abs(value - pixel[i]) < 3))
          return true;
      }
      return false;
    },
    target,
    { timeout: 20000 },
  );
}
function changedBytes(log, from) {
  return log.slice(from).reduce((sum, entry) => sum + entry.bytes, 0);
}

// CDP event callbacks are not awaited. Own every command until Fetch is disabled.
function interruptModuleFetch(cdp) {
  const pending = new Set(),
    failures = [],
    cancelled = new Set();
  let interruptedURL,
    reserved = false,
    stopped;
  const loadingFailed = (event) => {
    if (event.canceled === true) cancelled.add(event.requestId);
  };
  const interrupt = (event) => {
    const command =
      !interruptedURL && !reserved
        ? "Fetch.failRequest"
        : "Fetch.continueRequest";
    if (command === "Fetch.failRequest") reserved = true;
    const operation = Promise.resolve()
      .then(() =>
        cdp.send(command, {
          requestId: event.requestId,
          ...(command === "Fetch.failRequest"
            ? { errorReason: "InternetDisconnected" }
            : {}),
        }),
      )
      .then(() => {
        if (command === "Fetch.failRequest") interruptedURL = event.request.url;
      })
      .catch((error) =>
        failures.push({
          command,
          requestId: event.requestId,
          networkId: event.networkId,
          error,
        }),
      )
      .finally(() => {
        if (command === "Fetch.failRequest") reserved = false;
        pending.delete(operation);
      });
    pending.add(operation);
  };
  cdp.on("Network.loadingFailed", loadingFailed);
  cdp.on("Fetch.requestPaused", interrupt);
  return {
    interruptedURL: () => interruptedURL,
    stop() {
      return (stopped ??= (async () => {
        // No new callbacks may create commands while this owned interception drains.
        cdp.off("Fetch.requestPaused", interrupt);
        await Promise.all([...pending]);
        try {
          await cdp.send("Fetch.disable");
        } finally {
          cdp.off("Network.loadingFailed", loadingFailed);
        }
        // Abort events can arrive after the command rejects; classify only after the
        // protocol round trip above. Never excuse an uncorrelated or different error.
        const expectedCancellation = (row) =>
          row.command === "Fetch.continueRequest" &&
          /Protocol error \(Fetch\.continueRequest\): Invalid InterceptionId\.?$/.test(
            row.error.message,
          ) &&
          row.networkId &&
          cancelled.has(row.networkId);
        const unexpected = failures.filter((row) => !expectedCancellation(row));
        if (unexpected.length)
          throw new AggregateError(
            unexpected.map((row) => row.error),
            "Unexpected CDP interception failures: " +
              unexpected
                .map(
                  (row) =>
                    `${row.command} ${row.requestId}/${row.networkId || "no-network-id"}: ${row.error.message}`,
                )
                .join("; "),
          );
        return {
          cancelled: failures
            .filter(expectedCancellation)
            .map((row) => row.networkId),
        };
      })());
    },
  };
}

test(
  "V8 real live capability: source edits preserve playing audio, last good frame, seeks and cached dependencies at 450 ms RTT",
  { skip: !databaseURL, timeout: 240000 },
  async (t) => {
    assert.match(new URL(databaseURL).pathname, /frame_test/);
    const owned = path.join(root, ".cache/v8-browser", randomUUID()),
      data = path.join(owned, "data");
    fs.mkdirSync(data, { recursive: true });
    const f = fixture({ browser: true }),
      db = await database(databaseURL, "v8-browser-password");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const port = Number(process.env.FRAME_TEST_PORT || 55779),
      origin = "http://127.0.0.1:" + port;
    let platform, browser, page, cdp, interception;
    const transfers = [],
      requests = [],
      consoleErrors = [];
    try {
      fs.writeFileSync(f.file("project.ts"), project());
      fs.writeFileSync(f.file("scene.ts"), scene(colors.red));
      fs.writeFileSync(f.file("audio.ts"), audio);
      fs.writeFileSync(f.file("audio.json"), JSON.stringify(audioDocument()));
      platform = await createApp({
        db,
        data,
        masterKey: "82".repeat(32),
        origin,
        scheduler: false,
      });
      const { app, actions } = platform;
      app.log.level = "warn";
      const repository = await actions.call("repositories_add", {
        name: "V8 browser source",
      });
      let projectDir = path.join(
        data,
        "repos",
        repository.id,
        "projects/test-film",
      );
      fs.cpSync(f.file(""), projectDir, { recursive: true });
      await actions.works.discover(repository.id);
      const work = (await actions.call("works_page", { repo: repository.id }))
        .items[0];
      // Discovery creates the actual per-work branch checkout used by authoring and preview.
      projectDir = (await platform.repos.project(repository.id, work.project))
        .dir;
      const live = await actions.call("works_live_preview", {
        id: work.id,
        ai: true,
      });
      assert.match(live.url, /\/preview-live\//);
      const again = await actions.call("works_live_preview", { id: work.id });
      assert.equal(
        again.sessionId,
        live.sessionId,
        "opening the same source reuses the running session",
      );
      assert.equal(
        Number((await db.one("SELECT count(*)::int AS n FROM tasks")).n),
        0,
        "live preview does not enqueue a build",
      );
      await app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      const context = await browser.newContext();
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin },
        payload: { password: "v8-browser-password" },
      });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = login.headers["set-cookie"].split(";")[0],
        index = cookie.indexOf("=");
      await context.addCookies([
        {
          name: cookie.slice(0, index),
          value: cookie.slice(index + 1),
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 450,
        downloadThroughput: 256 * 1024,
        uploadThroughput: 128 * 1024,
        connectionType: "cellular3g",
      });
      const pending = new Map();
      cdp.on("Network.requestWillBeSent", (event) => {
        requests.push({ url: event.request.url, type: event.type });
        pending.set(event.requestId, {
          url: event.request.url,
          type: event.type,
        });
      });
      cdp.on("Network.loadingFinished", (event) => {
        const item = pending.get(event.requestId);
        if (item) {
          transfers.push({ ...item, bytes: event.encodedDataLength });
          pending.delete(event.requestId);
        }
      });
      await page.addInitScript(() => {
        const Native = window.AudioContext;
        window.__V8_CONTEXTS__ = [];
        window.AudioContext = class extends Native {
          constructor(...args) {
            super(...args);
            window.__V8_CONTEXTS__.push(this);
          }
        };
      });
      const started = Date.now();
      const shell = await page.goto(
        origin + live.url + (live.url.includes("?") ? "&" : "?") + "debug=1",
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(shell.status(), 200, await shell.text());
      await page.waitForFunction(
        () =>
          window.__FRAME_STUDIO__?.ready ||
          window.__FRAME_LIVE_STATUS__?.state === "error",
        null,
        {
          timeout: 90000,
        },
      );
      const boot = await page.evaluate(() => ({
        ready: window.__FRAME_STUDIO__?.ready,
        status: window.__FRAME_LIVE_STATUS__,
        text: document.body.innerText,
      }));
      assert.equal(boot.ready, true, JSON.stringify(boot));
      await waitColor(page, colors.red);
      t.diagnostic(
        "Cold live source ready under 450 ms RTT / 256 KiB/s: " +
          (Date.now() - started) +
          " ms",
      );
      await page.getByTestId("play-toggle").click();
      await page.waitForFunction(
        () =>
          window.__FRAME_STUDIO__.getState().time > 0.25 &&
          window.__V8_SOUND__?.active === 1,
      );
      const before = await readPlayback(page);
      assert.equal(before.contexts, 1);
      assert.equal(before.sound.started, 1);
      assert.equal(before.state.playing, true);
      const initialScripts = new Set(
        transfers
          .filter((entry) => entry.type === "Script")
          .map((entry) => entry.url),
      );
      const warmTransferStart = transfers.length,
        warmRequestStart = requests.length,
        hotStart = Date.now();
      fs.writeFileSync(path.join(projectDir, "scene.ts"), scene(colors.blue));
      try {
        await waitColor(page, colors.blue);
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            server: await actions.call("works_live_preview", { id: work.id }),
            player: await readPlayback(page),
            view: await page.evaluate(() => ({
              status: window.__FRAME_LIVE_STATUS__,
              text: document.body.innerText,
              pixels: [...document.querySelectorAll("canvas")].map(
                (canvas) => ({
                  width: canvas.width,
                  height: canvas.height,
                  pixel: [
                    ...canvas
                      .getContext("2d")
                      .getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
                      .data,
                  ],
                }),
              ),
            })),
          }),
        );
        throw error;
      }
      const updated = await readPlayback(page),
        hotMs = Date.now() - hotStart;
      assert.equal(
        updated.contexts,
        before.contexts,
        "visual edit preserves the AudioContext",
      );
      assert.equal(
        updated.sound.started,
        before.sound.started,
        "visual edit does not restart the sounding oscillator",
      );
      assert.equal(updated.sound.active, 1);
      assert.equal(updated.state.playing, true);
      assert.ok(
        updated.state.time > before.state.time,
        "the common playback clock continues through a visual edit",
      );
      assert.equal(
        updated.scenes.active,
        1,
        "only the replacement scene remains alive",
      );
      assert.ok(
        hotMs < 8000,
        "small warm source change must fit the weak-network deadline",
      );
      assert.ok(
        changedBytes(transfers, warmTransferStart) < 256 * 1024,
        "small visual edit does not redownload the engine and framework bundles",
      );
      const vendorTransfers = transfers
        .slice(warmTransferStart)
        .filter(
          (entry) => initialScripts.has(entry.url) && entry.type === "Script",
        );
      assert.ok(
        vendorTransfers.every((entry) => entry.bytes < 1000),
        "heavy unchanged dependency responses come from browser cache",
      );
      assert.ok(
        requests.length - warmRequestStart < 20,
        "one edit has a bounded number of requests",
      );
      t.diagnostic(
        "Warm visual update: " +
          hotMs +
          " ms, " +
          changedBytes(transfers, warmTransferStart) +
          " transferred bytes",
      );

      const document = audioDocument();
      document.clips[0].gain = 0.35;
      fs.writeFileSync(
        path.join(projectDir, "audio.json"),
        JSON.stringify(document),
      );
      await page.waitForFunction(
        () => Math.abs(window.__V8_SOUND__?.gains.at(-1)?.value - 0.35) < 0.005,
      );
      const gain = await readPlayback(page);
      assert.equal(gain.contexts, 1);
      assert.equal(
        gain.sound.started,
        1,
        "changing gain adjusts the existing source node",
      );
      assert.equal(gain.state.playing, true);
      document.clips[0].start = 0.25;
      document.clips[0].offset = 0.5;
      document.clips[0].duration = 119.75;
      fs.writeFileSync(
        path.join(projectDir, "audio.json"),
        JSON.stringify(document),
      );
      await page.waitForFunction(() => window.__V8_SOUND__.started === 2);
      const retimed = await readPlayback(page);
      assert.equal(retimed.contexts, 1);
      assert.equal(
        retimed.sound.active,
        1,
        "retiming leaves one current source",
      );
      assert.equal(retimed.state.playing, true);
      const call = retimed.sound.calls.at(-1);
      assert.ok(
        Math.abs(call.offset - (retimed.state.time + 0.25)) < 0.5,
        "replacement audio is scheduled against current absolute project time",
      );

      const lastGood = await readPlayback(page);
      fs.writeFileSync(
        path.join(projectDir, "scene.ts"),
        "export function createScene( { this is invalid syntax",
      );
      await page.waitForFunction(
        () =>
          !!window.__FRAME_STUDIO__?.getDiagnostics()?.livePreview?.lastError ||
          [...document.querySelectorAll('[role="alert"]')].some((element) =>
            element.textContent?.trim(),
          ),
        null,
        { timeout: 20000 },
      );
      await waitColor(page, colors.blue);
      const failed = await readPlayback(page);
      assert.equal(
        failed.sound.started,
        lastGood.sound.started,
        "compile error keeps last good sound running",
      );
      assert.equal(failed.state.playing, true);
      assert.equal(failed.scenes.active, 1);
      fs.writeFileSync(
        path.join(projectDir, "scene.ts"),
        scene(colors.red, { fail: true }),
      );
      await page.waitForFunction(
        () =>
          String(
            window.__FRAME_STUDIO__?.getDiagnostics()?.livePreview?.lastError ||
              document.body.innerText,
          ).includes("V8 candidate scene initialization failed"),
        null,
        { timeout: 20000 },
      );
      await waitColor(page, colors.blue);
      assert.equal(
        (await readPlayback(page)).sound.started,
        lastGood.sound.started,
        "initialization failure cannot replace audio or the last good renderer",
      );
      fs.writeFileSync(path.join(projectDir, "scene.ts"), scene(colors.green));
      await waitColor(page, colors.green);
      await page.waitForFunction(
        () => !window.__FRAME_STUDIO__.getDiagnostics().livePreview?.lastError,
      );
      const recovered = await readPlayback(page);
      assert.equal(recovered.sound.started, lastGood.sound.started);
      assert.equal(recovered.scenes.active, 1);
      await page.evaluate(() => window.__FRAME_STUDIO__.pause());
      await page.evaluate(() => window.__FRAME_STUDIO__.seek(9.5));
      const paused = await readPlayback(page);
      assert.equal(paused.state.playing, false);
      assert.ok(Math.abs(paused.state.time - 9.5) < 0.01);
      assert.equal(paused.sound.active, 0);
      fs.writeFileSync(path.join(projectDir, "scene.ts"), scene(colors.red));
      await waitColor(page, colors.red);
      const pausedUpdate = await readPlayback(page);
      assert.equal(pausedUpdate.state.playing, false);
      assert.ok(
        Math.abs(pausedUpdate.state.time - 9.5) < 0.01,
        "paused edit retains selected time",
      );
      assert.equal(pausedUpdate.contexts, 1);

      // Both context and this independently throttled CDP session must be offline.
      // An established event stream need not emit an immediate error while disconnected.
      const offlineRevision = (
        await actions.call("works_live_preview", { id: work.id })
      ).revision;
      await context.setOffline(true);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 450,
        downloadThroughput: 256 * 1024,
        uploadThroughput: 128 * 1024,
        connectionType: "cellular3g",
      });
      await page.waitForFunction(() => !navigator.onLine);
      fs.writeFileSync(path.join(projectDir, "scene.ts"), scene("#c2410c"));
      let offlineLink;
      for (let attempt = 0; attempt < 60; attempt++) {
        offlineLink = await actions.call("works_live_preview", { id: work.id });
        if (offlineLink.revision > offlineRevision) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(
        offlineLink.revision > offlineRevision,
        "server publishes an uncached source revision while viewer is offline",
      );
      await waitColor(page, colors.red);
      assert.equal((await readPlayback(page)).state.playing, false);
      await context.setOffline(false);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 450,
        downloadThroughput: 256 * 1024,
        uploadThroughput: 128 * 1024,
        connectionType: "cellular3g",
      });
      await waitColor(page, "#c2410c");
      const reconnected = await readPlayback(page);
      assert.equal(
        reconnected.contexts,
        1,
        "reconnect preserves the live playback session",
      );
      assert.equal(reconnected.state.playing, false);
      assert.ok(Math.abs(reconnected.state.time - 9.5) < 0.01);

      // Interrupt exactly one uncached module fetch while SSE remains connected.
      // Automatic retry of this same immutable revision must work without poisoning ESM.
      interception = interruptModuleFetch(cdp);
      await cdp.send("Fetch.enable", {
        patterns: [
          {
            urlPattern: origin + "/preview-live/*/assets/*.js",
            requestStage: "Request",
          },
        ],
      });
      fs.writeFileSync(path.join(projectDir, "scene.ts"), scene("#0f766e"));
      await page.waitForFunction(
        () =>
          ["error", "reconnecting"].includes(
            window.__FRAME_LIVE_STATUS__?.state,
          ),
        null,
        { timeout: 20000 },
      );
      const interceptionResult = await interception.stop();
      const interruptedURL = interception.interruptedURL();
      assert.ok(
        interruptedURL,
        "a real uncached module request was interrupted successfully",
      );
      if (interceptionResult.cancelled.length)
        t.diagnostic(
          "Concurrent module requests cancelled by the preview: " +
            interceptionResult.cancelled.join(", "),
        );
      await waitColor(page, "#0f766e");
      assert.equal((await readPlayback(page)).contexts, 1);
      assert.ok(Math.abs((await readPlayback(page)).state.time - 9.5) < 0.01);
      t.diagnostic(
        "Interrupted immutable module request recovered automatically: " +
          interruptedURL.split("/").pop(),
      );

      // An actual isolated agent task draft is a second source; it must neither publish
      // nor overwrite the source project merely because the user previews it.
      const taskId = randomUUID(),
        runDir = path.join(data, "runs", taskId, "projects/test-film");
      fs.cpSync(projectDir, runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "scene.ts"), scene(colors.green));
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input) VALUES($1,$2,'test-film','agent','running','{}')",
        [taskId, repository.id],
      );
      const draft = await actions.call("works_live_preview", {
        id: work.id,
        task: taskId,
      });
      assert.notEqual(draft.sessionId, live.sessionId);
      const draftPage = await context.newPage();
      await draftPage.goto(origin + draft.url + "?debug=1", {
        waitUntil: "domcontentloaded",
      });
      await draftPage.waitForFunction(
        () => window.__FRAME_STUDIO__?.ready,
        null,
        { timeout: 90000 },
      );
      await waitColor(draftPage, colors.green);
      fs.writeFileSync(path.join(runDir, "scene.ts"), scene(colors.blue));
      await waitColor(draftPage, colors.blue);
      await waitColor(page, "#0f766e");
      assert.equal(
        fs.readFileSync(path.join(projectDir, "scene.ts"), "utf8"),
        scene("#0f766e"),
        "draft preview never modifies work source",
      );
      assert.equal(
        Number(
          (
            await db.one(
              "SELECT count(*)::int AS n FROM tasks WHERE kind='build'",
            )
          ).n,
        ),
        0,
      );
      await draftPage.close();

      assert.deepEqual(
        consoleErrors.filter(
          (error) =>
            !/(Failed to fetch dynamically imported module|V8 candidate scene initialization failed)/.test(
              error,
            ),
        ),
        [],
      );
      t.diagnostic(
        JSON.stringify({
          requestCount: requests.length,
          transferBytes: changedBytes(transfers, 0),
          hotMs,
          final: await readPlayback(page),
        }),
      );
    } finally {
      try {
        await interception?.stop();
      } finally {
        await browser?.close();
        await platform?.app.close();
        f.close();
        fs.rmSync(owned, { recursive: true, force: true });
      }
    }
  },
);

const turn = () => new Promise((resolve) => setImmediate(resolve));
const paused = (requestId, networkId) => ({
  requestId,
  networkId,
  request: { url: "http://fixture.invalid/" + requestId + ".js" },
});
function interceptionFixture(continueRequest) {
  const cdp = new EventEmitter(),
    commands = [];
  cdp.send = async (command, parameters) => {
    commands.push({ command, parameters });
    if (command === "Fetch.continueRequest") return continueRequest(parameters);
  };
  return { cdp, commands, interception: interruptModuleFetch(cdp) };
}

test("V8 CDP fixture drains registered commands before disabling and detaches owned listeners", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cdp, commands, interception } = interceptionFixture(() => gate);
  cdp.emit("Fetch.requestPaused", paused("first", "network-1"));
  cdp.emit("Fetch.requestPaused", paused("second", "network-2"));
  await turn();
  assert.equal(
    interception.interruptedURL(),
    "http://fixture.invalid/first.js",
  );
  const stopped = interception.stop();
  cdp.emit("Fetch.requestPaused", paused("after-stop", "network-3"));
  await turn();
  assert.deepEqual(
    commands.map((row) => row.command),
    ["Fetch.failRequest", "Fetch.continueRequest"],
  );
  assert.equal(cdp.listenerCount("Fetch.requestPaused"), 0);
  release();
  assert.deepEqual(await stopped, { cancelled: [] });
  await interception.stop();
  assert.deepEqual(
    commands.map((row) => row.command),
    ["Fetch.failRequest", "Fetch.continueRequest", "Fetch.disable"],
  );
  assert.equal(cdp.listenerCount("Network.loadingFailed"), 0);
});

test("V8 CDP fixture recognizes only matching cancelled Network requests even when cancellation arrives after rejection", async () => {
  const error = Error(
    "cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.",
  );
  const { cdp, interception } = interceptionFixture(async () => {
    throw error;
  });
  cdp.emit("Fetch.requestPaused", paused("first", "network-1"));
  await turn();
  cdp.emit("Fetch.requestPaused", paused("cancelled", "network-cancelled"));
  await turn();
  cdp.emit("Network.loadingFailed", {
    requestId: "network-cancelled",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  assert.deepEqual(await interception.stop(), {
    cancelled: ["network-cancelled"],
  });
  assert.equal(cdp.listenerCount("Fetch.requestPaused"), 0);
  assert.equal(cdp.listenerCount("Network.loadingFailed"), 0);
});

for (const [name, message, cancelled] of [
  [
    "uncorrelated Invalid InterceptionId",
    "cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.",
    false,
  ],
  [
    "unrelated protocol error on a cancelled request",
    "cdpSession.send: Protocol error (Fetch.continueRequest): Unexpected fixture failure.",
    true,
  ],
  [
    "matching Network error without the cancelled flag",
    "cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.",
    "false-flag",
  ],
  [
    "matching Network error with the cancelled flag absent",
    "cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.",
    "missing-flag",
  ],
]) {
  test("V8 CDP fixture fails for " + name, async () => {
    const error = Error(message);
    const { cdp, interception } = interceptionFixture(async () => {
      throw error;
    });
    cdp.emit("Fetch.requestPaused", paused("first", "network-1"));
    await turn();
    cdp.emit("Fetch.requestPaused", paused("failed", "network-failed"));
    await turn();
    cdp.emit("Network.loadingFailed", {
      requestId:
        cancelled === "false-flag" ||
        cancelled === "missing-flag" ||
        cancelled === true
          ? "network-failed"
          : "other-request",
      ...(cancelled === "missing-flag"
        ? {}
        : { canceled: cancelled !== "false-flag" }),
      errorText: "net::ERR_ABORTED",
    });
    await assert.rejects(
      interception.stop(),
      (result) =>
        result instanceof AggregateError &&
        result.errors.length === 1 &&
        result.errors[0] === error,
    );
    assert.equal(cdp.listenerCount("Fetch.requestPaused"), 0);
    assert.equal(cdp.listenerCount("Network.loadingFailed"), 0);
  });
}
