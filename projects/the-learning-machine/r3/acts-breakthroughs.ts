import * as T from 'three';
import {box,ball,tube,instances,put,beam,trace,label,textFace,card,board,boatTexture,onCurve,type M} from './geometry';
import {lerp,ramp,mod,hash,shot,type V3} from './math';
import type {Rig,Annotation} from './rig-types';

export function vision(m:M):Rig{
 const root=new T.Group();const optical=new T.Group();root.add(optical);const images:T.Group[]=[];
 const deck=board(optical,m,15);deck.position.y=-2;
 for(let j=0;j<4;j++){const img=card(optical,boatTexture(j),[(j-1.5)*3.4,.55,-j*.23],1.0,m);images.push(img);const mounting=box(optical,[.12,1.5,.45],m.metal,[(j-1.5)*3.4,-1.6,-j*.23],.025);mounting.name='mount';}
 const sweep=box(optical,[2.15,.025,.05],m.light,[-5.1,1.6,.13],.003);
 const field=instances(optical,new T.BoxGeometry(.09,.09,.09),m.amber,192);const cables:T.Mesh[]=[];for(let j=0;j<3;j++){const a=(j-1.5)*3.4,b=(j-.5)*3.4;cables.push(tube(optical,[[a+1.1,-.8,-j*.23],[b-1.1,-.8,-(j+1)*.23]],m.gold,.025).o);}
 const computer=new T.Group();root.add(computer);const deck2=board(computer,m,15);deck2.position.y=-1.9;
 const tiled=instances(computer,new T.BoxGeometry(1.85,.27,1.85),m.black,24),caps=instances(computer,new T.BoxGeometry(1.48,.12,1.48),m.metal,24),lights=instances(computer,new T.BoxGeometry(.23,.032,.23),m.light,384);
 for(let j=0;j<24;j++){const x=(j%6-2.5)*2.25,z=(Math.floor(j/6)-1.5)*2.3;put(tiled,j,[x,-1.54,z]);put(caps,j,[x,-1.34,z]);for(let k=0;k<16;k++)put(lights,j*16+k,[x+(k%4-1.5)*.33,-1.257,z+(Math.floor(k/4)-1.5)*.33]);}tiled.instanceMatrix.needsUpdate=true;caps.instanceMatrix.needsUpdate=true;lights.instanceMatrix.needsUpdate=true;
 const incoming=instances(computer,new T.BoxGeometry(.15,.15,.25),m.amber,120);const skyline=instances(computer,new T.BoxGeometry(.18,1,.18),m.green,192);const spark=ball(computer,.3,m.amber,[0,.1,0]);const trianglePaths:ReturnType<typeof tube>[]=[];
 const pillars:[V3,string][]=[[[-6,1.1,3.5],'数据'],[[6,1.1,3.5],'算力'],[[0,3,-3.8],'算法']];pillars.forEach(([p,text])=>{label(computer,text,[p[0],p[1]+.8,p[2]],2.1);trianglePaths.push(tube(computer,[p,[(p[0])*.5,2,p[2]*.5],[0,.1,0]],m.gold,.025));});
 const cubeField=instances(root,new T.BoxGeometry(.58,.24,.58),m.body,784);for(let j=0;j<784;j++)put(cubeField,j,[(j%28-13.5)*.91,-2.42,(Math.floor(j/28)-13.5)*.91]);cubeField.instanceMatrix.needsUpdate=true;
 return{root,update(i,u,t){optical.visible=i<=13;computer.visible=i>=14;cubeField.visible=i===15;const explode=i===12?0:ramp(u,.04,.20);images.forEach((g,j)=>{const x=i===12?(j===0?0:(j-1.5)*3.4):lerp(0,(j-1.5)*3.4,explode);g.position.set(x,i===12?.6:.55,-j*.23);g.scale.setScalar(i===12?(j===0?1.65:.001):Math.max(.001,explode));g.rotation.y=i===12?-.02:lerp(0,-.12,explode);});sweep.visible=i===12;sweep.position.set(0,lerp(2.6,-1.3,mod(u*2,1)),.14);sweep.scale.x=i===12?1.62:1;
 for(let j=0;j<192;j++){const p=mod(t*.55+j*.037,1),row=j%12;put(field,j,[lerp(-4.95,5.1,p),(row-5.5)*.16,-Math.floor(p*4)*.23+.16],[i===13?1:.001,1,1]);}field.instanceMatrix.needsUpdate=true;cables.forEach(c=>trace(c,explode));
 const active=ramp(u,.02,.26);computer.scale.setScalar(i===14?.001+.999*active:1);for(let j=0;j<120;j++){const index=j%24,x=(index%6-2.5)*2.25,z=(Math.floor(index/6)-1.5)*2.3,p=mod(t*.9+Math.floor(j/24)*.21,1);put(incoming,j,[lerp(x-3,x,p),lerp(2.8,-1.15,p),z],[1,1,1]);}incoming.instanceMatrix.needsUpdate=true;
 for(let j=0;j<192;j++){const h=(.25+hash(j+80)*1.4)*(i===15?ramp(u,.02,.27):.001);put(skyline,j,[(j%16-7.5)*.73,-1.04+h*.5,(Math.floor(j/16)-5.5)*.55],[1,h,1]);}skyline.instanceMatrix.needsUpdate=true;skyline.visible=i===15;spark.visible=i===15;spark.scale.setScalar(.7+Math.sin(t*5)*.1);trianglePaths.forEach((p,j)=>{p.o.visible=i===15;trace(p.o,ramp(u,.05+j*.04,.2+j*.04));});
 const pose=i===12?shot([7.7,6.4,10.4],[3.5,2.6,9.1],[0,.5,0],u,38):i===13?shot([3.5,2.6,9.1],[8.8,5.1,16],[0,.1,-.2],u,39):i===14?shot([8.8,5.1,16],[7,9.8,14],[0,-.6,0],u,41):shot([7,9.8,14],[18.5,18.8,22],[0,-.7,0],u,40,.31);
 const notes:Annotation[]=i===12?[{text:'2012 · AlexNet',position:[0,3.2,0],size:44}]:i===13?['图像','边缘','局部','模式'].map((text,j)=>({text,position:[(j-1.5)*3.4,-1.48,.15] as V3,size:26})):i===14?[{text:'同一批任务，并行处理',position:[0,3.6,0],size:33}]:[];return{pose,notes,tag:i===13?'特征组合示意 · 非实测激活':undefined,light:i===12||i===13};}};
}

