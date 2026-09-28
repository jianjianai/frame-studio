export type V3=[number,number,number];
export const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
export const lerp=(a:number,b:number,u:number)=>a+(b-a)*u;
export const ease=(v:number)=>{const u=clamp(v);return u*u*u*(10+u*(-15+6*u));};
export const ramp=(v:number,a:number,b:number)=>ease((v-a)/(b-a));
export const mod=(x:number,n:number)=>((x%n)+n)%n;
export const hash=(i:number)=>{let x=(i|0)+0x6d2b79f5;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return((x^(x>>>14))>>>0)/4294967296;};
export const blend=(a:V3,b:V3,u:number)=>a.map((v,i)=>lerp(v,b[i]!,u)) as V3;
export type Pose={eye:V3;aim:V3;fov:number};
/** Fast motivated move, then a restrained 4% final drift. No independent camera clock. */
export function shot(a:V3,b:V3,aim:V3,u:number,fov=40,travel=.16):Pose{const p=.96*ramp(u,0,travel)+.04*ramp(u,travel,1);return{eye:blend(a,b,p),aim,fov};}
export const C={ink:0x0b2029,black:0x101e25,green:0x207967,mint:0x85ebce,cream:0xe4e6df,gold:0xd8a159,red:0xc95143};
