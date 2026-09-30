import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { fixture } from "./helpers.mjs";
import { servePreview } from "../../scripts/preview-audio.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test("preview HTTP streams bounded byte ranges, HEAD and suffixes without exposing outside files", async () => {
  const f = fixture(), directory = path.join(f.root, "http");
  fs.mkdirSync(directory);
  const bytes = Buffer.from("0123456789abcdef");
  fs.writeFileSync(path.join(directory, "sample.wav"), bytes);
  fs.writeFileSync(path.join(directory, "empty.wav"), "");
  let outside = "/outside.txt";
  if (process.platform === "win32") {
    // A junction exercises the same realpath escape without requiring an elevated
    // token or Windows Developer Mode just to run the desktop test suite.
    fs.mkdirSync(path.join(f.root, "private"));
    fs.writeFileSync(path.join(f.root, "private", "file.txt"), "outside");
    fs.symlinkSync(path.join(f.root, "private"), path.join(directory, "outside"), "junction");
    outside = "/outside/file.txt";
  } else {
    fs.writeFileSync(path.join(f.root, "private.txt"), "outside");
    fs.symlinkSync(path.join(f.root, "private.txt"), path.join(directory, "outside.txt"));
  }
  const server = await servePreview(directory);
  try {
    for (const [range, start, end] of [["bytes=0-3",0,3],["bytes=8-",8,15],["bytes=-4",12,15],["bytes=14-100",14,15]]) {
      const response = await fetch(server.url+"/sample.wav", {headers:{Range:range}});
      assert.equal(response.status,206);
      assert.equal(response.headers.get("accept-ranges"),"bytes");
      assert.equal(response.headers.get("content-range"),`bytes ${start}-${end}/16`);
      assert.equal(response.headers.get("content-length"),String(end-start+1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
    }
    for (const range of ["bytes=16-","bytes=4-2","bytes=-0","bytes=-","bytes=0-1,4-5","bytes=999999999999999999-"]) {
      const response=await fetch(server.url+"/sample.wav",{headers:{Range:range}});
      assert.equal(response.status,416);
      assert.equal(response.headers.get("content-range"),"bytes */16");
      assert.equal((await response.arrayBuffer()).byteLength,0);
    }
    const head=await fetch(server.url+"/sample.wav",{method:"HEAD"});
    assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),"16");assert.equal(await head.text(),"");
    const empty=await fetch(server.url+"/empty.wav");assert.equal(empty.status,200);assert.equal(await empty.text(),"");
    assert.equal((await fetch(server.url+outside)).status,404);
    const method=await fetch(server.url+"/sample.wav",{method:"POST"});
    assert.equal(method.status,405);assert.equal(method.headers.get("allow"),"GET, HEAD");
  } finally { await server.close(); f.close(); }
});

test("built preview decodes a large WAV at the end then seeks backwards within a bounded source cache", {timeout:60000}, async () => {
  const f=fixture({browser:true});
  let server,browser;
  try {
    fs.writeFileSync(path.join(f.root,"range-test.html"),'<script type="module" src="/range-test.ts"></script>');
    fs.writeFileSync(path.join(f.root,"range-test.ts"),`
import {AudioSourcePool} from "./src/engine/audio-source-pool";
window.probe=async()=>{
 const pool=new AudioSourcePool(4*1024*1024),levels=[];
 try {
  for(const index of [74,0,40,2]){
   const buffer=await pool.chunk("films/test-film/long.wav",index);
   const samples=buffer.getChannelData(0);
   levels.push(Math.sqrt(samples.reduce((n,x)=>n+x*x,0)/samples.length));
  }
  return {levels,diagnostics:pool.diagnostics()};
 } finally {pool.dispose();}
};
`);
    await build({root:f.root,configFile:false,logLevel:"silent",base:"./",build:{outDir:"range-dist",rollupOptions:{input:path.join(f.root,"range-test.html")}}});
    const output=path.join(f.root,"range-dist"), audio=path.join(output,"films/test-film");
    fs.mkdirSync(audio,{recursive:true});
    const frames=48000*40,wav=Buffer.alloc(44+frames*2);
    wav.write("RIFF");wav.writeUInt32LE(wav.length-8,4);wav.write("WAVEfmt ",8);
    wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
    wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
    wav.write("data",36);wav.writeUInt32LE(wav.length-44,40);
    for(let i=0;i<frames;i++)wav.writeInt16LE(Math.round(Math.sin(i*Math.PI*880/48000)*12000),44+i*2);
    fs.writeFileSync(path.join(audio,"long.wav"),wav);
    assert(wav.length>2*1024*1024);
    server=await servePreview(output);browser=await launchBrowser();
    const page=await browser.newPage(),ranges=[];
    page.on("response",response=>{if(response.url().endsWith("/long.wav"))ranges.push(response.status());});
    await page.goto(server.url+"/range-test.html");
    await page.waitForFunction(()=>window.probe);
    const result=await page.evaluate(()=>window.probe());
    assert(result.levels.every(level=>level>.2&&level<.3),JSON.stringify(result));
    assert(ranges.length>1&&ranges.every(status=>status===206),JSON.stringify(ranges));
    assert(result.diagnostics.peakBytes<=4*1024*1024);
  } finally {await browser?.close();await server?.close();f.close();}
});
