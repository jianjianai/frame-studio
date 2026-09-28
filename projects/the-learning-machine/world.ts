import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { hash, type V3 } from './timeline';
export const palette = { ivory:0xe9efe9, silver:0xa7b8b5, dark:0x17343c, teal:0x398c80, light:0x8af7d8, gold:0xf3b969, red:0xca6557 };
export const materials = () => ({
  ivory:new T.MeshStandardMaterial({color:palette.ivory,roughness:.31,metalness:.15}),
  silver:new T.MeshStandardMaterial({color:palette.silver,roughness:.26,metalness:.74}),
  dark:new T.MeshStandardMaterial({color:palette.dark,roughness:.29,metalness:.52}),
  teal:new T.MeshStandardMaterial({color:palette.teal,roughness:.28,metalness:.4}),
  glow:new T.MeshBasicMaterial({color:palette.light}),
  gold:new T.MeshStandardMaterial({color:palette.gold,roughness:.24,metalness:.58,emissive:0x553111,emissiveIntensity:.17}),
  red:new T.MeshStandardMaterial({color:palette.red,roughness:.4,metalness:.1}),
  paper:new T.MeshStandardMaterial({color:0xf4eedf,roughness:.72,metalness:0}),
});
export type Mats = ReturnType<typeof materials>;
export function mesh(g:T.Object3D, geo:T.BufferGeometry, mat:T.Material, p:V3=[0,0,0], shadow=false) { const m=new T.Mesh(geo,mat); m.position.set(...p); m.castShadow=shadow; m.receiveShadow=true; g.add(m); return m; }
export function box(g:T.Object3D,w:number,h:number,d:number,mat:T.Material,p:V3=[0,0,0],r=.06,shadow=false) { return mesh(g,r>0?new RoundedBoxGeometry(w,h,d,2,Math.min(r,w*.24,h*.24,d*.24)):new T.BoxGeometry(w,h,d),mat,p,shadow); }
export function ball(g:T.Object3D,r:number,mat:T.Material,p:V3=[0,0,0],shadow=false) { return mesh(g,new T.SphereGeometry(r,20,12),mat,p,shadow); }
export function cyl(g:T.Object3D,r:number,h:number,mat:T.Material,p:V3=[0,0,0],rTop=r) { return mesh(g,new T.CylinderGeometry(rTop,r,h,32),mat,p); }
export function tube(g:T.Object3D, pts:V3[], mat:T.Material, r=.035, closed=false) { const curve=new T.CatmullRomCurve3(pts.map(p=>new T.Vector3(...p)),closed); return mesh(g,new T.TubeGeometry(curve,Math.max(16,pts.length*8),r,5,closed),mat); }
export function line(g:T.Object3D,pts:V3[],color=palette.teal,opacity=.4) { const m=new T.Line(new T.BufferGeometry().setFromPoints(pts.map(p=>new T.Vector3(...p))),new T.LineBasicMaterial({color,transparent:opacity<1,opacity}));g.add(m);return m; }
export function inst(g:T.Object3D,geo:T.BufferGeometry,mat:T.Material,count:number) { const m=new T.InstancedMesh(geo,mat,count);m.instanceMatrix.setUsage(T.DynamicDrawUsage);m.frustumCulled=false;g.add(m);return m; }
const temp=new T.Object3D();
export function put(m:T.InstancedMesh,i:number,p:V3,s:V3=[1,1,1],rotation:V3=[0,0,0]) { temp.position.set(...p);temp.scale.set(...s);temp.rotation.set(...rotation);temp.updateMatrix();m.setMatrixAt(i,temp.matrix); }
export function sprite(g:T.Object3D,text:string,p:V3,width=3,color='#17343c',bg='rgba(0,0,0,0)') {
  const c=document.createElement('canvas');c.width=1024;c.height=180;const x=c.getContext('2d')!;x.fillStyle=bg;x.fillRect(0,0,c.width,c.height);x.fillStyle=color;x.font='500 64px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,512,90,990);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;const s=new T.Sprite(new T.SpriteMaterial({map:tex,depthWrite:false}));s.position.set(...p);s.scale.set(width,width*180/1024,1);g.add(s);return s;
}
export function word(g:T.Object3D,text:string,p:V3,m:Mats,width=2.5) {
  const root=new T.Group();root.position.set(...p);g.add(root);box(root,width,.38,1.2,m.ivory,[0,0,0],.12,true);
  const c=document.createElement('canvas');c.width=768;c.height=256;const x=c.getContext('2d')!;x.fillStyle='#ecf2ec';x.fillRect(0,0,768,256);x.font='600 136px "Microsoft YaHei",sans-serif';x.fillStyle='#17463d';x.textAlign='center';x.textBaseline='middle';x.fillText(text,384,132,730);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;
  const label=mesh(root,new T.PlaneGeometry(width*.92,1.02),new T.MeshBasicMaterial({map:tex}),[0,.198,0]);label.rotation.x=-Math.PI/2;return root;
}
export function chip(g:T.Object3D,m:Mats,scale=1,p:V3=[0,0,0]) {
 const root=new T.Group();root.position.set(...p);root.scale.setScalar(scale);g.add(root);
 box(root,8,.2,6,m.teal,[0,.1,0],.07,true);box(root,3.8,.23,3.8,m.dark,[0,.34,0],.12,true);box(root,3.3,.28,3.3,m.silver,[0,.6,0],.08,true);box(root,2.7,.07,2.7,m.dark,[0,.78,0],.03);
 for(let i=0;i<8;i++){const a=i*Math.PI/4;const x=Math.cos(a)*2.9,z=Math.sin(a)*2.1;box(root,.75,.24,.62,m.dark,[x,.32,z],.03);line(root,[[x,.26,z],[x,.26,Math.sign(z)*2.75],[Math.sign(x)*3.7,.26,Math.sign(z)*2.75]],palette.gold,.85);}
 for(let i=0;i<16;i++){const v=(i-7.5)*.19;box(root,.085,.08,.35,m.gold,[v,.34,2.04],.01);box(root,.085,.08,.35,m.gold,[v,.34,-2.04],.01);box(root,.35,.08,.085,m.gold,[2.04,.34,v],.01);box(root,.35,.08,.085,m.gold,[-2.04,.34,v],.01);}
 for(const x of [-3.6,3.6])for(const z of [-2.6,2.6])cyl(root,.105,.07,m.silver,[x,.25,z]);
 const cells=inst(root,new T.BoxGeometry(.145,.04,.145),m.glow,144);for(let i=0;i<144;i++)put(cells,i,[((i%12)-5.5)*.205,.84,(Math.floor(i/12)-5.5)*.205]);cells.instanceMatrix.needsUpdate=true;
 return {root,cells};
}
export function serverField(g:T.Object3D,m:Mats,rows=12,cols=10) {
 const root=new T.Group();g.add(root);const n=rows*cols;const bodies=inst(root,new T.BoxGeometry(1.7,3.8,2.25),m.dark,n);const faces=inst(root,new T.BoxGeometry(1.54,.24,.05),m.silver,n*7);const lamps=inst(root,new T.BoxGeometry(.46,.055,.065),m.glow,n*7);const positions:V3[]=[];
 for(let i=0;i<n;i++){const c=i%cols,r=Math.floor(i/cols);const x=(c-(cols-1)/2)*3.45+(c<cols/2?-3:3),z=11-r*3.45;positions.push([x,1.92,z]);put(bodies,i,[x,1.92,z]);for(let j=0;j<7;j++){put(faces,i*7+j,[x,.5+j*.48,z+1.151]);put(lamps,i*7+j,[x-.41,.5+j*.48,z+1.192]);}}
 bodies.instanceMatrix.needsUpdate=true;faces.instanceMatrix.needsUpdate=true;lamps.instanceMatrix.needsUpdate=true;
 const packets=inst(root,new T.BoxGeometry(.14,.07,.75),m.glow,80);
 function update(t:number) {for(let i=0;i<80;i++){const lane=i%8,x=(lane-3.5)*.5;put(packets,i,[x,.08,16-((t*9+i*1.87)%65)]);}packets.instanceMatrix.needsUpdate=true;}
 return {root,bodies,faces,lamps,positions,update};
}
export function cat(g:T.Object3D,m:Mats,p:V3=[0,0,0],scale=1) {
 const root=new T.Group();root.position.set(...p);root.scale.setScalar(scale);g.add(root);
 const body=ball(root,.66,m.paper,[0,.8,0],true);body.scale.set(.8,1.15,.83);const head=new T.Group();root.add(head);head.position.y=1.64;const face=ball(head,.56,m.paper,[0,0,0],true);face.scale.set(1,.91,.88);
 for(const side of [-1,1]){const ear=mesh(head,new T.ConeGeometry(.27,.63,3),m.paper,[side*.35,.46,0],true);ear.rotation.z=-side*.2;const eye=ball(head,.064,m.dark,[side*.21,.07,.455]);eye.scale.set(1,1.1,.4);ball(head,.018,m.glow,[side*.22,.088,.48]);const foot=ball(root,.2,m.paper,[side*.3,.18,.29]);foot.scale.set(.8,.65,1.3);}
 const nose=ball(head,.047,m.red,[0,-.06,.5]);nose.scale.y=.7;for(const side of [-1,1])for(let j=0;j<3;j++)line(head,[[side*.17,-.09,.48],[side*.64,-.11+(j-1)*.12,.35]],palette.dark,.5);
 const tail=new T.Group();root.add(tail);tube(tail,[[0,.5,-.4],[.7,.6,-.7],[1.02,1.05,-.5],[.93,1.48,-.35]],m.paper,.13);return {root,head,tail};
}
export function gear(g:T.Object3D,m:T.Material,r=1,teeth=18,p:V3=[0,0,0]) {
 const sh=new T.Shape();for(let j=0;j<teeth*4;j++){const a=j/(teeth*4)*Math.PI*2;const rr=r*(j%4===0||j%4===3?.87:1);const x=Math.cos(a)*rr,y=Math.sin(a)*rr;if(j===0)sh.moveTo(x,y);else sh.lineTo(x,y);}sh.closePath();const hole=new T.Path();hole.absarc(0,0,r*.36,0,Math.PI*2,true);sh.holes.push(hole);const geo=new T.ExtrudeGeometry(sh,{depth:.24,bevelEnabled:true,bevelSize:.025,bevelThickness:.025,bevelSegments:1,steps:1});geo.translate(0,0,-.12);return mesh(g,geo,m,p);
}
export function chessKing(g:T.Object3D,m:T.Material,p:V3=[0,0,0],scale=1) {
 const root=new T.Group();root.position.set(...p);root.scale.setScalar(scale);g.add(root);const pts=[[.65,0],[.7,.12],[.57,.3],[.39,.4],[.23,1.2],[.45,1.38],[.42,1.58],[.25,1.7]].map(v=>new T.Vector2(v[0]!,v[1]!));mesh(root,new T.LatheGeometry(pts,32),m,[0,0,0],true);box(root,.12,.62,.14,m,[0,1.99,0],.02);box(root,.45,.12,.14,m,[0,2.07,0],.02);return root;
}
export function disposeTree(root:T.Object3D) {
 const geos=new Set<T.BufferGeometry>(),mats=new Set<T.Material>(),textures=new Set<T.Texture>();root.traverse(o=>{const x=o as T.Mesh;if(x.geometry)geos.add(x.geometry);if(x.material){const list=Array.isArray(x.material)?x.material:[x.material];for(const mat of list){mats.add(mat);for(const v of Object.values(mat))if(v instanceof T.Texture)textures.add(v);}}});for(const t of textures)t.dispose();for(const m of mats)m.dispose();for(const g of geos)g.dispose();root.clear();
}
export function noiseCity(g:T.Object3D,m:Mats,count=300) {
 const b=inst(g,new T.BoxGeometry(1,1,1),m.ivory,count),lights=inst(g,new T.BoxGeometry(1,.03,1),m.glow,count);const homes:V3[]=[];
 for(let i=0;i<count;i++){let x=(i%20-9.5)*3.2,z=(Math.floor(i/20)-7)*3.2;if(Math.abs(x)<5&&Math.abs(z)<5)z-=12;const h=.8+hash(i+2)*4;put(b,i,[x,h*.5,z],[1.5,h,1.5]);put(lights,i,[x,h+.03,z],[1.54,1,1.54]);homes.push([x,h,z]);}b.instanceMatrix.needsUpdate=true;lights.instanceMatrix.needsUpdate=true;return {b,lights,homes};
}
