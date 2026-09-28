import * as T from 'three';
import {box,ball,cylinder,tube,instances,put,beam,trace,label,digit,digitTexture,card,board,chip,pen,orbitPoints,type M} from './geometry';
import {clamp,lerp,ramp,mod,hash,shot,type V3} from './math';
import type {Rig,Annotation} from './rig-types';

export function opening(m:M):Rig{
 const root=new T.Group();const globe=new T.Group();root.add(globe);
 ball(globe,1.45,m.black,[0,.15,0]);const wire=new T.Mesh(new T.SphereGeometry(1.456,28,16),new T.MeshBasicMaterial({color:0x438579,wireframe:true,transparent:true,opacity:.25}));globe.add(wire);wire.position.y=.15;
 const orbit=tube(globe,orbitPoints(3.15,.2),m.gold,.023,true,120).o;orbit.rotation.z=.31;const orbit2=tube(globe,orbitPoints(3.75,.2),m.metal,.012,true,120).o;orbit2.rotation.x=.42;
 const spacecraft=new T.Group();globe.add(spacecraft);box(spacecraft,[.3,.25,.55],m.metal,[0,0,0],.02);box(spacecraft,[1.22,.04,.4],m.green,[0,0,0],.01);ball(spacecraft,.06,m.light,[0,.17,0]);
 const glyphGroup=new T.Group();root.add(glyphGroup);const g=digit(glyphGroup,m.ceramic,1.55);g.root.position.y=.45;const guide=instances(glyphGroup,new T.BoxGeometry(.04,.025,.04),m.metal,256);for(let j=0;j<256;j++)put(guide,j,[(j%16-7.5)*.32,-2.05,(Math.floor(j/16)-7.5)*.32]);guide.instanceMatrix.needsUpdate=true;
 const scan=new T.Group();glyphGroup.add(scan);const bar=box(scan,[4.65,.018,.025],m.light,[0,0,.33],.003);const readings=label(scan,'7',[3.3,0,.4],1.5,'#f2bd76');const scribbles:T.Group[]=[];for(let j=0;j<9;j++){const k=digit(glyphGroup,j===4?m.light:m.body,.24,[(j%3-1)*1.2,-2.34,2+(Math.floor(j/3))*.75],j+1);k.root.rotation.x=-Math.PI/2;scribbles.push(k.root);}
 const stylus=pen(root,m);stylus.root.position.set(5,2.8,1.2);stylus.root.rotation.z=-.58;
 const pulses=instances(root,new T.SphereGeometry(.045,8,6),m.light,50);
 return{root,update(i,u,t){globe.visible=i===0;glyphGroup.visible=i>=1||u>.54;const reveal=i===0?ramp(u,.49,.69):1;glyphGroup.scale.setScalar(.001+.999*reveal);glyphGroup.position.x=i===0?lerp(8,0,reveal):0;globe.scale.setScalar(i===0?1-ramp(u,.52,.76)*.96:.001);globe.rotation.y=t*.18;const a=t*1.05;spacecraft.position.set(3.15*Math.cos(a),.2,3.15*Math.sin(a));spacecraft.rotation.y=-a;g.root.rotation.z=i===1?Math.sin(u*6.28)*.11:0;const s=mod(t*.58,1);scan.position.y=lerp(2.5,-1.95,s);scan.visible=i>0;bar.scale.x=1;readings.set(i===1?(u<.47?'7':'?'):'7');scribbles.forEach((v,j)=>{v.scale.setScalar(.24*Math.max(.001,ramp(u,.12+j*.035,.27+j*.035)));v.visible=i===2;});stylus.root.visible=i===2;stylus.root.position.y=lerp(4.5,1.8,ramp(u,.05,.25));for(let j=0;j<50;j++){const a2=j/50*Math.PI*2,p=mod(t*.31+j*.14,1);put(pulses,j,[Math.cos(a2)*lerp(6,.1,p),lerp(-1.8,.5,p),Math.sin(a2)*lerp(6,.1,p)],[reveal,reveal,reveal]);}pulses.instanceMatrix.needsUpdate=true;
 const pose=i===0?shot([6,3.2,8],[4.1,2.65,7.3],[0,.2,0],u,40,.68):i===1?shot([4.1,2.65,7.3],[1.7,2.5,9.3],[0,.0,0],u,37):shot([1.7,2.5,9.3],[7.8,7.1,11.6],[0,.2,.5],u,38);
 return{pose,notes:i===0?[]:[{text:'同一个数字，不同的写法',position:[0,-2.6,2.7],size:29}],title:i===2&&u>.24?'不是突然变聪明':undefined};}};
}