export function decision(m:M):Rig{
 const root=new T.Group();const slab=box(root,[10.1,.54,10.1],m.ceramic,[0,-1.35,0],.17,true);box(root,[9.4,.035,9.4],m.paper,[0,-1.061,0],.035);
 const g:T.BufferGeometry=new T.BufferGeometry();const lines:number[]=[];for(let j=0;j<19;j++){const p=(j-9)*.49;lines.push(-4.41,-1.035,p,4.41,-1.035,p,p,-1.035,-4.41,p,-1.035,4.41);}g.setAttribute('position',new T.Float32BufferAttribute(lines,3));root.add(new T.LineSegments(g,new T.LineBasicMaterial({color:0x3a5b51})));
 const moves=[[3,3],[15,15],[15,3],[3,15],[4,4],[14,15],[15,5],[3,13],[6,3],[12,15],[13,3],[5,14],[8,7],[9,8],[10,7],[8,9],[10,8],[9,9],[11,8],[8,10],[6,7],[12,11],[7,6],[11,12],[5,8],[13,10],[6,9],[12,9]];
 const stones=moves.map((p,j)=>ball(root,.219,j%2?m.ceramic:m.black,[(p[0]!-9)*.49,-.927,(p[1]!-9)*.49],[1,.45,1]));
 const candidates:V3[]=[[-1.96,-1.004,-.49],[.49,-1.004,1.47],[1.96,-1.004,-1.96]];
 const rings=candidates.map(p=>{const o=meshRing(p);return o;});function meshRing(p:V3){const o=new T.Mesh(new T.TorusGeometry(.35,.026,8,64),m.amber);o.position.set(...p);o.rotation.x=-Math.PI/2;root.add(o);return o;}
 const probabilities=instances(root,new T.BoxGeometry(.11,1,.11),m.green,361);const branches=instances(root,new T.CylinderGeometry(1,1,1,6),m.green,45);const branchDots=instances(root,new T.SphereGeometry(.075,8,6),m.light,45);
 const decision=ball(root,.222,m.black,[.49,4.1,1.47],[1,.45,1]);const outcome=label(root,'4 : 1',[6.8,1.5,.0],4.5,'#efc08e');const under=label(root,'2016 · 李世石对局',[6.8,.45,0],4,'#b4d5c5');
 const nets=instances(root,new T.BoxGeometry(.2,.2,.2),m.metal,24);for(let j=0;j<24;j++)put(nets,j,[(j%6-2.5)*.33,2.2+Math.floor(j/6)*.4,-4.1]);nets.instanceMatrix.needsUpdate=true;
 return{root,update(i,u,t){slab.visible=true;stones.forEach((s,j)=>{s.scale.set(1,.45,1);s.position.y=i===16?lerp(3+hash(j)*2,-.927,ramp(u,j*.002,.18+j*.002)):-.927;});const show=i===16?ramp(u,.34,.5):1;
 for(let j=0;j<361;j++){const x=j%19-9,z=Math.floor(j/19)-9;const h=(Math.exp(-((x-1)**2+(z-3)**2)*.08)*1.6+Math.exp(-((x+4)**2+(z+1)**2)*.24)*.8)*show;put(probabilities,j,[x*.49,-1.01+h/2,z*.49],[1,Math.max(.001,h),1]);}probabilities.instanceMatrix.needsUpdate=true;probabilities.visible=i===16&&u>.30||i===17&&u<.28;
 rings.forEach((r,j)=>{r.visible=i===17&&u<.88;r.scale.setScalar(u>.51?(j===1?1.05:.001):1);});for(let j=0;j<45;j++){const branch=Math.floor(j/15),a=candidates[branch]!,p=(j%15)/14,b:V3=[a[0]+(hash(j)-.5)*3,a[1]+.3+p*2.1,a[2]-p*3.5];const visible=i===17?ramp(u,.20+j*.002,.36+j*.002)*(1-ramp(u,.58,.78)):.001;beam(branches,j,a,b,.024*visible);put(branchDots,j,b,[visible,visible,visible]);}branches.instanceMatrix.needsUpdate=true;branchDots.instanceMatrix.needsUpdate=true;
 decision.visible=i===18;decision.position.y=lerp(3.9,-.927,ramp(u,.04,.17));outcome.sprite.visible=i===18&&u>.24;under.sprite.visible=outcome.sprite.visible;nets.visible=i===17;nets.rotation.y=Math.sin(t*.3)*.03;
 const pose=i===16?shot([8.8,12,13],[2.2,11.3,10.4],[0,-.8,0],u,40,.2):i===17?shot([2.2,11.3,10.4],[8.1,6.6,12],[0,-.1,-.7],u,41):shot([8.1,6.6,12],[7.6,5.4,12.6],[1.4,-.4,.5],u,44);
 return{pose,tag:i===17?'先筛方向，再评估与搜索':i===18?'原创棋局示意，并非历史落点复刻':undefined,notes:i===16?[{text:'不是穷举所有棋局',position:[0,3.25,-4],size:31}]:[]};}};
}

