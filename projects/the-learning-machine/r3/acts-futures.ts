import * as T from 'three';
import {box,ball,tube,instances,put,beam,trace,label,textFace,card,board,chip,boatTexture,pen,onCurve,type M} from './geometry';
import {lerp,ramp,mod,hash,shot,type V3} from './math';
import type {Rig,Annotation} from './rig-types';

export function generation(m:M):Rig{
 const root=new T.Group();const predict=new T.Group();root.add(predict);
 label(predict,'帆船驶向',[-4.55,.5,0],5.7,'#e7f0e6');box(predict,[3.2,1.23,.2],m.black,[.1,.5,0],.1,true);box(predict,[2.97,.05,.08],m.gold,[.1,-.075,.16],.01);const candidates:T.Group[]=[];['港口','星空','程序'].forEach((s,j)=>{const g=new T.Group();predict.add(g);box(g,[2.85,1.0,.2],j===0?m.gold:m.body,[0,0,-.13],.09,true);textFace(g,s,[2.62,.86],[0,0,0],j===0?'#173a39':'#b2cdbf',j===0?'#cfac70':'#29474b');candidates.push(g);});
 const logits=instances(predict,new T.BoxGeometry(.14,1,.14),m.light,24);
 const processor=new T.Group();root.add(processor);const core=chip(processor,m,1.85,[1.4,-1.0,0]);const stack:T.Mesh[]=[];for(let j=0;j<4;j++)stack.push(box(processor,[5.2,.12,5.2],j%2?m.metal:m.green,[1.4,j*.58-.3,0],.045));
 const inputSheets=instances(processor,new T.BoxGeometry(1.26,.09,.8),m.paper,100);const dataLabels=['风推动船帆','港口连接陆地','海面映出天空','知识需要核验'].map((s,j)=>label(processor,s,[-6.2,j*.75-1,1.1],3.7,'#cfdfd2'));const rawStreams=instances(processor,new T.BoxGeometry(.12,.09,.17),m.amber,150);
 const feedback=new T.Group();root.add(feedback);label(feedback,'用一句话解释帆船',[0,2.85,0],9.3,'#f1d4a2');const rails:T.Group[]=[];
 ['关于帆船，这是一个复杂的问题……','帆船借助风力航行。'].forEach((s,j)=>{const g=new T.Group();feedback.add(g);g.position.set(0,.9-j*1.8,0);box(g,[10.5,1.18,.26],m.black,[0,0,0],.11,true);label(g,s,[0,0,.22],9.5,j?'#9be4c9':'#8da99d');rails.push(g);});
 const fpath=tube(feedback,[[4.9,-.9,.3],[6.1,-.9,.3],[6.1,2.7,.3],[3.7,2.7,.3]],m.gold,.035).o;const verdict=label(feedback,'比较 → 调整',[5.8,3.3,0],4.2,'#e2b97b');const selected=box(feedback,[.10,1.05,.30],m.light,[-5,-.9,.19],.012);
 const terminal=new T.Group();root.add(terminal);box(terminal,[8.3,4.6,.34],m.black,[0,.65,0],.16,true);box(terminal,[7.75,4.05,.04],m.green,[0,.66,.20],.06);box(terminal,[.24,1.15,.25],m.metal,[0,-2.03,-.06],.035);box(terminal,[4.1,.14,1.75],m.black,[0,-2.6,.1],.1,true);
 label(terminal,'请解释：帆船为什么能前进？',[-.12,1.67,.28],7.05,'#e2e8d8');const display2=label(terminal,'',[-.12,.48,.28],7.05,'#cceada');label(terminal,'对话，成为新的入口',[0,-1.0,.28],6.9,'#84ad9d');
 const multi=new T.Group();root.add(multi);card(multi,boatTexture(0),[-6,.75,.0],.84,m);label(multi,'这是什么？',[-5.8,2.85,.2],3.8,'#e7cd98');const audio=instances(multi,new T.BoxGeometry(.095,1,.10),m.light,34);
 const channels=[tube(multi,[[-4.8,1,0],[-3.7,2.4,-1],[0,1.8,-1],[.6,.8,0]],m.gold,.025),tube(multi,[[-5.9,-1.8,0],[-3.8,-2.2,1.6],[-1.3,-.8,1],[.6,.8,0]],m.gold,.025)];
 const wide=new T.Group();root.add(wide);const substrate=board(wide,m,37);substrate.position.y=-2.6;const chips=instances(wide,new T.BoxGeometry(1.34,.27,1.34),m.black,324),lids=instances(wide,new T.BoxGeometry(1.14,.07,1.14),m.metal,324),glow=instances(wide,new T.BoxGeometry(.80,.035,.80),m.light,324);for(let j=0;j<324;j++){const x=(j%18-8.5)*1.93,z=(Math.floor(j/18)-8.5)*1.43;put(chips,j,[x,-2.13,z]);put(lids,j,[x,-1.96,z]);}chips.instanceMatrix.needsUpdate=true;lids.instanceMatrix.needsUpdate=true;
 const networkLines=instances(wide,new T.CylinderGeometry(1,1,1,5),m.gold,300);for(let j=0;j<300;j++){const x=(j%17-8)*1.93,z=(Math.floor(j/17)-8)*1.43;beam(networkLines,j,[x,-2.29,z],[x+1.93,-2.29,z+1.43],.019);}networkLines.instanceMatrix.needsUpdate=true;
 const architecture=tube(wide,[[-12,-1.8,7],[-7,2.5,0],[0,3.5,0],[7,2.5,0],[12,-1.8,-7]],m.amber,.075).o;const particles=instances(wide,new T.SphereGeometry(.10,8,6),m.amber,160);
 return{root,update(i,u,t){predict.visible=i===22;processor.visible=i===23||i===26||i===27;feedback.visible=i===24;terminal.visible=i===25;multi.visible=i===26;wide.visible=i===27;
 const choose=ramp(u,.25,.43);candidates.forEach((g,j)=>{g.position.set(j===0?lerp(6.6,.1,choose):lerp(6.6,14,choose),j===0?lerp(2.25,.5,choose):.5-j*1.65,.32);g.rotation.y=j===0?.0:choose*.3;});for(let j=0;j<24;j++){const group=Math.floor(j/8),h=[.95,.27,.12][group]!;put(logits,j,[5.05+(j%8)*.31,-2.18+h/2,-.8],[1,h*ramp(u,.06,.19),1]);}logits.instanceMatrix.needsUpdate=true;
 core.root.scale.setScalar(i===26?1.2:i===27?1.4:1.85);core.root.position.x=i===26?2.3:1.4;stack.forEach((s,j)=>{s.visible=i===23||i===27;s.position.set(1.4,lerp(4+j*.5,j*.58-.3,ramp(u,.04+j*.02,.21+j*.02)),0);s.rotation.y=(1-ramp(u,.02,.25))*.18;});
 for(let j=0;j<100;j++){const p=mod(t*.32+j*.091,1);put(inputSheets,j,[-7.6+mod(j,4)*.9,-1.5+Math.floor(j/4)*.055,-2.2-p],[1,1,1]);}inputSheets.instanceMatrix.needsUpdate=true;inputSheets.visible=i===23;dataLabels.forEach((l,j)=>{l.sprite.visible=i===23;l.sprite.position.x=lerp(-7.5,-3.4,mod(u*1.9+j*.24,1));});for(let j=0;j<150;j++){const p=mod(t*.67+j*.067,1);put(rawStreams,j,[lerp(-7,1.4,p),lerp((j%8-3.5)*.36,.95,p),lerp(1.2,-.0,p)],[1,1,1]);}rawStreams.instanceMatrix.needsUpdate=true;rawStreams.visible=i===23;
 const rated=ramp(u,.34,.51);rails.forEach((g,j)=>{g.position.x=j===0?lerp(0,-15,ramp(u,.48,.66)):0;g.scale.setScalar(j===1?1+rated*.04:1);});selected.scale.y=rated;trace(fpath,ramp(u,.56,.86));verdict.sprite.visible=u>.55;
 const s='帆船通过帆面受风，获得推进力。';display2.set(s.slice(0,Math.floor(s.length*ramp(u,.24,.66))));
 for(let j=0;j<34;j++){const h=.16+.68*Math.abs(Math.sin(t*8+j*.42))*Math.exp(-(((j-16.5)/20)**2));put(audio,j,[-7.6+j*.115,-1.72,0],[1,h,1]);}audio.instanceMatrix.needsUpdate=true;channels.forEach((c,j)=>trace(c.o,ramp(u,.16+j*.11,.31+j*.11)));
 for(let j=0;j<324;j++){const x=(j%18-8.5)*1.93,z=(Math.floor(j/18)-8.5)*1.43,dist=Math.sqrt(x*x+z*z),lit=ramp(u,.05+dist*.013,.18+dist*.013);put(glow,j,[x,-1.904,z],[lit,1,lit]);}glow.instanceMatrix.needsUpdate=true;trace(architecture,ramp(u,.16,.51));for(let j=0;j<160;j++){const a=j*2.399963,p=mod(t*.45+j*.05,1),r=lerp(16,.1,p);put(particles,j,[Math.cos(a)*r,lerp(-1.6,2.9,p),Math.sin(a)*r*.64],[1,1,1]);}particles.instanceMatrix.needsUpdate=true;
 const pose=i===22?shot([2.4,3.4,13],[2.5,2.8,13.3],[0,.3,0],u,42):i===23?shot([6.6,5,13],[7,6.8,13.5],[0,.0,0],u,41):i===24?shot([5,3.1,12],[1.6,2.1,13.8],[0,.4,0],u,40):i===25?shot([6.3,3,10],[.9,1.8,9.3],[0,.4,0],u,38):i===26?shot([.9,1.8,9.3],[7.1,6.7,14.5],[.3,.0,0],u,41):shot([7.1,6.7,14.5],[27,23,30],[1,-.45,0],u,43,.44);
 const notes:Annotation[]=i===23?[{text:'预测训练，把可复用的模式留进参数',position:[1.5,3.8,0],size:31}]:i===25?[{text:'2022 · 面向大众的入口',position:[0,3.52,0],size:37}]:i===26?[{text:'文字',position:[-5.7,3.62,0],size:25},{text:'图像',position:[-6,-.65,.2],size:25},{text:'声音',position:[-5.75,-2.45,0],size:25},{text:'多模态系统',position:[2.4,2.4,0],size:34}]:i===27?[{text:'长期积累，终于彼此接通',position:[.6,5.8,0],size:42}]:[];
 return{pose,notes,tag:i===24?'指令示范与反馈发生在训练阶段':i===22?'词元候选与相对权重为示意':undefined};}};
}

