import{test,expect}from'@playwright/test';
import'../../../../src/engine/debug';
test('R2 all nine acts and action moments reconstruct from arbitrary seeks',async({page})=>{
 test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 // Sample the authored next-token arrival at 104.26s, not its intentional preceding hold.
 const frames=await page.evaluate(()=>{const api=window.__FRAME_STUDIO__!;return [.94,18.6,31.8,50.95,70.83,90.53,104.28,130.3,148.15].map(t=>{api.frame(t,false);const a=api.dataURL();api.frame(t+.15,false);const b=api.dataURL();api.frame(t<80?146:4,false);api.frame(t,false);return{t,bytes:a.length,changes:b!==a,repeat:api.dataURL()===a};});});
 for(const f of frames){expect(f.bytes).toBeGreaterThan(1000);expect(f.changes,`action at ${f.t}`).toBe(true);expect(f.repeat,`cold seek at ${f.t}`).toBe(true);}expect(errors).toEqual([]);
});
test('every R2 cut and exact ending renders',async({page})=>{
 test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?debug=1#/film/the-learning-machine');await page.waitForFunction(()=>window.__FRAME_STUDIO__?.ready);
 const result=await page.evaluate(()=>{const api=window.__FRAME_STUDIO__!;const cuts=[0,3.1,6.2,9.6,13.3,18.3,22.5,27.1,31.4,35.5,40,43.5,48,51.7,55.5,60,64.1,67.2,72.5,77,82,86.2,90.4,95,99,103.2,107.4,112,117,121,126,129,133,138,143,148,153.6];return cuts.every(t=>{api.frame(t,true);return api.dataURL().length>1000;});});expect(result).toBe(true);expect(errors).toEqual([]);
});
