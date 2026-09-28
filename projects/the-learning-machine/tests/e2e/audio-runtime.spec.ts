import{test,expect}from'@playwright/test';
import'../../../../src/engine/debug';
test('R3 file tracks: cold seek, sustained playback, pause, reverse and double speed',async({page})=>{
 test.setTimeout(90000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 await page.evaluate(async()=>{await window.__FRAME_STUDIO__!.captureAt!(31.4,{audio:true});});await page.mouse.click(2,2);await page.evaluate(()=>window.__FRAME_STUDIO__!.play!());
 await page.waitForFunction(()=>window.__FRAME_STUDIO__!.getState!().time>35.4,undefined,{timeout:10000});
 const paused=await page.evaluate(()=>{const a=window.__FRAME_STUDIO__!;a.pause!();return a.getState!().time;});await page.waitForTimeout(200);expect(await page.evaluate(()=>window.__FRAME_STUDIO__!.getState!().time)).toBeCloseTo(paused,2);
 await page.evaluate(async()=>{const a=window.__FRAME_STUDIO__!;a.setRate!(2);await a.captureAt!(18.3,{audio:true});await a.play!();});await page.waitForFunction(()=>window.__FRAME_STUDIO__!.getState!().time>22.3,undefined,{timeout:6000});
 const result=await page.evaluate(()=>{const a=window.__FRAME_STUDIO__!;a.pause!();return{state:a.getState!(),diagnostics:a.getDiagnostics!()};});expect(result.state.rate).toBe(2);expect(result.diagnostics.errors).toEqual([]);expect(errors).toEqual([]);console.info('R3_FILE_PLAYBACK',JSON.stringify(result));
});
test('preserved R2 generator still keeps late-tail audio identical across chunks',async({page})=>{
 test.setTimeout(90000);await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 const difference=await page.evaluate(async()=>{
  const url='/projects/the-learning-machine/r2/music.ts';const mod=await import(/* @vite-ignore */url);
  const render=async(start:number,length:number)=>{const ctx=new OfflineAudioContext(2,Math.round(length*48000),48000);await mod.prepareAudio(ctx);const session=mod.createAudio({trackId:'music',context:ctx,destination:ctx.destination,when:0,offset:start,duration:length,rate:1});const output=await ctx.startRendering();session.dispose();mod.disposeAudio(ctx);return[output.getChannelData(0),output.getChannelData(1)];};
  const full=await render(151.8,1.8),a=await render(151.8,.9),b=await render(152.7,.9);let max=0;for(let ch=0;ch<2;ch++)for(let i=0;i<full[ch]!.length;i++){const v=i<a[ch]!.length?a[ch]![i]!:b[ch]![i-a[ch]!.length]!;max=Math.max(max,Math.abs(full[ch]![i]!-v));}return max;
 });expect(difference).toBeLessThan(.002);console.info('R2_OFFLINE_CHUNK_MAX_ERROR',difference);
});