export function attention(m:M):Rig{
 const root=new T.Group();const words=['桥洞','太低','，','帆船','无法','通过'];const widths=[2.22,2.22,.58,2.22,2.22,2.22];const xs=[-5.65,-3.1,-1.55,.25,2.8,5.35];const tokens:T.Group[]=[];
 words.forEach((s,j)=>{const g=new T.Group();root.add(g);g.position.set(xs[j]!,.0,0);box(g,[widths[j]!+.2,1.22,.34],m.black,[0,0,-.22],.12,true);textFace(g,s,[widths[j]!,1.02],[0,0,0],'#e9f1dc','#1b494a');box(g,[widths[j]!-.14,.035,.08],m.light,[0,-.54,.04],.008);tokens.push(g);});
 const arcs:ReturnType<typeof tube>[]=[];for(let j=0;j<6;j++){if(j===4)continue;arcs.push(tube(root,[[xs[j]!, .64,.1],[(xs[j]!+2.8)*.5,2.3+Math.abs(xs[j]!-2.8)*.16,-.8],[2.8,.64,.1]],j===1?m.amber:m.metal,j===1?.047:.015));}
 const couriers=instances(root,new T.SphereGeometry(.075,8,6),m.light,40);const sequence=tube(root,[[-6.8,-1.05,.2],[6.8,-1.05,.2]],m.gold,.022).o;
 const matrix=new T.Group();root.add(matrix);const panels:T.Group[]=[];for(let j=0;j<3;j++){const g=new T.Group();matrix.add(g);g.position.set((j-1)*4.6,.2,0);box(g,[3.45,3.1,.18],m.black,[0,0,-.2],.10,true);const cells=instances(g,new T.BoxGeometry(.28,.28,.2),j===2?m.gold:m.green,80);for(let k=0;k<80;k++)put(cells,k,[(k%10-4.5)*.315,(Math.floor(k/10)-3.5)*.345,.02],[1,1,.5+hash(k+j*41)*2]);cells.instanceMatrix.needsUpdate=true;panels.push(g);label(g,['查询','批量相关性','新的表示'][j]!,[0,2.18,0],3.3);}
 const products=instances(matrix,new T.BoxGeometry(.08,.08,.18),m.light,180);const layerStack=instances(matrix,new T.BoxGeometry(3.65,.12,3.2),m.metal,4);for(let j=0;j<4;j++)put(layerStack,j,[0,-2.6+j*.35,-1.3]);layerStack.instanceMatrix.needsUpdate=true;
 return{root,update(i,u,t){const advanced=i===21;tokens.forEach((g,j)=>{g.visible=!advanced;const p=i===19?ramp(u,.01+j*.02,.14+j*.02):1;g.position.set(lerp(12+j,xs[j]!,p),j===4&&i===20?lerp(0,.62,ramp(u,.03,.16)):0,0);g.rotation.y=i===20&&j===4?-.1:0;});sequence.visible=i===19;trace(sequence,ramp(u,.24,.78));arcs.forEach((a,j)=>{a.o.visible=i===20;trace(a.o,ramp(u,.1+j*.05,.27+j*.05));});
 for(let j=0;j<40;j++){const a=arcs[j%5]!,p=mod(t*.62+j*.127,1);put(couriers,j,onCurve(a.curve,p),[i===20?1:.001,1,1]);}couriers.instanceMatrix.needsUpdate=true;couriers.visible=i===20;
 matrix.visible=advanced;matrix.scale.setScalar(.001+.999*(advanced?ramp(u,0,.13):0));panels.forEach((g,j)=>{g.position.z=lerp(-2,0,ramp(u,.03+j*.03,.17+j*.03));g.rotation.y=(j-1)*-.09;});for(let j=0;j<180;j++){const p=mod(t*.79+j*.035,1);put(products,j,[lerp(-5.7,5.7,p),(j%8-3.5)*.28,.5],[1,1,1]);}products.instanceMatrix.needsUpdate=true;
 const pose=i===19?shot([7.6,5.4,12.6],[3.6,3.2,13.4],[0,.35,0],u,43):i===20?shot([3.6,3.2,13.4],[-3.7,3.3,13.6],[0,.65,0],u,42):shot([-3.7,3.3,13.6],[7.1,4.8,12],[0,.2,0],u,43);
 return{pose,notes:i===20?[{text:'“太低”的信息，被带入“无法通过”',position:[.2,4.1,-.3],size:30}]:i===21?[{text:'2017 · Transformer',position:[0,3.6,0],size:35}]:[],tag:'片段划分、关联强弱为教学示意'};}};
}
