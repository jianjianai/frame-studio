import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve('projects/the-learning-machine'),cache=path.join(root,'.cache/r3'),out=path.join(root,'public/audio-r3');
fs.mkdirSync(cache,{recursive:true});fs.mkdirSync(out,{recursive:true});
const music=path.join(root,'public/imports/sb_emergent-e0e83f4b-50cc-4f36-ac59-4091805fee82.mp3');
const voice=path.join(root,'public/narration/ef596b8c2fd101f580a10f940c33388e86bac56c8ba366caf322d58a77093f9f/voice.wav');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if(sha(music)!=='653e6a1e22ae7a122d7d2db87ddb3183f7bd30fe9a9ff709e93647a8f71c48e5')throw new Error('Music source changed');
function ff(args){const p=spawnSync('ffmpeg',['-hide_banner','-nostdin','-v','error',...args],{encoding:'utf8',maxBuffer:2**22});if(p.error||p.status!==0)throw new Error(p.stderr||String(p.error));}
ff(['-i',music,'-ac','2','-ar','48000','-f','f32le','-y',path.join(cache,'music-stereo.f32')]);
ff(['-i',voice,'-af','highpass=f=70,acompressor=threshold=0.14:ratio=2.3:attack=8:release=95:makeup=1.12,loudnorm=I=-17:TP=-3.5:LRA=8,apad=whole_dur=156,atrim=duration=156','-ac','2','-ar','48000','-c:a','pcm_s16le','-y',path.join(out,'voice.wav')]);
const code=String.raw`
from pathlib import Path
import numpy as np, json, hashlib
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
root=Path('projects/the-learning-machine').resolve(); out=root/'public/audio-r3'; sr=48000; D=156
# The normalizer/resampler may end 88 ms early. Preserve all existing PCM samples;
# append only exact silence rather than relaxing the duration assertion.
vr,voice_pcm=wavfile.read(out/'voice.wav')
assert vr==sr and voice_pcm.ndim==2 and voice_pcm.shape[1]==2
before_voice_frames=len(voice_pcm)
assert before_voice_frames<=D*sr
voice_pcm=np.pad(voice_pcm,((0,D*sr-before_voice_frames),(0,0)),mode='constant')
wavfile.write(out/'voice.wav',sr,voice_pcm)
raw=np.fromfile(root/'.cache/r3/music-stereo.f32',dtype='<f4').reshape(-1,2).astype(np.float64)
# Two phrase-length omissions. Forty-hundredths overlaps preserve attacks/tails.
parts=[(24.4,60.8),(84.4,132.8),(144.4,216.4)]
a=[raw[round(s*sr):round(e*sr)].copy() for s,e in parts]
over=round(.4*sr)
x=a[0]
for b in a[1:]:
 p=np.linspace(0,1,over,endpoint=False)[:,None]
 # Equal gain crossfade: related score phrases must not gain 3 dB at the join.
 bridge=x[-over:]*(1-p)+b[:over]*p
 x=np.concatenate((x[:-over],bridge,b[over:]),axis=0)
assert len(x)==D*sr
seconds=np.arange(len(x))/sr
cue=json.loads((root/'exports/mcp/dc03e735-7f15-42ea-a749-9b41f20a08d7/result.json').read_text(encoding='utf8'))['sentences']
base=np.interp(seconds,[0,10.98,29.11,36,52.97,71.91,83.12,84.4,102.82,125.72,131.85,132.29,138.28,143.67,149,154,156],[.60,.43,.52,.48,.42,.30,.52,.38,.30,.39,.35,.13,.23,.58,.70,.83,0])
duck=np.ones(len(x))
for c in cue:
 s,e=c['start'],c['end']; idx=(seconds>=s-.08)&(seconds<=e+.24)
 duck[idx]=np.minimum(duck[idx],np.interp(seconds[idx],[s-.08,s,e,e+.24],[1,.69,.69,1]))
# A brief suspension at the claim/fact reversal is an edit, not another noisy riser.
space=np.interp(seconds,[0,132.06,132.27,132.49,132.73,156],[1,1,.09,.09,1,1])
fade=np.minimum(1,seconds/.12)*np.clip((156-seconds)/1.2,0,1)
x*= (base*duck*space*fade)[:,None]
x=sosfilt(butter(2,55,fs=sr,btype='highpass',output='sos'),x,axis=0)
assert np.max(np.abs(x))<.96
wavfile.write(out/'score.wav',sr,(np.clip(x,-1,1)*32767).astype('<i2'))
# Restrained object contacts only. No old R2 melody, metronome, or per-particle beeps.
y=np.zeros((D*sr,2),dtype=np.float64);rng=np.random.default_rng(314159)
indices=[3,6,7,9,12,14,16,18,20,22,24,26,27,28,29,30]
for k,idx in enumerate(indices):
 at=cue[idx]['start'];length=.20 if idx not in [7,18,27] else .46
 n=int(length*sr);u=np.arange(n)/sr
 noise=rng.normal(0,1,n)
 filtered=sosfilt(butter(2,1700 if length<.3 else 460,fs=sr,output='sos'),noise)
 v=filtered*np.exp(-u*(24 if length<.3 else 12))*(1-np.exp(-u*1200))
 if idx in [7,18,27]:v+=np.sin(2*np.pi*(63*u+.48*(1-np.exp(-u*35))))*np.exp(-u*18)*.18
 gain=.09 if length<.3 else .15
 start=round(at*sr);pan=(k%3-1)*.2
 y[start:start+n,0]+=v*gain*np.sqrt((1-pan)/2);y[start:start+n,1]+=v*gain*np.sqrt((1+pan)/2)
wavfile.write(out/'foley.wav',sr,(np.clip(y,-1,1)*32767).astype('<i2'))
report={'source':'Emergent / Scott Buckley / CC BY 4.0','sourceRanges':parts,'crossfadeSeconds':.4,'duration':D,'mixing':'section automation, narration ducking, short pause on claim/fact reversal, HP55Hz; no tempo alteration','musicPeak':float(np.max(np.abs(x))),'foleyPeak':float(np.max(np.abs(y))),'voiceSilencePaddingFrames':D*sr-before_voice_frames,'mixSamplePeak':float(np.max(np.abs(voice_pcm.astype(np.float64)/32768+x+y))),'outputs':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in out.glob('*.wav')},'listening':'not_run'}
(root/'records/r3-audio-edit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
`;
const r=spawnSync('python',['-'],{input:code,encoding:'utf8',maxBuffer:2**22});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error)throw r.error;process.exitCode=r.status??1;
