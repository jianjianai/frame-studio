import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import type {V3} from './time';
export function makeMaterials(){return{
 orange:new T.MeshStandardMaterial({color:0xe49649,roughness:.31,metalness:.04}),
 stripe:new T.MeshStandardMaterial({color:0xb95428,roughness:.45}),
 cream:new T.MeshStandardMaterial({color:0xffeaca,roughness:.36}),
 teal:new T.MeshStandardMaterial({color:0x238c7a,roughness:.29,metalness:.3}),
 dark:new T.MeshStandardMaterial({color:0x112c33,roughness:.26,metalness:.48}),
 ivory:new T.MeshStandardMaterial({color:0xf5f0e3,roughness:.27,metalness:.12}),
 metal:new T.MeshStandardMaterial({color:0x97b5ae,roughness:.24,metalness:.8}),
 gold:new T.MeshStandardMaterial({color:0xf6b147,roughness:.25,metalness:.54}),
 red:new T.MeshStandardMaterial({color:0xc63a37,roughness:.28,metalness:.08}),
 glow:new T.MeshBasicMaterial({color:0x50f1be}),
 light:new T.MeshBasicMaterial({color:0xffc960}),
 glass:new T.MeshStandardMaterial({color:0xb3e5d3,transparent:true,opacity:.16,depthWrite:false,roughness:.14,metalness:.2}),
 };}
