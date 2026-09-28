import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {C,hash,lerp,type V3} from './math';
export function materials(){return{
 black:new T.MeshStandardMaterial({color:C.black,metalness:.68,roughness:.24}),
 body:new T.MeshStandardMaterial({color:0x223b43,metalness:.62,roughness:.27}),
 ceramic:new T.MeshStandardMaterial({color:C.cream,metalness:.18,roughness:.31}),
 metal:new T.MeshStandardMaterial({color:0x8ca39e,metalness:.88,roughness:.24}),
 green:new T.MeshStandardMaterial({color:0x155848,metalness:.45,roughness:.42}),
 gold:new T.MeshStandardMaterial({color:C.gold,metalness:.75,roughness:.25}),
 red:new T.MeshStandardMaterial({color:C.red,metalness:.34,roughness:.34}),
 paper:new T.MeshStandardMaterial({color:0xefe8d6,metalness:0,roughness:.72}),
 light:new T.MeshStandardMaterial({color:0x5db294,emissive:0x36c596,emissiveIntensity:.9,roughness:.3}),
 amber:new T.MeshStandardMaterial({color:0xffd69a,emissive:0xffaa48,emissiveIntensity:1.45,roughness:.35}),
 glass:new T.MeshPhysicalMaterial({color:0x97d8c5,metalness:0,roughness:.2,transparent:true,opacity:.13,depthWrite:false,side:T.DoubleSide}),
 };}
