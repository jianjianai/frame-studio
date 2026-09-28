import * as T from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import type {Scene,SceneOptions} from '../../../src/engine/types';
import {makeMaterials,dispose} from './forms';
import {makeSets} from './sets';
import {drawEarly} from './early';
import {drawLate} from './late';
import {actAt,shotAt,acts,clamp,move,color,DURATION} from './time';
import {mono} from './ink';

/** The scene is a pure source-time drawing. All transforms are recomputed for cold seeks. */
export function createScene({width,height,quality}:SceneOptions):Scene{
 const output=document.createElement('canvas');output.width=width;output.height=height;
 const c=output.getContext('2d',{alpha:false});if(!c)throw new Error('2D compositing unavailable');
 const renderer=new T.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(1);renderer.setSize(width,height);renderer.outputColorSpace=T.SRGBColorSpace;
 renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(38,width/height,.05,100),materials=makeMaterials();
 const background=new T.Color(color.night);scene.background=background;scene.fog=new T.Fog(color.night,24,60);
 const hemi=new T.HemisphereLight(0xfff5e1,0x18383a,1.35);scene.add(hemi);
 const key=new T.DirectionalLight(0xfff0d5,3.2);key.position.set(-5,10,12);key.castShadow=true;key.shadow.mapSize.setScalar(quality==='draft'?768:1536);key.shadow.camera.left=-12;key.shadow.camera.right=12;key.shadow.camera.top=10;key.shadow.camera.bottom=-10;key.shadow.camera.near=.5;key.shadow.camera.far=45;key.shadow.bias=-.00018;key.shadow.normalBias=.025;scene.add(key);
 const rim=new T.DirectionalLight(0x8aecd1,2.4);rim.position.set(9,4,-7);scene.add(rim);
 const fill=new T.DirectionalLight(0xd7e9ff,.6);fill.position.set(8,2,14);scene.add(fill);
 const floorMaterial=new T.MeshStandardMaterial({color:0x12333a,roughness:.82,metalness:.05});
 const floor=new T.Mesh(new T.PlaneGeometry(100,100),floorMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-3.58;floor.receiveShadow=true;scene.add(floor);
 let environment:T.WebGLRenderTarget|undefined;let sets:ReturnType<typeof makeSets>;let destroyed=false;let sourceTime=0;
 try{const room=new RoomEnvironment(),pmrem=new T.PMREMGenerator(renderer);environment=pmrem.fromScene(room,.03);scene.environment=environment.texture;scene.environmentIntensity=.48;dispose(room);pmrem.dispose();sets=makeSets(scene,materials);}catch(e){dispose(scene);environment?.dispose();renderer.dispose();renderer.forceContextLoss();throw e;}
 const worldPoint=new T.Vector3();
 function render(input:number){
  if(destroyed)return;const t=clamp(input,0,DURATION),act=actAt(t);sourceTime=t;
  const dark=['hook','learn','go','predict','outro'].includes(act.key);
  background.set(dark?color.night:color.paper);(scene.fog as T.Fog).color.copy(background);floorMaterial.color.set(dark?'#0c2c33':'#e3ded1');hemi.intensity=dark?.9:1.2;key.intensity=dark?3.0:2.35;fill.intensity=dark?.42:.6;
  const pose=sets.update(t);camera.position.set(...pose.p);camera.lookAt(...pose.look);camera.fov=pose.fov;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  renderer.render(scene,camera);c!.globalAlpha=1;c!.drawImage(renderer.domElement,0,0,width,height);c!.save();c!.scale(width/1920,height/1080);
  // Directional falloff keeps diagram labels legible without an empty infinite grid.
  const vignette=c!.createRadialGradient(730,475,280,880,490,1300);vignette.addColorStop(0,'rgba(0,0,0,0)');vignette.addColorStop(1,dark?'rgba(0,6,14,.26)':'rgba(72,62,37,.045)');c!.fillStyle=vignette;c!.fillRect(0,0,1920,1080);
  const P=(p:[number,number,number]):[number,number]=>{worldPoint.set(...p).project(camera);return[(worldPoint.x*.5+.5)*1920,(-worldPoint.y*.5+.5)*1080];};
  if(!drawEarly(c!,t,P))drawLate(c!,t,P);
  const muted=dark?'#91b9ad':'#72877b';mono(c!,'FRAME / AI 的三道题',84,58,18,muted);mono(c!,'RULES → LEARNING → COLLABORATION',1836,58,16,muted,'right');
  if(act.key!=='hook'&&act.key!=='outro'){mono(c!,act.year,1836,103,18,muted,'right');}
  const active=acts.indexOf(act);for(let i=0;i<acts.length;i++){c!.fillStyle=i===active?(dark?color.orange:color.ink):(dark?'#275052':'#c9cfc2');c!.fillRect(84+i*31,1030,i===active?24:13,3);}
  mono(c!,`${String(shotAt(t)+1).padStart(2,'0')} / 36`,390,1032,14,muted);
  if(t>27.1&&t<126)mono(c!,'教学示意 / 非模型实测',1836,1031,14,muted,'right');
  // Two frames of directional aperture bridge only act changes; no long dissolves.
  const boundary=acts.find(a=>a.at>0&&t>=a.at&&t<a.at+.19);
  if(boundary){const p=move(t,boundary.at,.19);c!.fillStyle=dark?color.paper:color.night;c!.beginPath();c!.moveTo(1920*p-220,0);c!.lineTo(1920,0);c!.lineTo(1920,1080);c!.lineTo(1920*p+60,1080);c!.closePath();c!.globalAlpha=(1-p)*.48;c!.fill();c!.globalAlpha=1;}
  if(t>152.6){c!.globalAlpha=move(t,152.6,1);c!.fillStyle=color.night;c!.fillRect(0,0,1920,1080);c!.globalAlpha=1;}
  c!.restore();
 }
 return{canvas:output,render,dispose(){if(destroyed)return;destroyed=true;dispose(scene);environment?.dispose();for(const mat of Object.values(materials))mat.dispose();renderer.dispose();renderer.forceContextLoss();output.width=1;output.height=1;},debug:{parameters(){return{};},setParameters(){},diagnostics(){return{time:sourceTime,act:actAt(sourceTime).key,shot:shotAt(sourceTime),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles};}}};
}
