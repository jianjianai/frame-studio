import {cuts,hash,move,DURATION} from './time';
import {voiceCues} from './voice-cues';
import type {GeneratedAudioOptions} from '../../../src/engine/types';
// Original score: suspense motif, shifting drum patterns, a half-time decision scene,
// sparse verification and a specifically composed ending. No previous-version melody.
export type Instrument='kick'|'snare'|'hat'|'openhat'|'tom'|'click'|'bass'|'pluck'|'string'|'pad'|'riser'|'impact';
export type Note={at:number;key:number;velocity:number;pan:number;instrument:Instrument;track:'drums'|'music'|'fx'};
export const notes:Note[]=[];
const add=(track:Note['track'],instrument:Instrument,at:number,key:number,velocity:number,pan=0)=>{if(at>=0&&at<DURATION)notes.push({track,instrument,at,key,velocity,pan});};
const sections=[
 {a:0,b:9.6,bpm:142,v:.92,style:0},{a:9.6,b:27.1,bpm:124,v:.65,style:1},
 {a:27.1,b:48,bpm:138,v:.87,style:2},{a:48,b:64.1,bpm:146,v:.92,style:3},
 {a:64.1,b:77,bpm:144,v:.67,style:4},{a:77,b:99,bpm:140,v:.8,style:5},
 {a:99,b:126,bpm:148,v:.98,style:6},{a:126,b:138,bpm:108,v:.37,style:7},
 {a:138,b:153.6,bpm:118,v:.77,style:8}
];
const roots=[38,34,43,45],harmonies=[[62,65,69],[58,62,65],[55,58,62],[57,61,64]];
// A questioning minor second and rising fourth, used in different rhythms/inversions.
const motif=[74,75,69,74,81,77,75,69];
sections.forEach((s,si)=>{
 const beat=60/s.bpm,bar=4*beat;
 for(let b=0;s.a+b*bar<s.b-.2;b++){
  const at=s.a+b*bar,r=roots[(b+si)%4]!,chord=harmonies[(b+si)%4]!;
  let kick:number[],snare:number[],hat:number[];
  if(s.style===0){kick=[0,1.75,2.5];snare=[1,3];hat=[0,.5,1,1.5,2,2.5,3,3.5,3.75];}
  else if(s.style===1){kick=[0,2];snare=[1,3];hat=[0,.5,1.5,2,2.5,3.5];}
  else if(s.style===2||s.style===3){kick=b%2?[0,1.5,2.75]:[0,.75,2,3.5];snare=[1,3];hat=[0,.5,1,1.5,2,2.5,3,3.5];}
  else if(s.style===4){kick=[0];snare=[2];hat=[.5,1.5,2.5,3.5];}
  else if(s.style===5){kick=[0,1.75,2.5];snare=[1,3];hat=[.5,1,1.5,2.5,3,3.5];}
  else if(s.style===6){kick=[0,.75,1.5,2,2.75];snare=[1,3];hat=Array.from({length:b%2?12:8},(_,i)=>i/(b%2?3:2));}
  else if(s.style===7){kick=b%2?[]:[0];snare=[];hat=[1.5,3.5];}
  else{kick=[0,2.75];snare=[2];hat=[.5,1.5,2.5,3.5];}
  const window=(u:number)=>u<s.b-.18&&!([22.42,125.78,129,70.48].some(q=>u>q&&u<q+.57));
  for(const p of kick){const u=at+p*beat;if(window(u))add('drums','kick',u,36,s.v*.75);}
  for(const p of snare){const u=at+p*beat;if(window(u))add('drums','snare',u,38,s.v*(s.style===4?.41:.53),.02);}
  for(const [i,p]of hat.entries()){const u=at+p*beat;if(window(u))add('drums',b%2&&i===hat.length-1?'openhat':'hat',u,70,s.v*(i%2?.19:.26),i%2?.26:-.23);}
  if(b%4===3&&s.style!==7){for(let j=0;j<3;j++){const u=at+(3.25+j*.25)*beat;if(window(u))add('drums','tom',u,45-j*3,s.v*.24,j*.35-.35);}}
  if(s.style!==7){for(const p of s.style===4?[0,2]:[0,1.5,2.5]){const u=at+p*beat;if(window(u))add('music','bass',u,r,s.v*.43);}}
  if(s.style!==4&&s.style!==7){const pattern=s.style===1?[0,1.5,3]:s.style>=5?[0,.75,1.5,2.5,3.25]:[0,.5,1.75,2.5];pattern.forEach((p,i)=>{const u=at+p*beat;if(window(u)){const k=s.style===8?[74,69,66,62][(b+i)%4]!:motif[(b*3+i+si)%motif.length]!;add('music',s.style===2||s.style===3?'string':'pluck',u,k,s.v*(s.style===8?.35:.25),i%2?.35:-.35);}});}
  if((b%2===0||s.style===8)&&s.style!==1&&s.style!==4&&s.style!==7){chord.forEach((k,j)=>add('music','pad',at,k,s.v*.13,(j-1)*.52));}
  if(s.style===4||s.style===7){add('music','pluck',at+.25*beat,69+(b%2),.2,-.36);if(s.style===4)add('music','pluck',at+2.5*beat,77,.16,.38);}
 }
});
// Cut accents, action/contact foley, and motivated pauses are authored, not periodic noise.
for(const [i,t]of cuts.entries()){if(i===0||[3,7,12,16,19,24,30,33].includes(i)){add('fx','impact',t,36,.52);if(t>.4)add('fx','riser',t-.32,70,.37,(i%2?1:-1)*.23);}else add('fx','click',t,69,.22,(i%2?1:-1)*.18);}
[.87,1.23,6.3,18.42,19.08,20,22.85,31.55,32.7,33.65,36.8,40.85,43.5,46.1,48.45,50.9,51.07,51.24,51.41,60.1,64.2,67.35,68.35,69.55,70.99,77.06,77.18,77.3,77.42,86.2,90.45,95.5,103.52,104.26,114.16,118.15,123.8,130.3,133.6,138.2,138.36,138.52,148.3].forEach((t,i)=>{add('fx',t===70.99?'tom':'click',t,t===70.99?54:76,.32,i%2?.25:-.25);});
add('music','pluck',148,74,.46,-.25);add('music','pluck',148.51,69,.35,.25);add('music','pluck',149.02,66,.31,-.2);add('music','pluck',149.53,62,.42,.2);
[50,57,62,66].forEach((k,i)=>add('music','pad',149.53,k,.17,(i-1.5)*.3));add('fx','impact',149.53,38,.34);add('music','pluck',151.04,86,.17,.27);
notes.sort((a,b)=>a.at-b.at);

