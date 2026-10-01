import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../../scripts/browser.mjs";

const child = `<!doctype html><script>
window.messages={};window.ports={};
window.ask=(requestId,options={})=>{
 const channel=new MessageChannel();messages[requestId]=[];ports[requestId]=channel.port1;
 channel.port1.onmessage=({data})=>{messages[requestId].push(data);if(window.autoAck&&data.type==="pcm")channel.port1.postMessage({type:"ack",sequence:data.sequence})};
 parent.postMessage({type:"frame-live-audio-input",op:"open",requestId,sampleRate:48000,channels:2,...options},"*",[channel.port2]);
};window.closeInput=id=>{ports[id].postMessage({type:"close"});ports[id].close()};window.autoAck=false;
<\/script>`;
const fake = `
window.stats={gum:0,enumerations:0,contexts:0,closed:0,stopped:0,speakerPeak:0,captured:0,workletCredits:0,held:[]};window.holdNative=false;
Object.defineProperty(navigator,"mediaDevices",{value:{
 async enumerateDevices(){stats.enumerations++;return [
 {kind:"audioinput",deviceId:"mic-a",groupId:"group-a",label:"Fixture Microphone"},
 {kind:"audioinput",deviceId:"mic-b",groupId:"group-b",label:"Second Microphone"},
 {kind:"audiooutput",deviceId:"speaker",groupId:"secret",label:"Speaker"},
 {kind:"videoinput",deviceId:"camera",groupId:"secret",label:"Camera"}]},
 async getUserMedia(constraints){
  stats.gum++;stats.constraints=constraints;
  if(window.holdNative)await new Promise(resolve=>window.finishNative=resolve);
  const track={kind:"audio",label:"Fixture Microphone",readyState:"live",getSettings:()=>({deviceId:"mic-a",sampleRate:48000}),stop(){if(this.readyState!=="ended"){this.readyState="ended";stats.stopped++}}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};window.lastTrack=track;return stream;
 }
}});
class MockProcessor {constructor(){this.port={onmessage:null,postMessage:()=>{}}}}
class FakeContext {
 constructor(options){this.sampleRate=options.sampleRate;this.destination={speaker:true};stats.contexts++;
  this.audioWorklet={addModule:async url=>{const source=await(await fetch(url)).text();
   new Function("AudioWorkletProcessor","registerProcessor",source)(MockProcessor,(_name,ctor)=>window.CaptureProcessor=ctor);
  }};
 }
 async resume(){} async close(){stats.closed++}
 createMediaStreamSource(){return {connect(){},disconnect(){}}}
}
window.AudioContext=FakeContext;
window.AudioWorkletNode=class {
 constructor(){this.processor=new CaptureProcessor();window.captureNode=this;this.port={onmessage:null,postMessage:data=>{stats.workletCredits++;this.processor.port.onmessage?.({data})}};
 this.processor.port.postMessage=(data,transfer)=>{
  stats.captured++;const packet=structuredClone(data,{transfer});
  const deliver=()=>this.port.onmessage?.({data:packet});
  if(window.holdCapture)stats.held.push(deliver);else queueMicrotask(deliver);
 };
 }
 connect(){} disconnect(){stats.disconnected=(stats.disconnected||0)+1}
};
window.feed=(blocks=1)=>{
 for(let i=0;i<blocks*8;i++){
  const left=new Float32Array(128).fill(.25),right=new Float32Array(128).fill(-.125),out=new Float32Array(128).fill(1);
  captureNode.processor.process([[left,right]],[[out]]);stats.speakerPeak=Math.max(stats.speakerPeak,...out.map(Math.abs));
 }
};
`;
const parent = `<!doctype html><iframe id="target" sandbox="allow-scripts" src="/preview-live/mic-fixture/index.html"></iframe><iframe id="foreign" sandbox="allow-scripts" src="/foreign.html"></iframe><div id="controls"></div><script>${fake}<\/script><script type="module">
import {liveAudioInputBridge} from "/broker.js";
const frame=document.getElementById("target");window.ref={current:frame};window.broker=liveAudioInputBridge(ref,frame.src,state=>{
 window.micState=state;const box=document.getElementById("controls");box.replaceChildren();
 const button=(text,action)=>{const b=document.createElement("button");b.textContent=text;b.onclick=action;box.append(b)};
 for(const request of state.requests){
 if(request.stage==="pending")button("允许此作品本次预览",event=>void broker.allow(request.requestId,event));
 button("拒绝本预览",()=>broker.deny(request.requestId));
 }
 if(state.granted||state.enumerationGranted)button("停止麦克风并撤销授权",()=>broker.stop());
 if(state.denied)button("允许重新申请麦克风",event=>broker.reallow(event));
});
window.brokerReady=true;
<\/script>`;