export type M=ReturnType<typeof materials>;
export function mesh(parent:T.Object3D,geo:T.BufferGeometry,mat:T.Material,p:V3=[0,0,0],shadow=false){const o=new T.Mesh(geo,mat);o.position.set(...p);o.castShadow=shadow;o.receiveShadow=true;parent.add(o);return o;}
export function box(parent:T.Object3D,size:V3,mat:T.Material,p:V3=[0,0,0],round=.05,shadow=false){return mesh(parent,round?new RoundedBoxGeometry(...size,2,Math.min(round,...size.map(v=>v*.22))):new T.BoxGeometry(...size),mat,p,shadow);}
export function ball(parent:T.Object3D,r:number,mat:T.Material,p:V3=[0,0,0],s:V3=[1,1,1]){const o=mesh(parent,new T.SphereGeometry(r,24,16),mat,p);o.scale.set(...s);return o;}
export function cylinder(parent:T.Object3D,r:number,h:number,mat:T.Material,p:V3=[0,0,0],top=r){return mesh(parent,new T.CylinderGeometry(top,r,h,48),mat,p);}
export function tube(parent:T.Object3D,points:V3[],mat:T.Material,r=.025,closed=false,segments=60){const curve=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)),closed,'catmullrom',.1);const o=mesh(parent,new T.TubeGeometry(curve,segments,r,6,closed),mat);return{o,curve};}
export function line(parent:T.Object3D,points:V3[],color=C.mint,opacity=.65){const o=new T.Line(new T.BufferGeometry().setFromPoints(points.map(p=>new T.Vector3(...p))),new T.LineBasicMaterial({color,transparent:true,opacity}));parent.add(o);return o;}
export function instances(parent:T.Object3D,geo:T.BufferGeometry,mat:T.Material,count:number){const o=new T.InstancedMesh(geo,mat,count);o.frustumCulled=false;o.instanceMatrix.setUsage(T.DynamicDrawUsage);parent.add(o);return o;}
const tmp=new T.Object3D(),axis=new T.Vector3(0,1,0),d=new T.Vector3();
export function put(o:T.InstancedMesh,i:number,p:V3,s:V3=[1,1,1],rot:V3=[0,0,0]){tmp.position.set(...p);tmp.rotation.set(...rot);tmp.scale.set(...s);tmp.updateMatrix();o.setMatrixAt(i,tmp.matrix);}
export function beam(o:T.InstancedMesh,i:number,a:V3,b:V3,r:number){d.set(b[0]-a[0],b[1]-a[1],b[2]-a[2]);tmp.position.set((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2);tmp.quaternion.setFromUnitVectors(axis,d.clone().normalize());tmp.scale.set(r,Math.max(.001,d.length()),r);tmp.updateMatrix();o.setMatrixAt(i,tmp.matrix);}
export function trace(o:T.Mesh,progress:number){const count=o.geometry.index?.count??o.geometry.attributes.position!.count;o.geometry.setDrawRange(0,Math.floor(Math.max(0,Math.min(1,progress))*count/6)*6);}
export function label(parent:T.Object3D,text:string,p:V3,width=2.5,ink='#cbe1d6',bg='transparent'){
 const c=document.createElement('canvas');c.width=1024;c.height=160;const ctx=c.getContext('2d')!;let value='';const texture=new T.CanvasTexture(c);texture.colorSpace=T.SRGBColorSpace;
 const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,depthWrite:false,depthTest:false}));sprite.position.set(...p);sprite.scale.set(width,width*160/1024,1);parent.add(sprite);
 const set=(s:string)=>{if(value===s)return;value=s;ctx.clearRect(0,0,1024,160);if(bg!=='transparent'){ctx.fillStyle=bg;ctx.fillRect(0,0,1024,160);}ctx.fillStyle=ink;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='600 100px "Microsoft YaHei",sans-serif';ctx.fillText(s,512,80,994);texture.needsUpdate=true;};set(text);return{sprite,set};
}
export function textFace(parent:T.Object3D,text:string,size:[number,number],p:V3,ink='#e6f1e7',bg='#133b3c'){
 const c=document.createElement('canvas');c.width=1024;c.height=384;const x=c.getContext('2d')!;x.fillStyle=bg;x.fillRect(0,0,1024,384);x.fillStyle=ink;x.textAlign='center';x.textBaseline='middle';x.font='600 210px "Microsoft YaHei",sans-serif';x.fillText(text,512,198,972);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return mesh(parent,new T.PlaneGeometry(...size),new T.MeshBasicMaterial({map:tex}),p);
}
export const digit7:V3[]=[[-1.2,1.15,0],[-.6,1.22,0],[.2,1.17,0],[1.12,1.23,0],[.85,.69,0],[.36,-.15,0],[-.06,-.92,0],[-.44,-1.52,0]];
export function digit(parent:T.Object3D,m:T.Material,scale=1,p:V3=[0,0,0],variation=0){const g=new T.Group();g.position.set(...p);g.scale.setScalar(scale);parent.add(g);const pts=digit7.map((v,i)=>[v[0]+(hash(i+variation*29)-.5)*variation*.17,v[1]+(hash(i+3+variation*19)-.5)*variation*.15,v[2]] as V3);const stroke=tube(g,pts,m,.13,false,72);return{root:g,stroke:stroke.o};}
export function digitTexture(i=0){const c=document.createElement('canvas');c.width=256;c.height=256;const x=c.getContext('2d')!;x.fillStyle='#e9e7dc';x.fillRect(0,0,256,256);x.strokeStyle='#17332e';x.lineWidth=10+hash(i)*6;x.lineCap='round';x.lineJoin='round';x.beginPath();digit7.forEach((p,j)=>{const xx=128+p[0]*58+(hash(i*19+j)-.5)*i*1.8,yy=124-p[1]*57+(hash(i*17+j+3)-.5)*i*1.5;if(j===0)x.moveTo(xx,yy);else x.lineTo(xx,yy);});x.stroke();x.fillStyle='#4c816e';x.font='20px monospace';x.fillText('LABEL: 7',13,235);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return tex;}
export function card(parent:T.Object3D,texture:T.Texture,p:V3=[0,0,0],scale=1,m?:M){const g=new T.Group();g.position.set(...p);g.scale.setScalar(scale);parent.add(g);if(m)box(g,[2.25,2.6,.08],m.ceramic,[0,0,-.065],.07,true);mesh(g,new T.PlaneGeometry(2.1,2.45),new T.MeshBasicMaterial({map:texture}),[0,0,0]);return g;}
export function board(parent:T.Object3D,m:M,size=12){const g=new T.Group();parent.add(g);box(g,[size,.25,size*.72],m.body,[0,-.08,0],.16,true);box(g,[size-.15,.045,size*.72-.15],m.green,[0,.076,0],.12);for(const x of [-1,1])for(const z of [-1,1]){cylinder(g,.085,.04,m.metal,[x*(size/2-.3),.12,z*(size*.36-.3)]);}return g;}
export function chip(parent:T.Object3D,m:M,scale=1,p:V3=[0,0,0]){
 const g=new T.Group();g.position.set(...p);g.scale.setScalar(scale);parent.add(g);box(g,[3.9,.18,3.9],m.black,[0,.1,0],.12,true);box(g,[3.2,.24,3.2],m.metal,[0,.32,0],.05,true);box(g,[2.83,.10,2.83],m.black,[0,.5,0],.035);
 const cores=instances(g,new T.BoxGeometry(.21,.05,.21),m.green,100);for(let i=0;i<100;i++)put(cores,i,[(i%10-4.5)*.26,.587,(Math.floor(i/10)-4.5)*.26]);cores.instanceMatrix.needsUpdate=true;
 const pins=instances(g,new T.BoxGeometry(.105,.1,.38),m.gold,64);for(let i=0;i<64;i++){const side=Math.floor(i/16),q=(i%16-7.5)*.207;put(pins,i,[side%2?(side===1?-2.03:2.03):q,.1,side%2?q:(side===0?-2.03:2.03)],[1,1,1],[0,side%2?Math.PI/2:0,0]);}pins.instanceMatrix.needsUpdate=true;
 for(let i=0;i<9;i++){const q=(i-4)*.28;line(g,[[-1.35,.61,q],[1.35,.61,q]],C.gold,.26);line(g,[[q,.61,-1.35],[q,.61,1.35]],C.mint,.22);}return{root:g,cores};
}
export function boatTexture(mode=0){const c=document.createElement('canvas');c.width=512;c.height=512;const x=c.getContext('2d')!;x.fillStyle=mode?'#102d35':'#d7e7df';x.fillRect(0,0,512,512);const path=(pts:number[][],fill:string)=>{x.beginPath();pts.forEach((p,i)=>i?x.lineTo(p[0]!,p[1]!):x.moveTo(p[0]!,p[1]!));x.closePath();if(mode===0){x.fillStyle=fill;x.fill();}else{x.strokeStyle=mode===1?'#77ddbb':'#e1b972';x.lineWidth=5;x.stroke();}};
 if(mode===0){x.fillStyle='#7db2b2';x.fillRect(0,327,512,185);}for(let i=0;i<6;i++){x.strokeStyle=mode?'#447971':'#cbe5da';x.lineWidth=3;x.beginPath();x.moveTo(25+i*11,365+i*22);x.bezierCurveTo(145,330+i*22,285,390+i*22,490,355+i*22);x.stroke();}
 path([[129,326],[382,326],[338,371],[173,371]],'#173c45');path([[247,94],[247,308],[99,308]],'#f6f2dd');path([[266,126],[383,307],[266,307]],'#dab776');x.strokeStyle=mode?'#81e3bf':'#173c45';x.lineWidth=9;x.beginPath();x.moveTo(256,84);x.lineTo(256,338);x.stroke();if(mode===2){x.fillStyle='rgba(3,32,37,.6)';x.fillRect(0,0,512,512);x.strokeStyle='#eec783';x.lineWidth=5;x.strokeRect(86,75,177,247);x.strokeRect(115,310,281,77);x.strokeRect(255,112,145,210);}if(mode===3){x.fillStyle='rgba(7,28,33,.74)';x.fillRect(0,0,512,512);x.fillStyle='#a0efca';x.textAlign='center';x.font='bold 89px "Microsoft YaHei",sans-serif';x.fillText('帆船',256,278);}const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return tex;}