const duration:Record<Instrument,number>={kick:.48,snare:.28,hat:.09,openhat:.31,tom:.37,click:.10,bass:.68,pluck:1.55,string:.4,pad:4.6,riser:.36,impact:1.0};
const cache=new WeakMap<BaseAudioContext,Map<string,AudioBuffer>>();
export function synthSample(kind:Instrument,key:number,sampleRate:number):Float32Array{
 const count=Math.ceil(duration[kind]*sampleRate),out=new Float32Array(count),f=440*2**((key-69)/12);let low=0,low2=0;
 for(let i=0;i<count;i++){
  const t=i/sampleRate,u=t/duration[kind],n=hash(i+key*1087)*2-1,attack=1-Math.exp(-t*1800);low+=.12*(n-low);low2+=.038*(n-low2);let v=0;
  if(kind==='kick')v=(Math.sin(2*Math.PI*(48*t+1.65*(1-Math.exp(-t*36))))*.94*Math.exp(-t*12)+n*.06*Math.exp(-t*100))*attack;
  else if(kind==='snare')v=((n-low)*.74*Math.exp(-t*19)+Math.sin(2*Math.PI*182*t)*.28*Math.exp(-t*28))*attack;
  else if(kind==='hat'||kind==='openhat')v=(n-low)*.65*Math.exp(-t*(kind==='hat'?65:17))*attack;
  else if(kind==='tom')v=(Math.sin(2*Math.PI*(f*t+.35*(1-Math.exp(-t*35))))*.8+n*.055)*Math.exp(-t*13)*attack;
  else if(kind==='click')v=((n-low)*.44+Math.sin(2*Math.PI*1480*t)*.45)*Math.exp(-t*70)*attack;
  else if(kind==='riser')v=(low-low2)*2.9*Math.sin(Math.PI*u)**1.3;
  else if(kind==='impact')v=(Math.sin(2*Math.PI*(42*t+1.7*(1-Math.exp(-t*23))))*.61*Math.exp(-t*6)+(low-low2)*1.8*Math.exp(-t*7))*attack;
  else if(kind==='bass')v=(Math.sin(2*Math.PI*f*t)*.76+Math.sin(2*Math.PI*f*2*t)*.18+Math.sin(2*Math.PI*f*3*t)*.05)*Math.min(1,t/.006)*Math.exp(-t*4.5)*(1-move(t,.49,.19));
  else if(kind==='pluck')v=(Math.sin(2*Math.PI*f*t)*.69+Math.sin(2*Math.PI*f*2.003*t)*.23*Math.exp(-t*5)+Math.sin(2*Math.PI*f*3.007*t)*.1*Math.exp(-t*8))*attack*Math.exp(-t*4.2);
  else if(kind==='string'){const env=Math.min(1,t/.012)*Math.exp(-t*12);for(let k=1;k<=6;k++)v+=Math.sin(2*Math.PI*f*k*t)*(.52/k)*env;v+=n*.009*Math.exp(-t*28);}
  else if(kind==='pad'){const env=move(t,0,.22)*(1-move(t,3.1,1.5));v=(Math.sin(2*Math.PI*f*t)*.42+Math.sin(2*Math.PI*f*1.003*t)*.22+Math.sin(2*Math.PI*f*.997*t)*.22+Math.sin(2*Math.PI*f*2*t)*.08)*env;}
  out[i]=Math.tanh(v*1.05)*(1-move(t,duration[kind]-.009,.009));
 }
 return out;
}
function sample(context:BaseAudioContext,instrument:Instrument,key:number){let map=cache.get(context);if(!map){map=new Map();cache.set(context,map);}const id=instrument+':'+key;let b=map.get(id);if(!b){const data=synthSample(instrument,key,context.sampleRate);b=context.createBuffer(1,data.length,context.sampleRate);b.getChannelData(0).set(data);map.set(id,b);}return b;}
export function prepareAudio(context:BaseAudioContext){for(const n of notes)sample(context,n.instrument,n.key);}
// Delays are explicit source-time taps. The realtime scheduler reads the shared
// AudioContext clock; offline rendering schedules the complete requested segment.
const automationTimes=Array.from(new Set([0,151.8,DURATION,...voiceCues.flatMap(([a,b])=>[Math.max(0,a-.08),a,b,Math.min(DURATION,b+.2)])])).sort((a,b)=>a-b);
export function envelopePoints(trackId:string):[number,number][]{
 const minimum=trackId==='music'?.76:trackId==='drums'?.94:.96;
 return automationTimes.map(t=>{let g=1;for(const[a,b]of voiceCues){if(t<a-.08||t>b+.2)continue;const u=t<a?(t-(a-.08))/.08:t<=b?1:1-(t-b)/.2;g=Math.min(g,1-(1-minimum)*Math.max(0,Math.min(1,u)));}return[t,g*Math.max(0,Math.min(1,(DURATION-t)/(DURATION-151.8)))];});
}
export function envelopeAt(trackId:string,t:number):number{const points=envelopePoints(trackId);if(t<=0)return points[0]![1];if(t>=DURATION)return 0;let i=1;while(points[i]![0]<t)i++;const a=points[i-1]!,b=points[i]!;return a[1]+(b[1]-a[1])*(t-a[0])/(b[0]-a[0]);}
const scoreEvents=notes.flatMap(note=>{
 const taps=note.instrument==='pluck'?[[0,1,note.pan],[.118,.22,-note.pan],[.257,.1,note.pan]]:[[0,1,note.pan]];
 return taps.map(([delay,level,pan])=>({note,at:note.at+delay!,level:level!,pan:pan!}));
}).sort((a,b)=>a.at-b.at);

