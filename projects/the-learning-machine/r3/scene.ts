import * as T from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import type {Scene,SceneOptions} from '../../../src/engine/types';
import {materials,disposeTree} from './geometry';
import {opening,rules,learning} from './acts-foundations';
import {vision,decision,attention} from './acts-breakthroughs';
import {generation,reliability,finale} from './acts-futures';
import {DURATION,cueAt,SCENES,sceneAt} from './timeline';
import {C,clamp,ramp} from './math';
import type {Rig,Annotation} from './rig-types';

const FONT='"Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
/** R3 uses one absolute-time scene for playback, reverse seeks and offline export. */
export function createScene({width,height,quality}:SceneOptions):Scene{
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('Canvas compositing is unavailable.');
 const renderer=new T.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(1);renderer.setSize(width,height);renderer.outputColorSpace=T.SRGBColorSpace;
 renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
 const scene=new T.Scene();scene.background=new T.Color(C.ink);scene.fog=new T.Fog(C.ink,31,92);
 const camera=new T.PerspectiveCamera(40,width/height,.08,220),m=materials();
 const hemi=new T.HemisphereLight(0xcceada,0x13232e,.75);scene.add(hemi);
 const key=new T.DirectionalLight(0xffe6bd,3.35);key.position.set(-9,15,14);key.castShadow=true;key.shadow.mapSize.setScalar(quality==='draft'?1024:2048);key.shadow.camera.left=-23;key.shadow.camera.right=23;key.shadow.camera.top=20;key.shadow.camera.bottom=-20;key.shadow.camera.near=.5;key.shadow.camera.far=90;key.shadow.bias=-.00016;key.shadow.normalBias=.018;key.shadow.radius=2.4;scene.add(key);
 const rim=new T.DirectionalLight(0x77ddbd,2.05);rim.position.set(11,8,-10);scene.add(rim);
 const fill=new T.DirectionalLight(0xc4d7ff,.58);fill.position.set(2,4,16);scene.add(fill);
 const kick=new T.PointLight(0x97ffd3,23,19,2);kick.position.set(0,5,1);scene.add(kick);
 const floorMat=new T.MeshStandardMaterial({color:0x142c33,metalness:.3,roughness:.48});
 const floor=new T.Mesh(new T.PlaneGeometry(220,220),floorMat);floor.rotation.x=-Math.PI/2;floor.position.y=-2.92;floor.receiveShadow=true;scene.add(floor);
 const composer=new EffectComposer(renderer);composer.setSize(width,height);const renderPass=new RenderPass(scene,camera);const bloom=new UnrealBloomPass(new T.Vector2(width,height),.10,.25,3.15);const output=new OutputPass();composer.addPass(renderPass);composer.addPass(bloom);composer.addPass(output);
 let env:T.WebGLRenderTarget|undefined;let rigs:Rig[]=[];let destroyed=false;let currentTime=0;
 try{
  const room=new RoomEnvironment(),pmrem=new T.PMREMGenerator(renderer);env=pmrem.fromScene(room,.04);scene.environment=env.texture;scene.environmentIntensity=.44;disposeTree(room);pmrem.dispose();
  rigs=[opening(m),rules(m),learning(m),vision(m),decision(m),attention(m),generation(m),reliability(m),finale(m)];for(const rig of rigs){rig.root.visible=false;scene.add(rig.root);}
 }catch(error){disposeTree(scene);env?.dispose();bloom.dispose();output.dispose();composer.dispose();renderer.dispose();renderer.forceContextLoss();throw error;}
 const projection=new T.Vector3(),day=new T.Color(0xd9e1d9),night=new T.Color(C.ink);
 function annotation(note:Annotation,light:boolean){
  projection.set(...note.position).project(camera);if(projection.z>1||projection.z<-1)return;
  const px=(projection.x*.5+.5)*1920,py=(-projection.y*.5+.5)*1080;
  const size=note.size??27;ctx!.font=`500 ${size}px ${FONT}`;
  const textWidth=ctx!.measureText(note.text).width;
  const x=clamp(px+(note.dx??0),90+textWidth*.5,1830-textWidth*.5),y=clamp(py+(note.dy??0),175+size*.5,859-size*.5);
  if(Math.hypot(x-px,y-py)>48){ctx!.strokeStyle=light?'rgba(57,95,79,.45)':'rgba(143,197,173,.40)';ctx!.lineWidth=1.5;ctx!.beginPath();ctx!.moveTo(clamp(px,65,1855),clamp(py,135,875));ctx!.lineTo(x,y-size*.66);ctx!.stroke();}
  ctx!.fillStyle=note.color??(light?'#315c4c':'#c0e0cd');ctx!.textAlign='center';ctx!.textBaseline='middle';ctx!.shadowColor=light?'rgba(228,239,224,.9)':'rgba(6,21,29,.95)';ctx!.shadowBlur=5;ctx!.fillText(note.text,x,y);ctx!.shadowBlur=0;
 }
 function render(input:number){
  if(destroyed)return;const{t,i,u}=cueAt(input);currentTime=t;const index=sceneAt(i);rigs.forEach((r,j)=>r.root.visible=j===index);
  const view=rigs[index]!.update(i,u,t),light=view.light===true;
  (scene.background as T.Color).copy(light?day:night);(scene.fog as T.Fog).color.copy(scene.background as T.Color);
  floorMat.color.set(light?0xcbd5c9:0x102a31);floor.visible=i!==0;hemi.intensity=light?1.1:.70;key.intensity=light?1.85:2.15;fill.intensity=light?.70:.48;rim.intensity=light?1.05:1.40;scene.environmentIntensity=light?.44:.42;kick.intensity=light?2:7;bloom.strength=light?.045:.10;
  camera.position.set(...view.pose.eye);camera.lookAt(...view.pose.aim);camera.fov=view.pose.fov;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  composer.render();ctx!.globalAlpha=1;ctx!.drawImage(renderer.domElement,0,0,width,height);ctx!.save();ctx!.scale(width/1920,height/1080);
  const darkInk=light?'#476955':'#90b6a3';const vignette=ctx!.createRadialGradient(960,480,400,960,510,1240);vignette.addColorStop(0,'rgba(0,0,0,0)');vignette.addColorStop(1,light?'rgba(10,26,20,.06)':'rgba(0,6,17,.25)');ctx!.fillStyle=vignette;ctx!.fillRect(0,0,1920,1080);
  ctx!.font='500 18px Consolas,monospace';ctx!.textAlign='left';ctx!.textBaseline='middle';ctx!.fillStyle=darkInk;ctx!.fillText('FRAME  /  THE LONG ROAD TO AI',70,48);ctx!.textAlign='right';ctx!.fillText(SCENES[index]!.year,1850,48);
  if(view.tag){ctx!.font=`500 23px ${FONT}`;ctx!.textAlign='left';ctx!.fillStyle=darkInk;ctx!.fillText(view.tag,72,99);}
  for(const note of view.notes??[])annotation(note,light);
  if(view.title){
   const p=ramp(u,.23,.38);ctx!.globalAlpha=p;
   if(i===2){ctx!.textAlign='center';ctx!.font=`600 78px ${FONT}`;ctx!.fillStyle='#edf3df';ctx!.fillText('不是突然变聪明',960,182);ctx!.font=`400 25px ${FONT}`;ctx!.fillStyle='#a3c4b0';ctx!.fillText('人工智能，走过七十年的路',960,245);}
   else{ctx!.textAlign='left';ctx!.fillStyle='#e3eddb';ctx!.font=`500 53px ${FONT}`;ctx!.fillText('让能力，',1060,263);ctx!.fillStyle='#e5bc7c';ctx!.font=`600 52px ${FONT}`;ctx!.fillText('指向值得解决的问题。',1060,343);}
   ctx!.globalAlpha=1;
  }
  if(i===31&&u>.45){const p=ramp(u,.45,.56);ctx!.globalAlpha=p;ctx!.textAlign='left';ctx!.font='18px Consolas,monospace';ctx!.fillStyle='#9ebdac';ctx!.fillText("Music: 'Emergent' — Scott Buckley / CC BY 4.0",76,814);ctx!.fillText('www.scottbuckley.com.au  ·  Edited for this film',76,843);ctx!.font=`17px ${FONT}`;ctx!.fillText('原创动画与叙事 · AI 合成旁白',76,873);ctx!.globalAlpha=1;}
  // Source/interpretation marker is restrained; explanatory visuals are not measurements.
  if(i>2&&i<30){ctx!.textAlign='right';ctx!.font=`15px ${FONT}`;ctx!.fillStyle=darkInk;ctx!.fillText('原理与场景为教学示意',1850,1025);}
  const fade=ramp(t,154.5,DURATION);if(fade>0){ctx!.globalAlpha=fade;ctx!.fillStyle='#071922';ctx!.fillRect(0,0,1920,1080);ctx!.globalAlpha=1;}
  ctx!.restore();
 }
 return{canvas,render,dispose(){if(destroyed)return;destroyed=true;disposeTree(scene);env?.dispose();for(const material of Object.values(m))material.dispose();bloom.dispose();output.dispose();composer.dispose();renderer.dispose();renderer.forceContextLoss();canvas.width=1;canvas.height=1;},debug:{parameters(){return{};},setParameters(){},diagnostics(){const q=cueAt(currentTime);return{time:currentTime,cue:q.i,scene:sceneAt(q.i),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,version:'R3'};}}};
}
