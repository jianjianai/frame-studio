export const DURATION=153.6;
export const cuts=[0,3.1,6.2,9.6,13.3,18.3,22.5,27.1,31.4,35.5,40,43.5,48,51.7,55.5,60,64.1,67.2,72.5,77,82,86.2,90.4,95,99,103.2,107.4,112,117,121,126,129,133,138,143,148] as const;
export const acts=[
 {at:0,end:9.6,key:'hook',name:'同一只猫，为什么认不出？',year:'一个问题'},
 {at:9.6,end:27.1,key:'rules',name:'01 / 把知识写成规则',year:'1956 · DARTMOUTH'},
 {at:27.1,end:48,key:'learn',name:'02 / 从样本中学习',year:'1986 · BACKPROPAGATION'},
 {at:48,end:64.1,key:'vision',name:'把简单特征组合起来',year:'2012 · ALEXNET'},
 {at:64.1,end:77,key:'go',name:'从识别，到决策',year:'2016 · ALPHAGO'},
 {at:77,end:99,key:'attention',name:'让一句话里的信息彼此关联',year:'2017 · TRANSFORMER'},
 {at:99,end:126,key:'predict',name:'03 / 预测下一个词元',year:'2022 → 2024'},
 {at:126,end:138,key:'verify',name:'会说，不等于说对',year:'概率 ≠ 事实'},
 {at:138,end:153.6,key:'outro',name:'下一道题，由人来问',year:'THE NEXT QUESTION'},
] as const;
export type Act=typeof acts[number];
export const clamp=(x:number,a=0,b=1)=>Math.max(a,Math.min(b,x));
export const lerp=(a:number,b:number,p:number)=>a+(b-a)*p;
export const mod=(x:number,n:number)=>((x%n)+n)%n;
export const ease=(p:number)=>{const q=clamp(p);return q*q*q*(q*(q*6-15)+10);};
export const move=(t:number,at:number,d=.38)=>ease((t-at)/d);
export const out=(t:number,at:number,d=.38)=>1-(1-clamp((t-at)/d))**4;
export const hit=(t:number,at:number,d=.42)=>{const p=clamp((t-at)/d);return p===1?1:1-Math.exp(-7*p)*Math.cos(10*p);};
export const gate=(t:number,a:number,b:number)=>move(t,a,.18)*(1-move(t,b,.18));
export function actAt(t:number):Act{return acts.find(a=>t<a.end)??acts[8];}
export function shotAt(t:number){let n=0;for(let i=1;i<cuts.length;i++)if(t>=cuts[i]!)n=i;return n;}
export type V3=[number,number,number];
export type CameraPose={p:V3;look:V3;fov:number};
export type CameraKey=CameraPose&{at:number;duration?:number};
export function camera(keys:CameraKey[],t:number):CameraPose{let i=0;while(i+1<keys.length&&t>=keys[i+1]!.at)i++;const b=keys[i]!,a=keys[Math.max(0,i-1)]!,p=i===0?1:move(t,b.at,b.duration??.4);return {p:a.p.map((v,j)=>lerp(v,b.p[j]!,p)) as V3,look:a.look.map((v,j)=>lerp(v,b.look[j]!,p)) as V3,fov:lerp(a.fov,b.fov,p)};}
export const color={night:'#071e25',ink:'#14383d',paper:'#f4f0e6',muted:'#728b89',mint:'#49d5b0',orange:'#ffb549',red:'#f35b53',silver:'#aac8bf',white:'#fffaf0'};
export function hash(i:number){let x=(i|0)+0x6d2b79f5;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return ((x^(x>>>14))>>>0)/4294967296;}