export function pen(parent:T.Object3D,m:M){const g=new T.Group();parent.add(g);const body=cylinder(g,.12,2.9,m.black,[0,1.6,0]);const band=cylinder(g,.125,.25,m.gold,[0,.45,0]);const tip=mesh(g,new T.ConeGeometry(.12,.62,24),m.metal,[0,.025,0]);tip.rotation.z=Math.PI;ball(g,.045,m.amber,[0,-.31,0]);return{root:g,body,band};}
export function disposeTree(root:T.Object3D){const geo=new Set<T.BufferGeometry>(),mats=new Set<T.Material>(),tex=new Set<T.Texture>();root.traverse(o=>{const a=o as T.Mesh;if(a.geometry)geo.add(a.geometry);if(a.material)for(const m of Array.isArray(a.material)?a.material:[a.material]){mats.add(m);for(const v of Object.values(m))if(v instanceof T.Texture)tex.add(v);}});tex.forEach(t=>t.dispose());mats.forEach(m=>m.dispose());geo.forEach(g=>g.dispose());root.clear();}
export const onCurve=(curve:T.CatmullRomCurve3,p:number):V3=>{const v=curve.getPoint(Math.max(0,Math.min(1,p)));return[v.x,v.y,v.z];};
export function orbitPoints(r:number,y=0,n=80):V3[]{return Array.from({length:n},(_,i)=>[Math.cos(i/(n-1)*Math.PI*2)*r,y,Math.sin(i/(n-1)*Math.PI*2)*r] as V3);}
export function mixColor(a:number,b:number,p:number){return new T.Color(a).lerp(new T.Color(b),lerp(0,1,p));}