export function reliability(m:M):Rig{
 const root=new T.Group();const plinth=board(root,m,13);plinth.position.y=-2.6;
 const source=new T.Group();root.add(source);box(source,[6.5,3.6,.24],m.ceramic,[-3.3,.2,0],.13,true);label(source,'“已有研究证明……”',[-3.3,.8,.16],5.8,'#23483e');label(source,'引用：某份看似真实的报告',[-3.3,-.3,.16],5.65,'#537264');
 const hollow=new T.Group();root.add(hollow);hollow.position.set(4,.1,0);box(hollow,[3.0,3.6,.13],m.black,[0,0,-.30],.08);for(const x of [-1.5,1.5])box(hollow,[.14,3.6,.74],m.metal,[x,0,0],.03,true);for(const y of [-1.8,1.8])box(hollow,[3.08,.14,.74],m.metal,[0,y,0],.03,true);const nothing=label(hollow,'没有证据',[0,0,.24],3,'#de9b8a');
 const chain=new T.Group();root.add(chain);const rings:T.Mesh[]=[];for(let j=0;j<9;j++){const ring=new T.Mesh(new T.TorusGeometry(.18,.047,7,36),m.gold);ring.position.set(-.01+j*.28,.1,.7);ring.rotation.y=j%2?Math.PI/2:0;chain.add(ring);rings.push(ring);}
 const marker=ball(root,.09,m.red,[1,.5,.9]);const checks=new T.Group();root.add(checks);const gates:T.Group[]=[];['核验来源','最小权限','人的复核'].forEach((name,j)=>{const g=new T.Group();checks.add(g);g.position.set((j-1)*4.3,.4,0);box(g,[3.6,2.2,.42],m.black,[0,0,0],.11,true);box(g,[3.12,.075,.1],m.green,[0,-.63,.27],.015);label(g,name,[0,.3,.28],3.25);const shutter=box(g,[3.42,.1,1.65],m.metal,[0,1.3,0],.035,true);shutter.name='shutter';gates.push(g);});
 const signal=box(checks,[.72,.62,.72],m.light,[-8,-.65,1.25],.08);
 return{root,update(i,u,t){source.visible=i===28;hollow.visible=i===28;chain.visible=i===28;marker.visible=i===28;checks.visible=i===29;const breakAt=ramp(u,.19,.39);rings.forEach((r,j)=>{r.position.y=.1-(j===4?breakAt*3.8:0);r.rotation.z=j===4?breakAt*2.8:0;});nothing.sprite.visible=u>.3;hollow.rotation.y=.25*(1-ramp(u,.04,.20));marker.position.x=lerp(-.3,2.3,mod(t*.6,1));
 gates.forEach((g,j)=>{g.position.y=lerp(5+j,.4,ramp(u,.01+j*.05,.16+j*.05));g.getObjectByName('shutter')!.rotation.x=-1.35*ramp(u,.24+j*.09,.39+j*.09);});signal.position.x=lerp(-7.6,7.6,ramp(u,.40,.93));
 const pose=i===28?shot([8.4,4.4,14.5],[4.9,3.1,11.6],[0,.15,.2],u,41):shot([4.9,3.1,11.6],[-7,5.6,14.6],[0,.3,0],u,42);
 return{pose,light:true,tag:i===28?'虚构错误示例，不是真实研究结论':'能力的边界，需要验证与责任',notes:i===28?[{text:'流畅 ≠ 事实',position:[.3,3.4,0],size:48,color:'#cc806b'}]:[]};}};
}