export type Mats=ReturnType<typeof makeMaterials>;
export function mesh(g:T.Object3D,geo:T.BufferGeometry,mat:T.Material,p:V3=[0,0,0],shadow=true){const o=new T.Mesh(geo,mat);o.position.set(...p);o.castShadow=shadow;o.receiveShadow=true;g.add(o);return o;}
export function box(g:T.Object3D,size:V3,mat:T.Material,p:V3=[0,0,0],r=.08){return mesh(g,new RoundedBoxGeometry(...size,2,Math.min(r,...size.map(v=>v*.23))),mat,p);}
export function sphere(g:T.Object3D,r:number,mat:T.Material,p:V3=[0,0,0],scale:V3=[1,1,1]){const o=mesh(g,new T.SphereGeometry(r,32,20),mat,p);o.scale.set(...scale);return o;}
export function tube(g:T.Object3D,pts:V3[],mat:T.Material,r=.035){const curve=new T.CatmullRomCurve3(pts.map(p=>new T.Vector3(...p)));return mesh(g,new T.TubeGeometry(curve,Math.max(24,pts.length*10),r,8,false),mat);}
export function ring(g:T.Object3D,r:number,mat:T.Material,p:V3=[0,0,0],thickness=.04){return mesh(g,new T.TorusGeometry(r,thickness,8,64),mat,p,false);}
export function instance(g:T.Object3D,geo:T.BufferGeometry,mat:T.Material,n:number){const o=new T.InstancedMesh(geo,mat,n);o.frustumCulled=false;o.instanceMatrix.setUsage(T.DynamicDrawUsage);g.add(o);return o;}
const dummy=new T.Object3D();const axis=new T.Vector3(0,1,0),delta=new T.Vector3();
export function put(o:T.InstancedMesh,i:number,p:V3,s:V3=[1,1,1],r:V3=[0,0,0]){dummy.position.set(...p);dummy.rotation.set(...r);dummy.scale.set(...s);dummy.updateMatrix();o.setMatrixAt(i,dummy.matrix);}
export function beam(o:T.InstancedMesh,i:number,a:V3,b:V3,r:number){delta.set(b[0]-a[0],b[1]-a[1],b[2]-a[2]);dummy.position.set((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2);dummy.quaternion.setFromUnitVectors(axis,delta.clone().normalize());dummy.scale.set(r,delta.length(),r);dummy.updateMatrix();o.setMatrixAt(i,dummy.matrix);}
export function labelPlane(g:T.Object3D,text:string,w:number,h:number,p:V3,fg='#f9f1db',bg='#143d40'){
 const c=document.createElement('canvas');c.width=768;c.height=256;const x=c.getContext('2d')!;x.fillStyle=bg;x.fillRect(0,0,768,256);x.fillStyle=fg;x.font='600 128px "Microsoft YaHei",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,384,132,714);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return mesh(g,new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({map:tex}),p,false);
}
export function cat(g:T.Object3D,m:Mats){
 const root=new T.Group(),model=new T.Group();g.add(root);root.add(model);model.position.y=-1.7;
 sphere(model,.83,m.orange,[0,1.13,-.04],[.9,1.21,.77]);sphere(model,.62,m.cream,[0,1.17,.37],[.65,.98,.43]);
 for(const side of [-1,1]){sphere(model,.3,m.orange,[side*.43,.26,.38],[1,.6,1.25]);sphere(model,.22,m.cream,[side*.42,.26,.6],[1,.6,.75]);sphere(model,.21,m.orange,[side*.57,1.0,.39],[.86,2.9,.9]);}
 const head=new T.Group();model.add(head);head.position.set(0,2.43,.09);sphere(head,.88,m.orange,[0,0,0],[1,.87,.83]);
 for(const side of [-1,1]){
  const sh=new T.Shape();sh.moveTo(-.34,0);sh.quadraticCurveTo(-.34,.18,-.21,.78);sh.quadraticCurveTo(-.15,.94,.01,.72);sh.lineTo(.34,0);sh.closePath();const ear=mesh(head,new T.ExtrudeGeometry(sh,{depth:.3,bevelEnabled:true,bevelThickness:.075,bevelSize:.075,bevelSegments:3,steps:1}),m.orange,[side*.56,.46,-.16]);ear.rotation.z=-side*.16;
  const inside=mesh(head,new T.ConeGeometry(.16,.49,3),m.stripe,[side*.59,.78,.14]);inside.rotation.z=-side*.15;
  sphere(head,.255,m.cream,[side*.22,-.25,.62],[1,.75,.54]);
  const eye=sphere(head,.186,m.dark,[side*.35,.08,.695],[1,.87,.27]);eye.name='eye-'+side;
  sphere(head,.031,m.ivory,[side*.39,.14,.751],[1,1,.4]);
  for(let j=0;j<3;j++)tube(head,[[side*.34,-.22,.705],[side*.69,-.23+(j-1)*.12,.72],[side*1.04,-.2+(j-1)*.18,.67]],m.dark,.017);
  const brow=tube(head,[[side*.17,.35,.62],[side*.34,.4,.63],[side*.5,.37,.57]],m.stripe,.034);brow.rotation.z=side*.08;
 }
 const nose=mesh(head,new T.ConeGeometry(.086,.11,3),m.stripe,[0,-.17,.801]);nose.rotation.z=Math.PI;
 tube(head,[[0,-.19,.805],[0,-.31,.802],[-.12,-.34,.771]],m.dark,.015);tube(head,[[0,-.29,.802],[.12,-.34,.771]],m.dark,.015);
 for(let j=-1;j<=1;j++)tube(head,[[j*.19,.66,.48],[j*.15,.49,.62],[j*.11,.39,.65]],m.stripe,.055);
 const tail=new T.Group();model.add(tail);tube(tail,[[.2,.56,-.5],[1.13,.45,-.4],[1.47,.75,.05],[1.39,1.29,.3],[1.12,1.53,.36]],m.orange,.18);tube(tail,[[1.39,1.29,.3],[1.25,1.47,.35],[1.12,1.53,.36]],m.stripe,.184);
 return{root,head,tail,model};
}
export function drawCat(x:CanvasRenderingContext2D,size=256,mode=0){
 x.save();x.scale(size/256,size/256);x.clearRect(0,0,256,256);x.fillStyle=mode===1?'#102f35':'#e9e3d6';x.fillRect(0,0,256,256);
 x.strokeStyle=mode===1?'#75eec9':'#b45e30';x.fillStyle=mode===1?'#102f35':'#eda252';x.lineWidth=5;x.lineJoin='round';x.beginPath();x.moveTo(52,103);x.lineTo(45,29);x.quadraticCurveTo(47,17,63,38);x.lineTo(92,64);x.quadraticCurveTo(130,49,165,63);x.lineTo(197,32);x.quadraticCurveTo(211,18,210,37);x.lineTo(205,105);x.quadraticCurveTo(226,151,189,192);x.quadraticCurveTo(156,225,101,213);x.quadraticCurveTo(47,202,43,158);x.quadraticCurveTo(38,123,52,103);x.closePath();if(mode!==1)x.fill();x.stroke();
 x.strokeStyle=mode===1?'#75eec9':'#243c3b';x.lineWidth=6;for(const s of [-1,1]){x.beginPath();x.ellipse(128+s*42,133,11,15,0,0,Math.PI*2);if(mode!==1){x.fillStyle='#183538';x.fill();}else x.stroke();for(let j=-1;j<=1;j++){x.beginPath();x.moveTo(128+s*42,169);x.lineTo(128+s*104,168+j*19);x.stroke();}}
 x.fillStyle=mode===1?'#75eec9':'#b45e30';x.beginPath();x.moveTo(119,158);x.lineTo(137,158);x.lineTo(128,169);x.closePath();x.fill();x.beginPath();x.moveTo(128,168);x.lineTo(128,181);x.stroke();x.restore();
}
export function featureTexture(mode:number){const c=document.createElement('canvas');c.width=256;c.height=256;const x=c.getContext('2d')!;drawCat(x,256,mode===1?1:0);if(mode===2){x.fillStyle='rgba(10,50,53,.81)';x.fillRect(0,0,256,256);x.strokeStyle='#f4bd62';x.lineWidth=5;for(const [xx,yy,w,h]of[[40,22,52,72],[164,22,54,73],[72,108,32,45],[156,108,32,45],[100,149,57,47]])x.strokeRect(xx!,yy!,w!,h!);}if(mode===3){x.fillStyle='rgba(240,234,219,.58)';x.fillRect(0,0,256,256);x.strokeStyle='#208c73';x.lineWidth=4;for(let i=0;i<7;i++){x.beginPath();x.moveTo(45,47+i*27);x.lineTo(212,47+i*27);x.stroke();}x.fillStyle='#16423d';x.font='bold 56px "Microsoft YaHei",sans-serif';x.textAlign='center';x.fillText('猫',128,151);}const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return tex;}
export function dispose(root:T.Object3D){const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();root.traverse(o=>{const q=o as T.Mesh;if(q.geometry)geometries.add(q.geometry);if(q.material){for(const mat of Array.isArray(q.material)?q.material:[q.material]){materials.add(mat);for(const v of Object.values(mat))if(v instanceof T.Texture)textures.add(v);}}});textures.forEach(x=>x.dispose());materials.forEach(x=>x.dispose());geometries.forEach(x=>x.dispose());root.clear();}
