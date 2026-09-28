import {test,expect} from '@playwright/test';
import '../../../../src/engine/debug';
import {STARTS,DURATION} from '../../r3/timeline';

test('R3 all nine rigs reconstruct from arbitrary reverse seeks',async({page})=>{
 test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 const samples=[1.1,20.1,40.1,63.2,79.8,94.1,104.1,134.2,145.5];
 const frames=await page.evaluate(times=>{const api=window.__FRAME_STUDIO__!;return times.map(t=>{api.frame(t,false);const first=api.dataURL();api.frame(t+.19,false);const motion=api.dataURL();api.frame(t<80?149.3:5.9,false);api.frame(t,false);return{t,bytes:first.length,repeat:api.dataURL()===first,motion:motion!==first};});},samples);
 for(const f of frames){expect(f.bytes).toBeGreaterThan(1000);expect(f.repeat,`reconstruction at ${f.t}`).toBe(true);expect(f.motion,`motion at ${f.t}`).toBe(true);}expect(errors).toEqual([]);
});
test('every R3 edit and its preceding frame renders including the endpoint',async({page})=>{
 test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 const times=[...STARTS.flatMap(t=>[Math.max(0,t-1/30),t]),DURATION-1/30,DURATION];const result=await page.evaluate(values=>{const api=window.__FRAME_STUDIO__!;return values.every(t=>{api.frame(t,true);return api.dataURL().length>1000;});},times);expect(result).toBe(true);expect(errors).toEqual([]);
});
