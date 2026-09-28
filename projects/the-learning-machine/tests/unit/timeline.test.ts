import {describe,it,expect} from 'vitest';
import {CUES,STARTS,SCENES,DURATION,cueAt,sceneAt} from '../../r3/timeline';
import {shot,hash,ramp} from '../../r3/math';
import project from '../../project';
import fs from 'node:fs';
import path from 'node:path';

describe('R3 narration-driven edit',()=>{
 it('has 32 measured narration groups and a 156-second complete timeline',()=>{expect(DURATION).toBe(156);expect(project.duration).toBe(DURATION);expect(CUES).toHaveLength(32);expect(project.subtitles).toHaveLength(32);expect(STARTS[0]).toBe(0);expect(SCENES).toHaveLength(9);expect(sceneAt(0)).toBe(0);expect(sceneAt(31)).toBe(8);for(let i=0;i<32;i++){const c=CUES[i]!,s=project.subtitles[i]!;expect(s.start).toBeCloseTo(c[0],6);expect(s.end).toBeCloseTo(c[1],6);expect(s.end).toBeGreaterThan(s.start);expect(s.end).toBeLessThanOrEqual(DURATION);if(i)expect(s.start).toBeGreaterThanOrEqual(project.subtitles[i-1]!.end);}});
 it('selects a unique cue at every exact edit and handles the full endpoint',()=>{STARTS.forEach((s,i)=>expect(cueAt(s).i).toBe(i));expect(cueAt(-1).i).toBe(0);expect(cueAt(156).i).toBe(31);expect(cueAt(500).u).toBe(1);for(let t=0;t<=156;t+=.21){const q=cueAt(t);expect(q.u).toBeGreaterThanOrEqual(0);expect(q.u).toBeLessThanOrEqual(1);expect(sceneAt(q.i)).toBeGreaterThanOrEqual(0);}});
 it('arrives quickly and never depends on the order of previous camera calls',()=>{const a=shot([0,0,10],[10,2,8],[0,0,0],.16,40);expect(a.eye[0]).toBeCloseTo(9.6,6);shot([4,8,19],[0,0,1],[0,0,0],.8);expect(shot([0,0,10],[10,2,8],[0,0,0],.16,40)).toEqual(a);expect(ramp(.5,0,.5)).toBe(1);expect(hash(187)).toBe(hash(187));});
 it('uses licensed recorded music rather than invoking the rejected R2 score',()=>{expect(project.audioTracks?.map(t=>t.id)).toEqual(['voice','music','foley']);expect(project.audioTracks?.every(t=>t.kind==='file')).toBe(true);expect(project.loadAudio).toBeUndefined();expect(project.credits.join(' ')).toContain('Scott Buckley');expect(project.credits.join(' ')).toContain('CC-BY 4.0');});
 it('has three finite stereo 48kHz PCM files with identical duration',()=>{for(const name of ['voice','score','foley']){const bytes=fs.readFileSync(path.resolve(`projects/the-learning-machine/public/audio-r3/${name}.wav`));expect(bytes.toString('ascii',0,4)).toBe('RIFF');let p=12,rate=0,align=0,data=0,channels=0;while(p+8<=bytes.length){const key=bytes.toString('ascii',p,p+4),n=bytes.readUInt32LE(p+4);if(key==='fmt '){channels=bytes.readUInt16LE(p+10);rate=bytes.readUInt32LE(p+12);align=bytes.readUInt16LE(p+20);}if(key==='data'){data=n;break;}p+=8+n+(n%2);}expect(channels).toBe(2);expect(rate).toBe(48000);expect(data/align/rate).toBe(156);}});
});
