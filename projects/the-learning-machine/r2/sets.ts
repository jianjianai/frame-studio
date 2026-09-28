import * as T from 'three';
import {cat,box,sphere,tube,ring,instance,put,beam,featureTexture,labelPlane,type Mats} from './forms';
import {actAt,camera,move,lerp,clamp,mod,type V3,type CameraKey,type CameraPose} from './time';
const key=(at:number,p:V3,look:V3=[0,0,0],fov=38,duration=.4):CameraKey=>({at,p,look,fov,duration});
export function makeSets(scene:T.Scene,m:Mats){
 const roots:T.Group[]=[];const group=()=>{const g=new T.Group();scene.add(g);roots.push(g);return g;};
 const portrait=group(),pet=cat(portrait,m),logic=new T.Group();portrait.add(logic);
 const tests=[box(logic,[3.25,.9,.5],m.dark,[3.1,1.5,0]),box(logic,[3.25,.9,.5],m.dark,[3.1,.05,0])];
 labelPlane(logic,'尖耳朵',2.85,.55,[3.1,1.51,.258]);labelPlane(logic,'有胡须',2.85,.55,[3.1,.06,.258]);
 const result=box(logic,[3.25,1.05,.55],m.dark,[3.1,-1.8,0]);
 const ports=[sphere(logic,.12,m.light,[1.29,1.5,0]),sphere(logic,.12,m.light,[1.29,.05,0])];
 tube(logic,[[4.85,1.5,0],[5.38,1.5,0],[5.38,-1.8,0],[4.8,-1.8,0]],m.metal,.038);tube(logic,[[4.8,.05,0],[5.38,.05,0]],m.metal,.038);
 const shutter=box(portrait,[3.6,1.5,.14],m.dark,[-10,1.58,1.8],.035);
 const net=group(),sample=cat(net,m);sample.root.position.set(-6.2,-.63,0);sample.root.scale.setScalar(.58);
 const positions:V3[][]=[[-1.4,0,1.4].map(y=>[-3.3,y,0] as V3),[-1.75,-.58,.58,1.75].map(y=>[0,y,0] as V3),[-.83,.83].map(y=>[3.3,y,0] as V3)];
 const nodeLights:T.Mesh[]=[];const nodeCoords:V3[]=[];
 positions.forEach((layer,l)=>layer.forEach(p=>{sphere(net,.29,l===0?m.gold:m.dark,p);const glow=sphere(net,.155,m.glow,[p[0],p[1],p[2]+.246],[1,1,.38]);nodeLights.push(glow);nodeCoords.push(p);}));
 const edges:{a:V3;b:V3;layer:number;selected:boolean}[]=[];for(let l=0;l<2;l++)positions[l]!.forEach((a,i)=>positions[l+1]!.forEach((b,j)=>edges.push({a,b,layer:l,selected:l===0?i===1&&j===2:i===2&&j===1})));
 const links=instance(net,new T.CylinderGeometry(1,1,1,8),m.metal,edges.length);const packets=instance(net,new T.SphereGeometry(.10,12,8),m.glow,edges.length);const feedback=instance(net,new T.SphereGeometry(.12,12,8),m.light,6);
 const returnPath=tube(net,[[3.3,-.83,0],[4,-2.3,0],[0,-2.7,0],[-3.3,-2.3,0],[-3.3,0,0]],m.gold,.025);const output=sphere(net,.46,m.red,[5.5,.22,0]);const dial=ring(net,.5,m.gold,[-1.55,.4,.08],.045);
 const vision=group(),panels:T.Group[]=[];for(let i=0;i<4;i++){const g=new T.Group();vision.add(g);box(g,[2.85,2.85,.17],m.ivory,[0,0,-.13],.065);const face=new T.Mesh(new T.PlaneGeometry(2.65,2.65),new T.MeshBasicMaterial({map:featureTexture(i)}));g.add(face);panels.push(g);}
 const scanner=box(vision,[2.72,.035,.07],m.light,[-4.95,1.31,.09],.006);
 const batch=new T.Group();vision.add(batch);box(batch,[8.4,.3,6.2],m.dark,[0,-1.1,0],.15);box(batch,[8,.035,5.8],m.teal,[0,-.92,0],.03);
 const compute=instance(batch,new T.BoxGeometry(1.3,.43,1.05),m.metal,16),leds=instance(batch,new T.BoxGeometry(1.05,.045,.8),m.glow,16);for(let i=0;i<16;i++){const p:V3=[(i%4-1.5)*1.8,-.68,(Math.floor(i/4)-1.5)*1.35];put(compute,i,p);put(leds,i,[p[0],-.437,p[2]]);}compute.instanceMatrix.needsUpdate=true;leds.instanceMatrix.needsUpdate=true;
 const data=instance(batch,new T.BoxGeometry(.27,.18,.27),m.gold,64);
 const go=group();box(go,[9.6,.48,9.6],m.cream,[0,-1.4,0],.18);const boardLines:number[]=[];for(let i=0;i<19;i++){const z=(i-9)*.48;boardLines.push(-4.32,-1.148,z,4.32,-1.148,z,z,-1.148,-4.32,z,-1.148,4.32);}go.add(new T.LineSegments(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(boardLines,3)),new T.LineBasicMaterial({color:0x284e45})));
 const stones:[[number,number],boolean][]=[[[3,3],false],[[15,15],true],[[15,3],false],[[3,15],true],[[3,5],false],[[4,4],true],[[5,3],false],[[14,15],true],[[15,13],false],[[14,13],true],[[12,3],false],[[13,4],true],[[3,12],false],[[4,13],true],[[9,8],false],[[9,9],true],[[10,8],false],[[10,9],true],[[8,7],false],[[8,9],true],[[11,8],false],[[11,10],true]];
 stones.forEach(([p,white])=>sphere(go,.218,white?m.ivory:m.dark,[(p[0]-9)*.48,-1.01,(p[1]-9)*.48],[1,.47,1]));
 const candidates:V3[]=[[-1.44,-1.11,-.48],[.96,-1.11,1.44],[2.4,-1.11,-2.4]];
 const halos=candidates.map(p=>{const r=ring(go,.38,m.light,p,.035);r.rotation.x=-Math.PI/2;return r;});
 const hero=sphere(go,.22,m.dark,[.96,3,1.44],[1,.47,1]);
 const search=instance(go,new T.CylinderGeometry(1,1,1,6),m.teal,21);for(let i=0;i<21;i++){const level=i<3?0:1;const a:V3=level===0?[.96,-1.04,1.44]:candidates[Math.floor((i-3)/6)]!;const b:V3=level===0?candidates[i]!:[a[0]+((i-3)%6-2.5)*.37,-.65-level*.12,a[2]-1.1];beam(search,i,a,b,.023);}search.instanceMatrix.needsUpdate=true;
 const core=group(),unit=new T.Group();core.add(unit);box(unit,[4.2,.27,4.2],m.dark,[0,-1.4,0],.15);const layers:T.Group[]=[];
 for(let k=0;k<3;k++){const layer=new T.Group();unit.add(layer);layers.push(layer);box(layer,[3.5,.14,3.5],m.metal,[0,0,0],.045);const grid=instance(layer,new T.BoxGeometry(.66,.25,.66),m.teal,16);for(let i=0;i<16;i++)put(grid,i,[(i%4-1.5)*.81,.19,(Math.floor(i/4)-1.5)*.81]);grid.instanceMatrix.needsUpdate=true;}
 const coreCat=cat(core,m);coreCat.root.scale.setScalar(.78);coreCat.root.position.set(-4.7,-.6,0);
 const nucleus=sphere(unit,.38,m.light,[0,1.5,0]);
 const chipPins=instance(unit,new T.BoxGeometry(.08,.1,.5),m.gold,48);for(let i=0;i<48;i++){const side=Math.floor(i/12),v=(i%12-5.5)*.29;put(chipPins,i,[side%2? (side===1?-2.25:2.25):v,-1.24,side%2?v:(side===0?-2.25:2.25)],[1,1,1],[0,side%2?Math.PI/2:0,0]);}chipPins.instanceMatrix.needsUpdate=true;
 function animatePet(t:number){pet.head.rotation.y=.035*Math.sin(t*2);pet.tail.rotation.y=.075*Math.sin(t*3);const blink=Math.min(1,Math.abs(mod(t+1.24,3.73)-.11)*11+.045);for(const s of [-1,1]){const e=pet.head.getObjectByName('eye-'+s);if(e)e.scale.y=.87*blink;}}
 function update(t:number):CameraPose {
  roots.forEach(g=>g.visible=false);const a=actAt(t);let pose:CameraPose={p:[0,.7,14],look:[0,0,0],fov:37};
  if(a.key==='hook'||a.key==='rules'||a.key==='outro'){
   portrait.visible=true;logic.visible=a.key==='rules';shutter.visible=a.key==='rules'&&t>=22.5;animatePet(t);
   pet.root.position.set(a.key==='rules'?-4.1:a.key==='outro'?-4.35:-3.45,-.35,0);pet.root.scale.setScalar(a.key==='rules'?1.48:a.key==='outro'?1.25:1.78);
   pet.root.rotation.set(0,-.1,a.key==='hook'?Math.PI*move(t,.87,.36)*(1-move(t,6.3,.33)):0);
   if(a.key==='rules'){
    logic.scale.setScalar(.001+.999*move(t,9.65,.5));const fail=t>22.85;tests[0]!.material=fail?m.red:t>18.5?m.teal:m.dark;tests[1]!.material=t>19.15?m.teal:m.dark;result.material=fail?m.red:t>20?m.teal:m.dark;ports[0]!.material=fail?m.red:m.light;ports[1]!.material=m.light;shutter.position.x=lerp(-11,-4.1,move(t,22.5,.35));
   }
  }else if(a.key==='learn'){
   net.visible=true;sample.root.visible=!(t>=35.5&&t<40);const grown=.001+.999*move(t,27.1,.42);net.scale.setScalar(grown);sample.root.rotation.z=t>=43.5?-.45*move(t,43.5,.3):0;sample.root.rotation.y=t>=43.5?.36:0;sample.head.rotation.y=.04*Math.sin(t*2.5);
   const current=t>=43.5?44.85:t>=40?40.15:31.55,forward=clamp((t-current)/1.15);const active=t>=current&&t<=current+1.15;const trained=move(t,36.8,.44);
   edges.forEach((e,i)=>{beam(links,i,e.a,e.b,e.selected?lerp(.04,.102,trained):.022);const p=clamp(forward*2-e.layer);put(packets,i,[lerp(e.a[0],e.b[0],p),lerp(e.a[1],e.b[1],p),.12],[active&&forward*2>=e.layer&&forward*2<=e.layer+1?1:.001,1,1]);});links.instanceMatrix.needsUpdate=true;packets.instanceMatrix.needsUpdate=true;
   nodeLights.forEach((n,i)=>{const layer=nodeCoords[i]![0]/3.3+1;const pulse=active?Math.max(0,1-Math.abs(forward*2-layer)*3):0;n.scale.set(1+pulse*.7,1+pulse*.7,.38);});
   const backward=clamp((t-33.65)/1.28);for(let i=0;i<6;i++){const p=clamp(backward+i*.045);put(feedback,i,[lerp(3.4,-3.3,p),-2.35-.24*Math.sin(p*Math.PI),.08],[t>=33.65&&t<=35.05?1:.001,1,1]);}feedback.instanceMatrix.needsUpdate=true;returnPath.visible=t>=33.2&&t<39.7;output.material=t<32.7||t>=43.5&&t<46.1?m.dark:t<40.85?m.red:m.teal;dial.visible=t>=35.5&&t<39.8;dial.rotation.z=-trained*Math.PI*1.25;
   pose=camera([key(27.1,[0,.8,15],[0,0,0],39),key(35.5,[-.8,.45,8.6],[-1.1,.35,0],38,.35),key(40,[0,.8,15],[0,0,0],39,.4)],t);
  }else if(a.key==='vision'){
   vision.visible=true;batch.visible=t>=60;panels.forEach((g,i)=>{g.visible=t<60;const p=move(t,50.9+i*.17,.38);g.position.set(lerp(-4.95,(-1.5+i)*3.32,p),0,-i*.08);g.rotation.y=lerp(0,-.075,p);g.scale.setScalar(i===0?lerp(1.68,1,p):Math.max(.001,p));});scanner.visible=t<51.9;scanner.position.set(-4.95,lerp(1.29,-1.29,clamp((t-48.45)/1.2)),.11);
   for(let i=0;i<64;i++){const cell=i%16,p=mod((t-60)*1.8+Math.floor(i/16)*.23,1);const xx=(cell%4-1.5)*1.8,zz=(Math.floor(cell/4)-1.5)*1.35;put(data,i,[lerp(-7,xx,clamp(p*1.6)),lerp(2.2,-.3,p),zz],[.8,.8,.8]);}data.instanceMatrix.needsUpdate=true;batch.scale.setScalar(.001+.999*move(t,60,.35));
   pose=camera([key(48,[-.5,1.1,13.5],[0,0,0],38),key(55.5,[2.2,2.1,13.5],[0,0,0],38,.36),key(60,[7,8.2,10],[0,-.3,0],39,.5)],t);
  }else if(a.key==='go'){
   go.visible=true;go.position.x=-2.05*move(t,72.5,.42);go.scale.setScalar(.001+.999*move(t,64.1,.34));const p=move(t,70.75,.25);hero.position.y=lerp(3,-1.01,p);hero.visible=t>70.7;halos.forEach((h,i)=>{h.visible=t>=67.35&&t<72.45;h.scale.setScalar(t>69.55?(i===1?1.1:.001):1);});search.visible=t>=68.35&&t<70.3;
   pose=camera([key(64.1,[7.5,10.5,11],[0,-1.1,0],38),key(67.2,[2,11.7,11],[0,-1.1,0],38,.36),key(72.5,[5.5,8.4,12],[0,-1.1,.6],37,.42)],t);
  }else if(a.key==='predict'&&(t>=107.4&&t<112||t>=121)){
   core.visible=true;unit.position.set(t>=121?1.65:0,0,0);unit.scale.setScalar(t>=121?.82:1.15);coreCat.root.visible=t>=121;nucleus.position.y=1.4+.04*Math.sin(t*8);layers.forEach((g,k)=>{g.position.y=-.9+k*.72;const snap=move(t,t>=121?121.1:107.45,.48);g.position.y=lerp(3+k*.8,g.position.y,snap);});pose={p:[4,5.5,13.5],look:[0,0,0],fov:39};
  }
  return pose;
 }
 return{update,roots,portrait,pet,net,positions,candidates};
}