export function createAudio({trackId,context,destination,when,offset,duration:segment,rate,onError}:GeneratedAudioOptions){
 const bus=context.createGain(),end=Math.min(offset+segment,DURATION),sr=context.sampleRate;
 const offline=typeof (context as OfflineAudioContext).startRendering==='function';
 // Keep the graph bounded regardless of the remaining film length. Include tails
 // from before a seek, and extend source-time lookahead when playing faster.
 const events=scoreEvents.filter(e=>e.note.track===trackId&&e.at<end&&e.at+duration[e.note.instrument]>offset);
 const active=new Map<AudioBufferSourceNode,()=>void>();
 const wakeBuffer=offline?undefined:context.createBuffer(1,1,sr);
 let cursor=0,disposed=false,wake:AudioBufferSourceNode|undefined;
 const dispose=()=>{
  if(disposed)return;
  disposed=true;
  if(wake){wake.onended=null;try{wake.stop();}catch{/* Not started. */}wake.disconnect();wake=undefined;}
  for(const [source,release]of active){
   source.onended=null;
   try{source.stop();}catch{/* A failed start or an already ended source. */}
   release();
  }
  bus.disconnect();
 };
 const schedule=(initial=false)=>{
  if(disposed)return;
  const horizon=offline?end:Math.min(end,offset+(Math.max(0,context.currentTime-when)+2)*rate);
  while(cursor<events.length&&events[cursor]!.at<horizon){
   const {note,at:eventTime,level,pan}=events[cursor++]!;
   const b=sample(context,note.instrument,note.key),at=Math.round(eventTime*sr)/sr;
   const from=Math.max(at,Math.round(offset*sr)/sr),until=Math.min(at+b.duration,Math.round(end*sr)/sr,DURATION);
   if(until<=from)continue;
   const start=Math.max(when,when+(from-offset)/rate);
   if(!offline&&!initial&&start<context.currentTime-.02)
    throw new Error('配乐缓冲不足，请暂停后重新播放。');
   const src=context.createBufferSource(),gain=context.createGain(),panner=context.createStereoPanner();
   const release=()=>{src.onended=null;src.disconnect();gain.disconnect();panner.disconnect();active.delete(src);};
   active.set(src,release);
   src.onended=release;
   src.buffer=b;src.playbackRate.value=rate;panner.pan.value=pan;
   gain.gain.value=note.velocity*level*(trackId==='music'?.39:trackId==='drums'?.31:.4);
   src.connect(gain);gain.connect(panner);panner.connect(bus);
   src.start(start,from-at,until-from);
  }
 };
 // A silent one-frame source wakes the scheduler on the same audio clock. It is
 // cancelled with this graph and cannot advance playback or run while suspended.
 const arm=()=>{
  if(disposed||cursor===events.length)return;
  const source=context.createBufferSource();wake=source;
  source.buffer=wakeBuffer!;source.connect(bus);
  source.onended=()=>{
   source.onended=null;source.disconnect();wake=undefined;
   if(disposed)return;
   try{schedule();arm();}catch(error){dispose();onError?.(error instanceof Error?error:new Error(String(error)));}
  };
  source.start(context.currentTime+.1);
 };
 try{
  bus.connect(destination);bus.gain.setValueAtTime(envelopeAt(trackId,offset),when);
  for(const[t,v]of envelopePoints(trackId)){if(t>offset&&t<end)bus.gain.linearRampToValueAtTime(v,when+(t-offset)/rate);}
  bus.gain.linearRampToValueAtTime(envelopeAt(trackId,end),when+(end-offset)/rate);
  schedule(true);
  if(!offline)arm();
  return{dispose};
 }catch(error){dispose();throw error;}
}
export function disposeAudio(context:BaseAudioContext){cache.delete(context);}
