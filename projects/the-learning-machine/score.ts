import { voiceWindows,smooth,hash } from './timeline';
type Kind='piano'|'bell'|'pad'|'bass'|'drum'|'tick'|'air';
type Note={at:number;dur:number;key:number;amp:number;pan:number;kind:Kind};
export const score:Note[]=[];
const hz=(key:number)=>440*2**((key-69)/12);
function note(at:number,dur:number,key:number,amp:number,pan:number,kind:Kind){score.push({at,dur,key,amp,pan,kind});}
// A six-note original motif. Each act re-orchestrates it rather than looping one bed.
const motif=[62,69,74,77,76,69,65,72,74,69,65,64,62,69,77,81];
const chords=[[50,57,62,65],[46,53,57,62],[53,60,65,69],[48,55,60,62]];
const sections=[{a:0,b:26,bpm:72,power:.55},{a:26,b:76,bpm:96,power:.46},{a:76,b:114,bpm:108,power:.66},{a:114,b:144,bpm:108,power:.76},{a:144,b:170,bpm:90,power:.61},{a:170,b:206,bpm:112,power:.86},{a:206,b:239,bpm:112,power:1},{a:239,b:264,bpm:72,power:.56}];
sections.forEach((s,si)=>{const beat=60/s.bpm,bar=beat*4;for(let b=0;s.a+b*bar<s.b-.7;b++){const at=s.a+b*bar,ch=chords[(b+si)%4]!,remaining=s.b-at;ch.forEach((k,j)=>note(at,Math.min(bar*1.45+1.1,remaining+2),k+(j<2?12:0),.034*s.power,(j-1.5)*.4,'pad'));note(at,Math.min(bar,remaining),ch[0]!-12,.072*s.power,0,'bass');for(let j=0;j<4;j++){const nt=at+j*beat;if(nt>s.b-1)continue;const key=motif[(b*4+j+si*2)%motif.length]!;note(nt,Math.min(3.8,s.b-nt+1),si===7&&key===77?78:key,.061*s.power*(j===0?1:.8),Math.sin((b*4+j)*1.2)*.38,'piano');if(si>=3&&si<7&&j%2===1)note(nt+beat*.5,1.5,ch[(j+b)%4]!+24,.022*s.power,Math.sin(j+b)*.55,'bell');if(si>0&&si<7){note(nt,.27,34,.041*s.power,0,'drum');if(j===1||j===3)note(nt+beat*.5,.13,75,.012*s.power,.4,'tick');}if(si>=5&&si<7){note(nt+beat*.5,1.6,ch[(j+b)%4]!+12,.032*s.power,-.36,'piano');}}if(b%2===0)note(at+.045,6,ch[2]!+24,.023*s.power,.42,'bell');}});
// Cadence is deliberately written: no unresolved loop at the end.
note(254,6,62,.069,-.3,'piano');note(255.67,5.4,69,.054,.18,'piano');note(257.34,5,74,.057,-.18,'piano');note(259,4.8,78,.044,.22,'bell');[50,57,62,66,69].forEach((k,i)=>note(259.7,4.3,k,.021,(i-2)*.25,'pad'));note(261.25,2.75,86,.016,.32,'bell');
export const foley:Note[]=[];
const fx=(at:number,dur:number,key:number,amp:number,pan:number,kind:Kind)=>foley.push({at,dur,key,amp,pan,kind});
[0,7.5,15.5,26,40,48,62,76,88.5,102,114,130,144,151.5,170,185,199,206,220,233.5,239,246,254].forEach((t,i)=>{fx(t,.72,30+(i%3)*5,.07,0,'drum');fx(Math.max(0,t-.7),1.35,78,.035,Math.sin(i)*.3,'air');});
for(let t=27;t<47;t+=.62)fx(t,.055,75,.024,Math.sin(t)*.3,'tick');
for(let t=48;t<70;t+=1.12)fx(t,.1,65,.045,Math.sin(t)*.4,'tick');
for(let j=0;j<11;j++){fx(78+j*2.95,.48,69+(j%4)*3,.028,-.3+j%2*.6,'bell');}
for(let j=0;j<38;j++)fx(145+j*.24,.115,51,.056,Math.sin(j)*.3,'tick');fx(163.1,.24,39,.13,0,'drum');
[179,180.2,181.4,185,188,191,208.8,211,221,224,235,241].forEach((t,i)=>fx(t,.9,74+[0,5,7,12][i%4]!,.036,Math.sin(i)*.4,'bell'));
function partials(kind:Kind):[number,number,number][] {switch(kind){case'piano':return[[1,1,1],[2,.32,.55],[3.003,.15,.34],[4.012,.065,.22],[5.025,.03,.17]];case'bell':return[[1,.8,1],[2.756,.22,.46],[5.404,.09,.23]];case'pad':return[[1,.64,1],[1.0035,.22,1],[.998,.2,1],[2,.095,1],[3,.04,1]];case'bass':return[[1,.9,1],[2,.23,.8],[3,.05,.5]];default:return[[1,1,1]];}}
// Every requested segment is rebuilt from source time. Delays are explicit score events,
// so cold seeking, reverse seeking and offline chunks retain identical reverb tails.
export function renderPcm(trackId:string,startFrame:number,frames:number,sampleRate:number,signal?:AbortSignal):[Float32Array,Float32Array] {
 const left=new Float32Array(frames),right=new Float32Array(frames);const start=startFrame/sampleRate,end=(startFrame+frames)/sampleRate;const events=trackId==='foley'?foley:score;
 const delays=trackId==='foley'?[[0,1,0],[.09,.19,.45],[.21,.11,-.5]]:[[0,1,0],[.137,.2,.55],[.283,.13,-.6],[.451,.09,.4],[.719,.055,-.4]];
 for(const n of events){signal?.throwIfAborted();for(const [delay,level,panShift] of delays){const at=n.at+delay!,tail=n.dur;if(at>=end||at+tail<=start)continue;const from=Math.max(0,Math.ceil((at-start)*sampleRate)),to=Math.min(frames,Math.ceil((at+tail-start)*sampleRate));const pan=Math.max(-.92,Math.min(.92,n.pan+panShift!));const gl=Math.sqrt((1-pan)*.5)*n.amp*level!,gr=Math.sqrt((1+pan)*.5)*n.amp*level!;
  if(n.kind==='tick'||n.kind==='air'||n.kind==='drum') {for(let i=from;i<to;i++){const u=(startFrame+i)/sampleRate-at;const noise=hash((startFrame+i)+Math.floor(n.at*1000)*103)*2-1;let v=0;if(n.kind==='tick'){v=(noise*.57+Math.sin(2*Math.PI*hz(n.key)*u)*.43)*Math.exp(-u*43)*(1-Math.exp(-u*1600));}else if(n.kind==='air'){const p=u/tail;v=(noise*.43+Math.sin(u*2300)*.06)*Math.sin(Math.PI*p)**2;}else{v=(Math.sin(2*Math.PI*(hz(n.key)*u+4.8*(1-Math.exp(-u*24))))*.9+noise*.08)*Math.exp(-u*9)*(1-Math.exp(-u*700));}left[i]+=v*gl;right[i]+=v*gr;}continue;}
  // The envelopes are evaluated once per note, not once per oscillator partial.
  // Exponential envelopes advance by multiplication; initial state is analytic at
  // any source offset, so chunk boundaries and reverse seeks retain the waveform.
  const u0=(startFrame+from)/sampleRate-at, step=1/sampleRate;
  const envelope=new Float64Array(to-from), mono=new Float64Array(to-from);
  if(n.kind==='pad'){
    for(let j=0;j<envelope.length;j++){const u=u0+j*step;envelope[j]=smooth(u,0,.85)*(1-smooth(u,tail-1.4,tail))*.69;}
  }else{
    const attack=n.kind==='bass'?90:450, attackStep=Math.exp(-attack*step);let attackValue=Math.exp(-u0*attack);
    for(let j=0;j<envelope.length;j++){const u=u0+j*step;envelope[j]=(1-attackValue)*(1-smooth(u,tail-.15,tail));attackValue*=attackStep;}
  }
  for(const [ratio,amp,decay] of partials(n.kind)){
    const freq=hz(n.key)*ratio;if(freq>sampleRate*.43)continue;
    const w=2*Math.PI*freq*step,sw=Math.sin(w),cw=Math.cos(w);
    let s=Math.sin(2*Math.PI*freq*u0),c=Math.cos(2*Math.PI*freq*u0);
    const slope=n.kind==='pad'?0:(n.kind==='piano'?2.25:n.kind==='bell'?1.45:1.35)/decay;
    const decayStep=Math.exp(-slope*step);let decayValue=Math.exp(-u0*slope)*amp;
    for(let j=0;j<mono.length;j++){mono[j]+=s*envelope[j]!*decayValue;const next=s*cw+c*sw;c=c*cw-s*sw;s=next;decayValue*=decayStep;}
  }
  for(let j=0;j<mono.length;j++){left[from+j]+=mono[j]!*gl;right[from+j]+=mono[j]!*gr;}
 }}
 const activeVoice=voiceWindows.filter(([a,b])=>b+.7>start&&a-.28<end);
 for(let i=0;i<frames;i++){const t=(startFrame+i)/sampleRate;let spoken=0;for(const [a,b] of activeVoice)spoken=Math.max(spoken,smooth(t,a-.28,a)*(1-smooth(t,b,b+.7)));const d=1-.64*spoken;const duck=trackId==='foley'?(.6+.4*d):d;const f=smooth(t,0,1)*(1-smooth(t,261.5,264));left[i]=Math.tanh(left[i]!*1.3)*duck*f;right[i]=Math.tanh(right[i]!*1.3)*duck*f;}
 return[left,right];
}