export function rules(m:M):Rig{
 const root=new T.Group();const base=board(root,m,14);base.position.y=-1.8;
 const input=digit(root,m.ceramic,.87,[-4.8,.17,0]);const messy=digit(root,m.amber,.87,[-4.8,.17,0],5);
 const rail=box(root,[12.8,.08,1.62],m.black,[0,-1.59,.1],.04);const routes:T.Mesh[]=[];
 for(const zz of [-.51,.0,.51])routes.push(tube(root,[[-6,-1.5,zz],[-2.2,-1.5,zz],[-1.4,-1.5,zz-1.1],[2.25,-1.5,zz-1.1],[3,-1.5,zz],[6,-1.5,zz]],m.gold,.017).o);
 const modules:T.Group[]=[];for(let j=0;j<3;j++){const g=new T.Group();g.position.set(-1.6+j*2.4,-.52,-.2);root.add(g);box(g,[1.55,1.9,1.7],m.black,[0,0,0],.11,true);box(g,[1.36,1.64,.11],m.green,[0,0,.9],.06);const top=box(g,[1.85,.18,1.92],m.metal,[0,1.11,0],.05,true);top.name='lid';label(g,['横线','斜线','规则成立'][j]!,[0,.45,1],2.15);const face=box(g,[.73,.14,.10],m.light,[0,-.29,1.01],.015);face.name='led';modules.push(g);}
 const out=digit(root,m.light,.92,[6,.13,0]);const failure=label(root,'无法匹配',[5.9,.03,.6],3,'#f49f87');
 const packets=instances(root,new T.BoxGeometry(.19,.06,.29),m.amber,44);const logicTree=new T.Group();root.add(logicTree);logicTree.position.set(0,.4,-4.1);const links=instances(logicTree,new T.CylinderGeometry(1,1,1,5),m.metal,62),nodes=instances(logicTree,new T.BoxGeometry(.18,.18,.18),m.green,63);const pos:V3[]=[];
 for(let j=0;j<63;j++){const layer=Math.floor(Math.log2(j+1)),x=(j-(2**layer-1)-(2**layer-1)/2)*16/(2**layer);pos.push([x,layer*.51,0]);put(nodes,j,pos[j]!);if(j)beam(links,j-1,pos[Math.floor((j-1)/2)]!,pos[j]!, .015);}nodes.instanceMatrix.needsUpdate=true;links.instanceMatrix.needsUpdate=true;
 const gate=box(root,[.2,2.8,2.08],m.red,[3.37,-.1,0],.04);const loose=instances(root,new T.BoxGeometry(.16,.11,.34),m.gold,56);
 return{root,update(i,u,t){rail.visible=true;const f=i===6?ramp(u,.09,.26):0;input.root.visible=i<6;messy.root.visible=i===6;input.root.rotation.z=0;messy.root.rotation.z=.12;const built=i===3?ramp(u,0,.24):1;modules.forEach((g,j)=>{g.position.y=lerp(5+j,-.52,i===3?ramp(u,.03+j*.04,.22+j*.04):built);g.rotation.y=0;const lid=g.getObjectByName('lid')!;lid.position.y=i===4?lerp(1.11,2.1,ramp(u,.09,.27)):1.11;const led=g.getObjectByName('led') as T.Mesh;led.material=f>.3&&j===1?m.red:m.light;g.scale.setScalar(i===3?Math.max(.001,built):1);});
 out.root.visible=i===5&&u>.64;trace(out.stroke,ramp(u,.64,.84));failure.sprite.visible=i===6&&u>.4;gate.position.y=lerp(-4,-.1,f);gate.visible=i===6;logicTree.visible=i>=4;logicTree.scale.setScalar(i===6?lerp(1,1.18,f):.83);logicTree.position.y=i===6?1.1:.4;nodes.material=i===6&&u>.5?m.red:m.green;
 const moving=i<6?t*3.6:t*3.6*(1-f)+18*f;for(let j=0;j<44;j++){const x=-6.4+mod(moving+j*.53,12.8);put(packets,j,[x,-1.4,(j%3-1)*.38],[1,1,1]);}packets.instanceMatrix.needsUpdate=true;
 for(let j=0;j<56;j++){const p=clamp((u-.26)*2-j*.009);put(loose,j,[3.2+(hash(j)*2-1)*p*3.5,lerp(-1.2,-1.5,p)+Math.sin(p*Math.PI)*(1+hash(j+7)*3),(hash(j+2)*2-1)*p*3],[p,p,p],[p*3,p*2,p]);}loose.visible=i===6;loose.instanceMatrix.needsUpdate=true;
 const notes:Annotation[]=i===3?[{text:'1956 · 达特茅斯',position:[0,3.8,-1],size:44}]:i===4?[{text:'条件 → 推理 → 答案',position:[1.2,3.7,-.2],size:34}]:i===6?[{text:'规则越来越多，例外仍在出现',position:[0,4.7,-4],size:28,color:'#e8b7a3'}]:[{text:'示意规则：横线 + 斜线',position:[-.8,2.8,0],size:30}];
 const pose=i===3?shot([12,9,16],[8,5.7,12],[0,-.2,0],u,40):i===4?shot([8,5.7,12],[2.4,5.4,10],[0,.1,0],u,42):i===5?shot([2.4,5.4,10],[6.3,3.7,13],[1,-.3,0],u,43):shot([6.3,3.7,13],[11,8.4,17],[.5,.2,-1],u,42);
 return{pose,notes,light:true};}};
}