test(
  "trusted microphone broker authorizes once, bounds PCM and rejects foreign frames, denial and malformed requests",
  { timeout: 60000 },
  async () => {
    const source = await fs.readFile(
      path.resolve("studio/live-audio-input.js"),
      "utf8",
    );
    const server = http.createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/broker.js"
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
      );
      res.end(
        req.url === "/broker.js" ? source : req.url === "/" ? parent : child,
      );
    });
    let browser;
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      browser = await launchBrowser();
      const page = await browser.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://127.0.0.1:" + server.address().port);
      await page.waitForFunction(() => window.brokerReady);
      const frame = page
          .frames()
          .find((frame) => frame.url().includes("/preview-live/")),
        foreign = page
          .frames()
          .find((frame) => frame.url().includes("/foreign"));
      await frame.waitForFunction(() => window.ask);
      await foreign.waitForFunction(() => window.ask);
      assert.equal(
        await page.evaluate(() => stats.gum),
        0,
        "ordinary preview must not access microphone",
      );
      await foreign.evaluate(() => ask("foreign"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => micState.requests.length), 0);
      assert.equal(await page.evaluate(() => stats.gum), 0);
      for (const options of [
        { sampleRate: 0 },
        { channels: 8 },
        { constraints: { video: true } },
        { device: { video: true } },
      ]) {
        const id = "invalid-" + Math.random().toString(36).slice(2);
        await frame.evaluate(({ id, options }) => ask(id, options), {
          id,
          options,
        });
        await frame.waitForFunction(
          (id) => messages[id].some((message) => message.type === "error"),
          id,
        );
        assert.equal(
          await frame.evaluate(
            (id) =>
              messages[id].find((message) => message.type === "error").code,
            id,
          ),
          "TypeError",
        );
      }
      assert.equal(await page.evaluate(() => stats.gum), 0);
      await frame.evaluate(() => {
        for (let i = 0; i < 8; i++) ask("budget-" + i);
      });
      await page.waitForFunction(() => micState.requests.length === 8);
      await frame.evaluate(() => ask("budget-overflow"));
      await frame.waitForFunction(() =>
        messages["budget-overflow"].some((message) => message.type === "error"),
      );
      assert.equal(
        await frame.evaluate(
          () =>
            messages["budget-overflow"].find(
              (message) => message.type === "error",
            ).code,
        ),
        "QuotaExceededError",
      );
      await frame.evaluate(() => {
        for (let i = 0; i < 8; i++) closeInput("budget-" + i);
      });
      await page.waitForFunction(() => micState.requests.length === 0);
      await frame.evaluate(() => ask("denied"));
      await page.getByRole("button", { name: "拒绝本预览" }).click();
      await frame.waitForFunction(() =>
        messages.denied.some((message) => message.type === "error"),
      );
      assert.equal(
        await frame.evaluate(
          () =>
            messages.denied.find((message) => message.type === "error").code,
        ),
        "NotAllowedError",
      );
      await frame.evaluate(() => ask("still-denied"));
      await frame.waitForFunction(() =>
        messages["still-denied"].some((message) => message.type === "error"),
      );
      assert.equal(
        await page.evaluate(() => micState.requests.length),
        0,
        "denial must not prompt repeatedly",
      );
      await page.getByRole("button", { name: "允许重新申请麦克风" }).click();
      await frame.evaluate(() => ask("cancelled"));
      await page.getByRole("button", { name: "允许此作品本次预览" }).waitFor();
      await frame.evaluate(() => closeInput("cancelled"));
      await page.waitForFunction(() => micState.requests.length === 0);
      assert.equal(await page.evaluate(() => stats.gum), 0);
      await frame.evaluate(() =>
        ask("enumerate", {
          op: "enumerate",
          sampleRate: undefined,
          channels: undefined,
        }),
      );
      await page.getByRole("button", { name: "允许此作品本次预览" }).click();
      await frame.waitForFunction(() =>
        messages.enumerate.some((message) => message.type === "devices"),
      );
      assert.deepEqual(
        await frame.evaluate(() =>
          messages.enumerate
            .find((message) => message.type === "devices")
            .devices.map((device) => device.kind),
        ),
        ["audioinput", "audioinput"],
      );
      assert.equal(
        await page.evaluate(() => stats.gum),
        0,
        "device listing never captures",
      );
      await frame.evaluate(() => ask("synthetic"));
      await page.getByRole("button", { name: "允许此作品本次预览" }).waitFor();
      await page
        .getByRole("button", { name: "允许此作品本次预览" })
        .evaluate((button) => button.click());
      await frame.waitForFunction(() =>
        messages.synthetic.some((message) => message.type === "error"),
      );
      assert.equal(
        await page.evaluate(() => stats.gum),
        0,
        "synthetic activation cannot grant input",
      );
      await frame.evaluate(() => ask("first"));
      await page.getByRole("button", { name: "允许此作品本次预览" }).click();
      await frame.waitForFunction(() =>
        messages.first.some((message) => message.type === "ready"),
      );
      assert.equal(await page.evaluate(() => stats.gum), 1);
      assert.equal(await page.evaluate(() => stats.constraints.video), false);
      await frame.evaluate(() => ask("second"));
      await frame.waitForFunction(() =>
        messages.second.some((message) => message.type === "ready"),
      );
      assert.equal(
        await page.evaluate(() => stats.gum),
        1,
        "same preview voices share input and grant",
      );
      await frame.evaluate(() =>
        ask("resampled", { sampleRate: 44100, channels: 1 }),
      );
      await page.getByRole("button", { name: "允许此作品本次预览" }).click();
      await frame.waitForFunction(() =>
        messages.resampled.some((message) => message.type === "ready"),
      );
      assert.equal(
        await page.evaluate(() => stats.gum),
        1,
        "different requested rates share native capture",
      );
      assert.equal(
        await frame.evaluate(
          () =>
            messages.resampled.find((message) => message.type === "ready")
              .sampleRate,
        ),
        44100,
      );
      await page.evaluate(() => {
        window.holdCapture = true;
        feed(40);
      });
      assert.equal(
        await page.evaluate(() => stats.captured),
        4,
        "capture producer has four credits",
      );
      await page.evaluate(() => {
        holdCapture = false;
        stats.held.splice(0).forEach((deliver) => deliver());
      });
      await frame.waitForFunction(
        () =>
          messages.first.filter((message) => message.type === "pcm").length ===
          4,
      );
      await page.evaluate(() => feed(40));
      await page.waitForTimeout(100);
      assert.equal(
        await frame.evaluate(
          () =>
            messages.first.filter((message) => message.type === "pcm").length,
        ),
        4,
        "unacknowledged subscriber remains bounded",
      );
      const rates = await frame.evaluate(() => ({
        original: messages.first
          .filter((message) => message.type === "pcm")
          .reduce((sum, message) => sum + message.frames, 0),
        resampled: messages.resampled
          .filter((message) => message.type === "pcm")
          .reduce((sum, message) => sum + message.frames, 0),
        finite: messages.resampled
          .filter((message) => message.type === "pcm")
          .every((message) =>
            new Float32Array(message.buffers[0]).every(Number.isFinite),
          ),
      }));
      assert(
        Math.abs(rates.resampled - (rates.original * 44100) / 48000) < 2,
        "resampled PCM must follow requested rate continuously",
      );
      assert(rates.finite);
      assert.equal(
        await page.evaluate(() => stats.speakerPeak),
        0,
        "capture worklet must never feed speakers",
      );
      assert(
        await frame.evaluate(() =>
          messages.first
            .filter((message) => message.type === "pcm")
            .every(
              (message) =>
                message.frames <= 2048 &&
                message.buffers.length === 2 &&
                message.buffers.every(
                  (buffer) => buffer.byteLength === message.frames * 4,
                ),
            ),
        ),
      );
      await frame.evaluate(() =>
        ports.first.postMessage({ type: "ack", sequence: 0 }),
      );
      await page.waitForTimeout(50);
      await page.evaluate(() => feed(1));
      await frame.waitForFunction(
        () =>
          messages.first.filter((message) => message.type === "pcm").length ===
          5,
      );
      await frame.evaluate(() => closeInput("first"));
      assert.equal(await page.evaluate(() => stats.stopped), 0);
      await frame.evaluate(() => closeInput("resampled"));
      await frame.evaluate(() => closeInput("second"));
      await page.waitForFunction(
        () => stats.stopped === 1 && stats.closed === 1,
      );
      await frame.evaluate(() => ask("reuse"));
      await frame.waitForFunction(() =>
        messages.reuse.some((message) => message.type === "ready"),
      );
      assert.equal(
        await page.evaluate(() => micState.requests.length),
        0,
        "same setting keeps per-preview authorization after last voice release",
      );
      assert.equal(await page.evaluate(() => stats.gum), 2);
      await frame.evaluate(
        () =>
          (window.pingTimer = setInterval(
            () => ports.reuse.postMessage({ type: "ping" }),
            500,
          )),
      );
      await page.evaluate(() => feed(20));
      await frame.waitForFunction(
        () =>
          messages.reuse.filter((message) => message.type === "pcm").length ===
          4,
      );
      await page.waitForTimeout(5500);
      assert.equal(
        await page.evaluate(() => micState.active.length),
        1,
        "alive suspended consumers keep permission",
      );
      assert.equal(
        await frame.evaluate(
          () =>
            messages.reuse.filter((message) => message.type === "pcm").length,
        ),
        4,
        "heartbeat does not return PCM credits",
      );
      await frame.evaluate(() => clearInterval(pingTimer));
      await page.waitForFunction(
        () =>
          stats.stopped === 2 &&
          stats.closed === 2 &&
          micState.active.length === 0,
      );
      await frame.waitForFunction(() =>
        messages.reuse.some(
          (message) =>
            message.type === "error" && message.code === "AbortError",
        ),
      );
      await page.getByRole("button", { name: "停止麦克风并撤销授权" }).click();
      await page.waitForFunction(
        () => stats.stopped === 2 && stats.closed === 2,
      );
      await frame.evaluate(() => ask("after-stop"));
      await frame.waitForFunction(() =>
        messages["after-stop"].some((message) => message.type === "error"),
      );
      assert.equal(await page.evaluate(() => micState.requests.length), 0);
      assert.equal(await page.evaluate(() => stats.gum), 2);
      await page.getByRole("button", { name: "允许重新申请麦克风" }).click();
      await page.evaluate(() => {
        window.holdNative = true;
      });
      await frame.evaluate(() => ask("late"));
      await page.getByRole("button", { name: "允许此作品本次预览" }).click();
      await page.waitForFunction(() => stats.gum === 3);
      await frame.evaluate(() => closeInput("late"));
      await page.waitForFunction(
        () => stats.closed === 3 && micState.requests.length === 0,
      );
      await page.evaluate(() => finishNative());
      await page.waitForFunction(() => stats.stopped === 3);
      await page.evaluate(() => {
        window.holdNative = false;
      });
      await frame.evaluate(() => ask("last"));
      await frame.waitForFunction(() =>
        messages.last.some((message) => message.type === "ready"),
      );
      await page.evaluate(
        () =>
          (document.getElementById("target").src =
            "/preview-live/mic-fixture/replaced.html"),
      );
      await page.waitForFunction(
        () =>
          stats.stopped === 4 &&
          stats.closed === 4 &&
          micState.active.length === 0 &&
          !micState.granted,
      );
      await page.evaluate(() => broker.dispose());
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