export function finale(m:M):Rig{
 const root=new T.Group();const substrate=board(root,m,14);substrate.position.y=-2.7;const writing=pen(root,m);writing.root.rotation.set(0,0,-.33);const question=new T.Group();root.add(question);question.position.set(-2,.5,.8);
 const points:V3[]=[[-1.45,1.31,0],[-1.27,2.05,0],[-.43,2.46,0],[.63,2.17,0],[1.14,1.54,0],[1.08,.66,0],[.44,.09,0],[-.15,-.37,0],[-.22,-1.1,0]];const stroke=tube(question,points,m.gold,.14,false,120);const dot=ball(question,.165,m.amber,[-.22,-1.83,0]);
 const archive=new T.Group();root.add(archive);const tiles=instances(archive,new T.BoxGeometry(.73,.12,.73),m.black,144),beats=instances(archive,new T.BoxGeometry(.37,.026,.37),m.light,144);for(let j=0;j<144;j++){const x=(j%12-5.5)*.99,z=(Math.floor(j/12)-5.5)*.66;put(tiles,j,[x,-2.34,z]);}tiles.instanceMatrix.needsUpdate=true;
 const trails=instances(root,new T.SphereGeometry(.08,8,6),m.amber,100);const idea=chip(root,m,.7,[3.1,-2.23,-1.5]);
 return{root,update(i,u){const draw=i===30?ramp(u,.18,.86):1;trace(stroke.o,draw);dot.visible=i===31||draw>.92;const pos=onCurve(stroke.curve,draw);writing.root.position.set(-2+pos[0]+.15,.5+pos[1]+.49,.8);writing.root.rotation.z=lerp(-.33,-.55,draw);writing.root.visible=i===30||i===31&&u<.21;if(i===31)writing.root.position.y+=ramp(u,0,.21)*5;
 for(let j=0;j<144;j++){const x=(j%12-5.5)*.99,z=(Math.floor(j/12)-5.5)*.66,p=1-ramp(u,.12+j*.003,.37+j*.003);put(beats,j,[x,-2.266,z],[i===30?p:.08,1,i===30?p:.08]);}beats.instanceMatrix.needsUpdate=true;
 for(let j=0;j<100;j++){const p=mod(u*.9+j*.009,1);const x=(hash(j)-.5)*12,z=(hash(j+20)-.5)*8;put(trails,j,[lerp(x,-2+pos[0],p),lerp(-2.28,.5+pos[1],p),lerp(z,.8,p)],[i===30?.75:.001,i===30?.75:.001,i===30?.75:.001]);}trails.instanceMatrix.needsUpdate=true;idea.root.rotation.y=.1;
 const pose=i===30?shot([-7,5.6,14.6],[5.3,4.2,12.6],[-.3,.2,0],u,42):shot([5.3,4.2,12.6],[6.2,6.2,16.3],[-.3,.0,0],u,39,.2);
 return{pose,title:i===31?'让能力，指向值得解决的问题。':undefined,notes:i===30?[{text:'从写规则，到学习规律',position:[2.9,2.7,-.5],size:31}]:[]};}};
}