export function learning(m:M):Rig{
 const root=new T.Group();const deck=board(root,m,15);deck.position.y=-2.05;
 const pages:T.Group[]=[];const tex=Array.from({length:12},(_,i)=>digitTexture(i));for(let j=0;j<16;j++){const g=card(root,tex[j%12]!,[-6.9,0,-1.0],.38,m);pages.push(g);}
 const positions:V3[][]=Array.from({length:4},(_,l)=>Array.from({length:l===0?4:l===3?3:5},(_,j)=>[(l-1.5)*3.1,(j-((l===0?4:l===3?3:5)-1)/2)*.85,0] as V3));
 const edges:{a:V3;b:V3;k:number;layer:number}[]=[];positions.forEach((v,l)=>{v.forEach(p=>{cylinder(root,.15,.09,m.metal,[p[0],-1.76,p[1]]);const n=ball(root,.24,m.black,p);n.name='node';ball(root,.12,m.light,[p[0],p[1],.203],[1,1,.45]);});if(l<3)for(const a of v)for(const b of positions[l+1]!)edges.push({a,b,k:hash(edges.length+83),layer:l});});
 const beams=instances(root,new T.CylinderGeometry(1,1,1,6),m.metal,edges.length),signals=instances(root,new T.SphereGeometry(.085,8,6),m.light,edges.length),back=instances(root,new T.SphereGeometry(.10,8,6),m.amber,edges.length);
 const prediction=label(root,'预测：1',[6.95,.8,0],3.2,'#f2b69a');const target=label(root,'标签：7',[6.95,1.9,0],2.8,'#a6e5cc');const predDigit=digit(root,m.red,.62,[6.95,-.5,0]);const compare=box(root,[1.35,.045,1.35],m.gold,[6.95,-1.69,0],.08);
 const parameter=new T.Group();root.add(parameter);parameter.position.set(-.05,-.1,.62);box(parameter,[.16,2.8,.11],m.black,[0,0,0],.02);const knob=box(parameter,[.77,.32,.38],m.gold,[0,-.8,0],.07);const weight=label(parameter,'0.24',[0,1.96,.6],2.4,'#e8bf81');
 const trainingMeter=label(root,'误差',[4.8,-2.6,1.6],2.8,'#abcbbd');const trainPulse=tube(root,[[6.95,-1.2,.2],[6.1,-2.65,1.2],[0,-2.7,1.6],[-6,-2.1,.4]],m.gold,.025).o;
 const dataTower=instances(root,new T.BoxGeometry(1.6,.09,1.25),m.paper,80);const waitChip=chip(root,m,.66,[4.2,-1.8,-3.6]);
 return{root,update(i,u,t){const training=i>=8;const learned=i>=10?1:i===9?ramp(u,.57,.73):0;pages.forEach((g,j)=>{const p=mod(t*.37+j*.092,1);g.position.set(i===7?lerp(-11,-6.6,ramp(u,j*.012,.31+j*.012)):lerp(-8,-4.65,p),i===7?(j%4-1.5)*.51:lerp((j%4-1.5)*.64,0,p),-1.4-Math.floor(j/4)*.35);g.rotation.y=.17;g.visible=i<11;});
 let phase=i===8?u*2.4:i===9?u*2.9:i>=10?u*3.5:0;const forward=mod(phase,1);edges.forEach((e,j)=>{beam(beams,j,e.a,e.b,lerp(.018,.015+e.k*.048,learned));const q=clamp(forward*3-e.layer);const active=training&&forward*3>=e.layer&&forward*3<e.layer+1;put(signals,j,[lerp(e.a[0],e.b[0],q),lerp(e.a[1],e.b[1],q),.09],[active?1:.001,active?1:.001,active?1:.001]);const b=clamp((u-.12)*2.5-(2-e.layer)*.2);put(back,j,[lerp(e.b[0],e.a[0],b),lerp(e.b[1],e.a[1],b),.17],[i===9&&u>.12&&u<.65?1:.001,1,1]);});beams.instanceMatrix.needsUpdate=true;signals.instanceMatrix.needsUpdate=true;back.instanceMatrix.needsUpdate=true;
 prediction.set(i<8?'预测：?':i<10?'预测：1':'预测：7');prediction.sprite.material.color.set(i>=10?0xa4edcb:0xf3ad95);predDigit.root.visible=i>=10;predDigit.stroke.material=m.light;compare.visible=true;target.sprite.visible=i>=8;parameter.visible=i===9;knob.position.y=lerp(-.8,.81,learned);weight.set(lerp(.24,.68,learned).toFixed(2));trainPulse.visible=i===9;trace(trainPulse,ramp(u,.1,.57));trainingMeter.sprite.visible=i>=8&&i<11;trainingMeter.set(i<10?'输出与标签不符':'参数更新后，再次预测');
 dataTower.visible=i>=10;for(let j=0;j<80;j++){const p=ramp(u,.04+(j%8)*.018,.29+(j%8)*.018);put(dataTower,j,[-6.8+(j%4)*1.76,-1.8+Math.floor(j/4)*.10, -4.5], [1,p,1]);}dataTower.instanceMatrix.needsUpdate=true;waitChip.root.visible=i>=10;waitChip.root.scale.setScalar(i===11?lerp(.66,1.25,ramp(u,.1,.34)):.66);
 const pose=i===7?shot([-10,4.2,12],[-1.7,3.4,15],[0,.1,0],u,42):i===8?shot([-1.7,3.4,15],[8.5,3.8,14],[1,0,0],u,43):i===9?shot([6.4,3.4,11],[2.8,2.65,7],[0,0,.3],u,41):i===10?shot([2.8,2.65,7],[-8.7,6.9,16],[0,0,-1],u,44):shot([-8.7,6.9,16],[7.7,6.4,10.4],[2.3,-.1,-3.2],u,43);
 return{pose,tag:i===9?'反向传播：计算误差对参数的影响':i===10?'1986 · 多层网络训练的重要推进':i===11?'数据与算力，仍是瓶颈':undefined,notes:i===7?[{text:'给例子，不再枚举所有写法',position:[-4.5,3,0],size:32}]:[]};}};
}
