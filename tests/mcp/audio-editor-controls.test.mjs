import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";

const root = path.resolve(".");
const document = {
  schemaVersion: 1,
  sources: [{ id: "sample", kind: "file", src: "films/audit/sample.wav" }],
  tracks: [
    {
      id: "track",
      name: "音轨",
      gain: 1,
      pan: 0,
      muted: false,
      processors: [],
      output: "master",
      sends: [],
    },
  ],
  clips: [
    {
      id: "clip",
      track: "track",
      source: "sample",
      name: "采样片段",
      start: 0,
      duration: 5,
      offset: 0,
      phase: 0,
      rate: 1,
      pitch: 0,
      preservePitch: true,
      gain: 1,
      pan: 0,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      fadeOffset: 0,
      automation: [],
    },
  ],
  buses: [],
  master: { gain: 1, processors: [] },
  linkedVideo: true,
};

test(
  "actual audio editor commits numeric drafts, merges Tone JSON, enforces disabled state and keeps waveform work stable",
  { timeout: 120000 },
  async (t) => {
    const owned = path.join(root, ".cache/audio-editor-controls", randomUUID());
    await fs.mkdir(owned, { recursive: true });
    const ui = "\0audio-controls-ui";
    const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{AudioEditor}from'/studio/audio-editor.jsx';import{ToneEffectEditor}from'/studio/tone-effect-editor.jsx';window.auditCalls=[];window.waveReads=0;function App(){const[fx,setFx]=useState({type:'tone',id:'effect',effect:'Reverb',options:{wet:.25,decay:1.5,preDelay:.01},tail:2});const[disabled,setDisabled]=useState(false);const[position,setPosition]=useState(0);window.fx=fx;window.setAuditDisabled=setDisabled;window.setAuditPosition=setPosition;return <><div id='tone'><ToneEffectEditor fx={fx} index={0} disabled={disabled} onChange={setFx}/></div><AudioEditor work={{id:'audit',project:'audit'}} visible position={position} disabled={disabled}/></>}createRoot(document.querySelector('#root')).render(<App/>);`;
    const fakeUi = `import React from'react';import{audioEngines,validateAudioDocument}from'/src/engine/audio-document.mjs';const doc=window.baseAudioDocument=validateAudioDocument(${JSON.stringify(document)});export async function api(name,args){window.auditCalls.push({name,args});if(name==='works_audio')return{declared:true,document:doc,duration:60,fps:30,sha256:'a'.repeat(64),projectSha256:'b'.repeat(64),engines:audioEngines};if(name==='works_files')return[];if(name==='works_audio_inspect')return{duration:10,peaks:new Proxy(Array(100).fill(.3),{get(t,k){if(/^\\d+$/.test(String(k)))window.waveReads++;return t[k]}}),sampleRate:48000,channels:2};if(name==='works_audio_edit')return{document:args.operations[0].document,declared:true,duration:60,fps:30,sha256:'c'.repeat(64),projectSha256:'b'.repeat(64),engines:audioEngines};throw Error(name)}export const Button=({children,...props})=>React.createElement('button',props,children);export const ErrorNote=({error})=>error?React.createElement('p',{role:'alert'},error):null;export const Loading=()=>React.createElement('p',null,'loading');`;
    await fs.writeFile(path.join(owned, "entry.jsx"), entry);
    await fs.writeFile(
      path.join(owned, "index.html"),
      `<div id="root"></div><script type="module" src="/${path.relative(root, path.join(owned, "entry.jsx")).replaceAll(path.sep, "/")}"></script>`,
    );
    const vite = await createServer({
      configFile: false,
      root,
      cacheDir: path.join(owned, "vite-cache"),
      plugins: [
        react(),
        {
          name: "audio-controls-fixture",
          enforce: "pre",
          resolveId(id, importer) {
            if (
              id === "./ui" &&
              /studio\/(audio-editor|tone-effect-editor)\.jsx$/.test(
                importer ?? "",
              )
            )
              return ui;
          },
          load(id) {
            if (id === ui) return fakeUi;
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: {
          allow: [root, await fs.realpath(path.join(root, "node_modules"))],
        },
        watch: { ignored: ["**/.cache/**"] },
      },
      optimizeDeps: {
        include: [
          "react",
          "react-dom/client",
          "lucide-react",
          "tone/build/esm/classes.js",
          "tone/build/esm/core/Global.js",
          "tone/build/esm/core/context/DummyContext.js",
          "tone/build/esm/core/context/AudioContext.js",
          "tone/build/esm/version.js",
          "zod",
        ],
        entries: [],
      },
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await vite.close();
      await fs.rm(owned, { recursive: true, force: true });
    });
    await vite.listen();
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      "http://127.0.0.1:" +
        vite.httpServer.address().port +
        "/" +
        path
          .relative(root, path.join(owned, "index.html"))
          .replaceAll(path.sep, "/"),
    );
    const clip = page.getByRole("button", {
      name: "音频片段 采样片段",
      exact: true,
    });
    await clip.click();
    const saved = () =>
      page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("frame-audio-draft:audit"))
            ?.document ?? window.baseAudioDocument,
      );
    const pitch = page.getByRole("spinbutton", {
      name: "移调半音",
      exact: true,
    });
    await pitch.fill("-");
    assert.equal((await saved()).clips[0].pitch, 0);
    await pitch.fill("-7");
    assert.equal((await saved()).clips[0].pitch, 0);
    await pitch.press("Enter");
    assert.equal((await saved()).clips[0].pitch, -7);
    await pitch.fill("-12");
    await pitch.press("Escape");
    assert.equal(await pitch.inputValue(), "-7");
    await pitch.press("ArrowUp");
    await pitch.press("Tab");
    assert.equal((await saved()).clips[0].pitch, -6);
    const rate = page.getByRole("spinbutton", { name: "速度倍率" });
    await rate.fill(".5");
    await rate.press("Tab");
    assert.equal((await saved()).clips[0].rate, 0.5);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(
      (await saved()).clips[0].rate,
      1,
      "one committed input makes exactly one undo step",
    );
    await page.locator(".audio-stretch-settings summary").click();
    const preset = page.getByLabel("处理预设");
    await preset.selectOption("manual");
    await page
      .getByRole("spinbutton", { name: "分析窗口毫秒（0 自动）" })
      .fill("500");
    await page
      .getByRole("spinbutton", { name: "分析窗口毫秒（0 自动）" })
      .press("Tab");
    assert.equal((await saved()).clips[0].stretch.blockMs, 500);
    await preset.selectOption("cheaper");
    assert.equal((await saved()).clips[0].stretch.blockMs, 0);
    assert.equal((await saved()).clips[0].stretch.intervalMs, 0);
    assert.equal(
      await page
        .getByRole("spinbutton", { name: "分析窗口毫秒（0 自动）" })
        .isDisabled(),
      true,
    );
    await page.locator("#tone .tone-json-settings summary").click();
    const json = page.getByRole("textbox", { name: "Tone 参数 JSON 1" }),
      wet = page.getByRole("spinbutton", { name: "Tone 湿声比例 1" });
    await json.fill('{"wet":0.25,"decay":12,"preDelay":0.02}');
    await wet.fill(".5");
    await wet.press("Tab");
    assert.equal(
      await json.inputValue(),
      '{"wet":0.25,"decay":12,"preDelay":0.02}',
    );
    await page.getByRole("button", { name: "应用 JSON 参数" }).click();
    assert.deepEqual(await page.evaluate(() => fx.options), {
      wet: 0.5,
      decay: 12,
      preDelay: 0.02,
    });
    await json.fill('{"wet":0.4,"decay":12,"preDelay":0.02}');
    await wet.fill(".6");
    await wet.press("Tab");
    await page.getByRole("button", { name: "应用 JSON 参数" }).click();
    assert.equal((await page.evaluate(() => fx.options)).wet, 0.6);
    assert.match(await page.locator("#tone").innerText(), /冲突/);
    await page.getByRole("button", { name: "冲突处保留 JSON" }).click();
    assert.equal((await page.evaluate(() => fx.options)).wet, 0.4);
    await json.fill('{"wet":0.25,"decay":-1}');
    await page.getByRole("button", { name: "应用 JSON 参数" }).click();
    assert.equal((await page.evaluate(() => fx.options)).decay, 12);
    assert.match(await page.locator("#tone").innerText(), /未应用/);
    await page.getByRole("button", { name: "恢复当前参数" }).click();
    await page.evaluate(() => setAuditDisabled(true));
    await page.waitForFunction(() => document.querySelector('.audio-editor select')?.disabled === true);
    for (const selector of [
      ".audio-editor select",
      ".audio-editor input",
      ".audio-editor button",
      "#tone select",
      "#tone input",
      "#tone textarea",
    ])
      for (const input of await page.locator(selector).all())
        assert.equal(await input.isDisabled(), true, selector);
    await page.evaluate(() => setAuditDisabled(false));
    await page.getByRole("button", { name: "主输出", exact: true }).click();
    await clip.focus();
    await clip.press("Space");
    assert.match(await clip.getAttribute("class"), /selected/);
    await page.getByRole("button", { name: "主输出", exact: true }).click();
    await clip.focus();
    await clip.press("Enter");
    assert.match(await clip.getAttribute("class"), /selected/);
    await page.waitForFunction(() => waveReads > 0);
    const waveBefore = await page.evaluate(() => waveReads);
    await page.evaluate(async () => {
      for (let i = 1; i <= 20; i++) {
        setAuditPosition(i / 30);
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    assert.equal(
      await page.evaluate(() => waveReads),
      waveBefore,
      "position updates reuse unchanged waveform geometry",
    );
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 780 });
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        body: document.body.scrollWidth,
        editor: document.querySelector(".audio-editor").scrollWidth,
        client: document.querySelector(".audio-editor").clientWidth,
      }));
      assert.ok(
        overflow.body <= width && overflow.editor <= overflow.client,
        JSON.stringify(overflow),
      );
    }
    // Constructor proof supplements the shared schema; the UI alone is not the validation gate.
    const constructors = await page.evaluate(async () => {
      const { defaultToneOptions, toneEffectLabels } =
        await import("/src/engine/tone-effect-options.mjs");
      const { prepareTone, createToneEffect } =
        await import("/src/engine/tone-runtime.ts");
      await prepareTone();
      const context = new OfflineAudioContext(2, 48000, 48000),
        names = [];
      for (const name of Object.keys(toneEffectLabels)) {
        const fx = createToneEffect(context, name, defaultToneOptions(name));
        await fx.ready;
        fx.dispose();
        names.push(name);
      }
      let rejection;
      try {
        createToneEffect(context, "Reverb", { decay: -1 });
      } catch (error) {
        rejection = String(error);
      }
      const crusher = createToneEffect(context, "BitCrusher", { bits: 4.5 });
      await crusher.ready;
      crusher.dispose();
      const shifter = createToneEffect(context, "FrequencyShifter", {
        frequency: -440,
      });
      await shifter.ready;
      shifter.dispose();
      return { names, rejection };
    });
    assert.equal(constructors.names.length, 18);
    assert.match(constructors.rejection, /0.001|RangeError/);
    assert.deepEqual(errors, []);
  },
);
