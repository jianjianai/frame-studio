import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { BasicSoundBank } from "spessasynth_core";
import { fixture, repo } from "../mcp/helpers.mjs";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { browserOptions } from "../../scripts/browser.mjs";

const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
test("Soundfont native queue survives synchronous 850ms visual frames and releases seek/pause voices", { timeout: 120000 }, async t => {
  const f = fixture({ browser: true });
  let server, browser;
  try {
    for (const name of ["soundfont-stream.ts", "soundfont-audio.ts", "soundfont.worker.ts", "audio.ts", "player-session.ts"])
      assert.equal(sha(path.join(f.root, "src/engine", name)), sha(path.join(repo, "src/engine", name)), name);
    const bank = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
    fs.writeFileSync(f.file("public/bank.sf2"), bank);
    const digest = createHash("sha256").update(bank).digest("hex");
    const score = { id: "test-film", duration: 16, bpm: 120, meter: 4, notes: [{ channel: 0, t: 0, end: 15, pitch: 60, velocity: 100 }],
      controls: [{ t: 0, data: [0xc0, 0] }], instruments: [{ channel: 0, program: 0, name: "fixture", volume: 100, pan: 64, reverb: 0 }], cues: [] };
    fs.writeFileSync(f.file("audio.ts"), [
      'import {createSampledScoreAudio} from "../../src/engine/soundfont-audio";',
      'const module=createSampledScoreAudio({score:' + JSON.stringify(score) + ',bank:"films/test-film/bank.sf2",sha256:' + JSON.stringify(digest) + ',levels:{music:.5,master:.8},',
      'foley:()=>{const n=48000*16;return [0,1].map(()=>Float32Array.from({length:n},(_,i)=>.05*Math.sin(i*2*Math.PI*440/48000)));}});',
      'export const {prepareAudio,prepareSegment,createAudio,disposeAudio}=module;window.__scoreModule=module;',
    ].join("\n"));
    fs.writeFileSync(f.file("project.ts"), [
      'import type {AnimationProject} from "../../src/engine/types";',
      'export default {id:"test-film",title:"Soundfont queue",subtitle:"",description:"fixture",renderer:"canvas",duration:16,fps:12,accent:"#123456",poster:"films/test-film/poster.svg",tags:[],status:"draft",beats:[],subtitles:[],credits:[],',
      'audioTracks:[{id:"music",name:"music",kind:"generated",gain:1},{id:"foley",name:"foley",kind:"generated",gain:1}],load:()=>import("./scene"),loadAudio:()=>import("./audio")} satisfies AnimationProject;',
    ].join("\n"));
    fs.writeFileSync(f.file("scene.ts"), [
      'export function createScene({width,height}) { const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");',
      'return {canvas,render(time){const began=performance.now();if(window.__heavy){while(performance.now()-began<850){} window.__heavyFrames++;window.__maxFrame=Math.max(window.__maxFrame,performance.now()-began);}ctx.fillRect(0,0,width,height);},dispose(){}};}',
    ].join("\n"));
    fs.writeFileSync(path.join(f.root, "stream-harness.ts"), [
      'import {createPlayerSession} from "/src/engine/player-session";import {findProject} from "/src/projects";import {ScoreStream,createStreamVoice} from "/src/engine/soundfont-stream";window.__streamHelpers={ScoreStream,createStreamVoice};',
      'window.__errors=[];window.__heavyFrames=0;window.__maxFrame=0;window.__heavy=false;',
      'const canvas=document.createElement("canvas");document.body.append(canvas);',
      'const session=createPlayerSession({canvas,project:findProject("test-film"),quality:"draft",embedded:false,initial:{time:0,playing:false,buffering:false,rate:1,loop:false,volume:1,muted:false},controls:{},subtitles:()=>false,segmentEnd:()=>null,onSegmentEnd:()=>{},onSnapshot:()=>{},onLoading:()=>{},onStarting:()=>{},onError:e=>{if(e)window.__errors.push(e);},onFps:()=>{},onTrackControl:()=>{}});window.__session=session;window.__FRAME_STUDIO__=session.api;',
    ].join("\n"));
    fs.writeFileSync(path.join(f.root, "stream.html"), '<!doctype html><html><body><script type="module" src="/stream-harness.ts"></script></body></html>');
    const cfg = projectConfig(f.root, "test-film");
    cfg.server.port = Number(process.env.FRAME_TEST_PORT || 0); cfg.server.strictPort = true;
    server = await createServer(cfg); await server.listen();
    const options = browserOptions();
    browser = await chromium.launch({ ...options, args: [...options.args, "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/stream.html");
    await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
    await t.test("native readiness, cancellation, bounded demand and offline span", async () => {
      const proof = await page.evaluate(async score => {
        const {ScoreStream,createStreamVoice}=window.__streamHelpers;
        const context=new AudioContext();await context.suspend();const inputErrors=[];const destination=context.createGain();destination.connect(context.destination);
        const native=context.createBufferSource.bind(context), nodes=[], intervals=new Set(), workers=new Set();
        const originalInterval=window.setInterval, originalClear=window.clearInterval, OriginalWorker=window.Worker;
        window.setInterval=(fn,ms,...args)=>{const id=originalInterval(fn,ms,...args);if(ms===100)intervals.add(id);return id;};
        window.clearInterval=id=>{intervals.delete(id);originalClear(id);};
        window.Worker=class extends OriginalWorker {constructor(...args){super(...args);workers.add(this);}terminate(){workers.delete(this);super.terminate();}};
        context.createBufferSource=()=>{const node=native();const entry={stopped:false,disconnected:false,end:0};nodes.push(entry);
          const start=node.start.bind(node),stop=node.stop.bind(node),disconnect=node.disconnect.bind(node);
          node.start=(at,offset,duration)=>{entry.end=at+duration/node.playbackRate.value;start(at,offset,duration);};
          node.stop=(...args)=>{entry.stopped=true;return stop(...args);};node.disconnect=(...args)=>{entry.disconnected=true;return disconnect(...args);};return node;};
        const make=()=>new ScoreStream({score,foley:()=>[new Float32Array(48000*score.duration),new Float32Array(48000*score.duration)],levels:{music:.5,master:.8}},async()=>await(await fetch("/films/test-film/bank.sf2")).arrayBuffer());
        const options=trackId=>({context,destination,offset:0,duration:score.duration,when:.04,rate:1,trackId,onError:e=>{inputErrors.push(e.message);}});
        const stream=make();let ownedWorker, readyCoverage, readyNodes, cancelled, cleanup, budget, offline;
        try {
          await stream.initialize();
          ownedWorker=stream.worker;
          if(!workers.has(ownedWorker))throw new Error("Owned worker was not captured");
          window.__trackedScoreWorkers=workers;
          // A slow previous preparation makes the startup target six seconds.
          // Completion of this faster request decays the shared policy: the
          // current voice must still honor its original target.
          stream.buffering.observePreparation(6);
          const voices=["music","foley"].map(id=>createStreamVoice(stream,options(id),false));
          await Promise.all(voices.map(v=>v.ready));
          readyNodes=nodes.length;readyCoverage=Math.max(...nodes.map(n=>n.end));
          budget=[1,4,16,64,512].map(rate=>({rate,initial:stream.bufferSeconds(rate,true),steady:stream.bufferSeconds(rate),futureBytes:stream.bufferSeconds(rate)*rate*2*384000}));
          voices.forEach(v=>v.dispose());
          // Dispose immediately while initial ensure is pending, before any ready continuation.
          cancelled=[];
          for(const offset of [0,12]){
            const pending=createStreamVoice(stream,{...options("music"),offset,when:.04},false);
            const settled=Promise.resolve(pending.ready).then(()=>"resolved",e=>e.name);pending.dispose();
            cancelled.push(await settled);
          }
          stream.dispose();await new Promise(r=>setTimeout(r,150));
          cleanup={timers:intervals.size,workers:workers.has(ownedWorker)?1:0,listeners:stream.listeners.size,waiters:stream.waiters.size,
            allNodesStopped:nodes.every(n=>n.stopped),allNodesDisconnected:nodes.every(n=>n.disconnected),nodes:nodes.length};
          const module=window.__scoreModule, ctx=new OfflineAudioContext(2,Math.ceil(1.3/1.5*44100),44100);
          await module.prepareAudio(ctx);await module.prepareSegment({context:ctx,offset:9.25,duration:1.3,rate:1.5});
          const voice=module.createAudio({context:ctx,destination:ctx.destination,offset:9.25,duration:1.3,when:0,rate:1.5,trackId:"foley"});
          const rendered=await ctx.startRendering();const pcm=rendered.getChannelData(0);
          offline={frames:rendered.length,expected:Math.ceil(1.3/1.5*44100),finite:pcm.every(Number.isFinite),peak:Math.max(...pcm),readyAbsent:voice.ready===undefined};
          voice.dispose();module.disposeAudio(ctx);
        } finally {stream.dispose();await context.close();window.setInterval=originalInterval;window.clearInterval=originalClear;window.Worker=OriginalWorker;}
        return {readyCoverage,readyNodes,cancelled,cleanup,budget,offline,inputErrors};
      }, score);
      console.log("soundfont queue lifecycle evidence",JSON.stringify(proof));
      assert.deepEqual(proof.inputErrors, []);assert.ok(proof.readyCoverage>=6 && proof.readyCoverage<=12.3,JSON.stringify(proof));
      assert.ok(proof.readyNodes>20 && proof.readyNodes<100);assert.deepEqual(proof.cancelled,["AbortError","AbortError"]);
      assert.deepEqual(proof.cleanup,{timers:0,workers:0,listeners:0,waiters:0,allNodesStopped:true,allNodesDisconnected:true,nodes:proof.cleanup.nodes});
      for(const b of proof.budget){assert.ok(b.initial<=12 && b.steady<=24);assert.ok(b.futureBytes<=128*1024*1024);}
      assert.equal(proof.offline.frames,proof.offline.expected);assert.equal(proof.offline.finite,true);
      assert.ok(proof.offline.peak>.01);assert.equal(proof.offline.readyAbsent,true);
    });
    const result = await page.evaluate(async () => {
      const session=window.__session, api=session.api, context=session.audio.context;
      await session.audio.preparePosition();
      const destination=context.createMediaStreamDestination();session.audio.gain.connect(destination);
      const chunks=[];const recorder=new MediaRecorder(destination.stream);
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
      recorder.start();window.__heavy=true;
      await api.play();
      const started=context.currentTime;await new Promise(resolve=>setTimeout(resolve,6200));
      const during=api.getState();window.__heavy=false;api.pause();
      recorder.stop();await stopped;destination.stream.getTracks().forEach(track=>track.stop());session.audio.gain.disconnect(destination);destination.disconnect();
      const decoded=await context.decodeAudioData(await new Blob(chunks).arrayBuffer());
      const samples=decoded.getChannelData(0);let finite=true,peak=0;const rms=[];
      // Exclude capture startup and final silence; retain every interior 200ms bin.
      for(let from=Math.ceil(decoded.sampleRate*.75);from+decoded.sampleRate*.2<samples.length-decoded.sampleRate*.75;from+=Math.round(decoded.sampleRate*.2)){
        let sum=0;for(let i=from;i<from+decoded.sampleRate*.2;i++){finite&&=Number.isFinite(samples[i]);peak=Math.max(peak,Math.abs(samples[i]));sum+=samples[i]*samples[i];}rms.push(Math.sqrt(sum/(decoded.sampleRate*.2)));
      }
      await api.seek(9);api.setRate(1.5);await api.play();await new Promise(resolve=>setTimeout(resolve,250));api.pause();
      const paused=api.getState();await new Promise(resolve=>setTimeout(resolve,200));const after=api.getState();
      session.dispose();await new Promise(resolve=>setTimeout(resolve,150));
      return {during,elapsed:context.currentTime-started,frames:window.__heavyFrames,maxFrame:window.__maxFrame,finite,peak,rms,paused,after,errors:window.__errors,closed:context.state,recorder:recorder.state,trackedWorkers:window.__trackedScoreWorkers.size};
    });
    console.log("soundfont heavy-frame evidence", JSON.stringify(result));
    assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
    assert.ok(result.frames >= 5 && result.maxFrame >= 849, JSON.stringify(result));
    assert.equal(result.during.playing, true);
    assert.ok(result.during.time >= 5, JSON.stringify(result.during));
    assert.equal(result.finite, true); assert.ok(result.peak > .005);
    assert.ok(result.rms.length >= 15); assert.ok(Math.min(...result.rms) > .003, JSON.stringify(result.rms));
    assert.equal(result.paused.playing, false); assert.ok(result.paused.time > 9);
    assert.ok(Math.abs(result.after.time-result.paused.time)<.001);
    assert.equal(result.closed, "closed"); assert.equal(result.recorder, "inactive");assert.equal(result.trackedWorkers,0);
  } finally { await browser?.close(); await server?.close(); f.close(); }
});
