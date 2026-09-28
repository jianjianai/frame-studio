import {spawnSync} from 'node:child_process';
const code=String.raw`
from pathlib import Path
import json
import numpy as np
from scipy.signal import stft, find_peaks, correlate
root=Path('projects/the-learning-machine').resolve()
sr=22050
signal=np.fromfile(root/'.cache/r3/song.f32',dtype='<f4').astype(np.float64)
_,times,z=stft(signal,fs=sr,nperseg=1024,noverlap=768,boundary=None)
mag=np.abs(z)
flux=np.maximum(np.diff(np.log1p(mag*80),axis=1),0).sum(axis=0)
flux=(flux-np.median(flux))/(np.std(flux)+1e-12)
flux=np.maximum(0,flux)
dt=256/sr
corr=correlate(flux,flux,mode='full',method='fft')[len(flux)-1:]
lo,hi=int(60/165/dt),int(60/80/dt)
peaks,_=find_peaks(corr[lo:hi],distance=4)
best=sorted((int(k+lo) for k in peaks),key=lambda k:corr[k],reverse=True)[:8]
tempo=[{'bpm':round(60/(k*dt),3),'score':round(float(corr[k]/corr[0]),3)} for k in best]
onsets,_=find_peaks(flux,height=1.4,distance=int(.22/dt))
blocks=[]
for a in range(0,int(len(signal)/sr),8):
 s=signal[a*sr:min((a+8)*sr,len(signal))]
 blocks.append({'start':a,'rmsDb':round(float(20*np.log10(np.sqrt(np.mean(s*s))+1e-10)),1),'peak':round(float(np.max(np.abs(s))),3)})
result={'source':'Emergent / Scott Buckley','duration':len(signal)/sr,'tempoCandidates':tempo,'eightSecondEnergy':blocks,'strongOnsets':[round(float(times[1:][p]),3) for p in onsets if flux[p]>2.8],'method':'Spectral-flux timing/level analysis; not a subjective listening verdict.'}
(root/'records/r3-music-analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
`;
const r=spawnSync('python',['-'],{input:code,encoding:'utf8',maxBuffer:4*1024*1024});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error)throw r.error;process.exitCode=r.status??1;
