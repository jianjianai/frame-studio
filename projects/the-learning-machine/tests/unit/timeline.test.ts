import{describe,it,expect}from'vitest';
import{DURATION,cuts,acts,actAt,shotAt,camera,move,type CameraKey}from'../../r2/time';
import{voiceCues}from'../../r2/voice-cues';
import{demoWeights}from'../../r2/late';
import project from'../../project';
describe('R2 editorial timeline',()=>{
 it('covers 153.6 seconds with 36 ordered units and 9 connected acts',()=>{expect(project.duration).toBe(DURATION);expect(DURATION).toBe(153.6);expect(cuts.length).toBe(36);expect(acts.length).toBe(9);expect(acts[0].at).toBe(0);expect(acts[8].end).toBe(DURATION);for(let i=1;i<acts.length;i++)expect(acts[i]!.at).toBe(acts[i-1]!.end);for(let i=1;i<cuts.length;i++)expect(cuts[i]).toBeGreaterThan(cuts[i-1]!);});
 it('uses the right scene at edit points and at the endpoint',()=>{for(const a of acts)expect(actAt(a.at).key).toBe(a.key);expect(actAt(153.6).key).toBe('outro');expect(shotAt(148)).toBe(35);});
 it('arrives at the camera target in .4 seconds rather than drifting through a whole line',()=>{const keys:CameraKey[]=[{at:0,p:[0,0,10],look:[0,0,0],fov:38},{at:4,p:[1,2,7],look:[1,0,0],fov:40,duration:.4}];expect(camera(keys,4).p).toEqual([0,0,10]);expect(camera(keys,4.4).p).toEqual([1,2,7]);expect(camera(keys,6).p).toEqual([1,2,7]);expect(move(.4,0,.4)).toBe(1);});
 it('attaches the measured 36 narration lines without overlap or outside the film',()=>{expect(project.subtitles.length).toBe(36);for(let i=0;i<36;i++){const s=project.subtitles[i]!;expect(s.start).toBeCloseTo(voiceCues[i]![0],6);expect(s.end).toBeCloseTo(voiceCues[i]![1],6);expect(s.end).toBeLessThanOrEqual(DURATION);expect(s.end).toBeGreaterThan(s.start);if(i)expect(s.start).toBeGreaterThanOrEqual(project.subtitles[i-1]!.end);}expect(project.subtitles.reduce((n,s)=>n+s.end-s.start,0)/DURATION).toBeGreaterThan(.8);});
 it('computes normalized toy attention and gives the intended cat the largest weight',()=>{expect(demoWeights.reduce((a,b)=>a+b,0)).toBeCloseTo(1,12);expect(demoWeights.every(x=>x>0&&x<1)).toBe(true);expect(demoWeights[0]).toBe(Math.max(...demoWeights));});
 it('keeps narration, drums, music and effects independently controllable',()=>{expect(project.audioTracks?.map(t=>t.id)).toEqual(['voice','drums','music','fx']);expect(project.audioTracks?.[0]?.kind).toBe('file');});
});
