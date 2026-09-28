import {actAt,move,clamp,lerp,mod,hit,color} from './time';
import {text,mono,round,tag,disk,link,pulse,token,tick,cross,cursor,stamp,brackets,type Ctx,type Point} from './ink';
import type {Project} from './early';
const vectors=[[.95,.13,.85,.2],[.2,.85,.15,.7],[.76,.19,.74,.15],[.3,.55,.2,.9]];
const query=[3.6,.1,3.4,.06];
const logits=vectors.map(v=>v.reduce((s,n,i)=>s+n*query[i]!,0)/Math.sqrt(query.length));
const denom=logits.reduce((s,n)=>s+Math.exp(n),0);
export const demoWeights=logits.map(n=>Math.exp(n)/denom);
export function drawLate(c:Ctx,t:number,P:Project){
 const a=actAt(t);
 if(a.key==='attention'){
  const words=['小猫','追球','它','想玩'],xs=[315,725,1110,1515],width=[270,265,190,300];
  if(t<95){
   text(c,t<82?'一句话，不能只看单个词。':t<86.2?'位置之间，建立关联。':t<90.4?'“它”，指的是谁？':'把相关的信息，加权组合。',84,174,57,color.ink);
   const raised=move(t,86.2,.28);const yy=(i:number)=>590-(i===2?raised*78:0);
   if(t>=90.4){for(let i=0;i<4;i++){if(i===2)continue;const p=move(t,90.45+i*.085,.38),a1:Point=[xs[i]!,yy(i)-59],b1:Point=[1110,yy(2)-59];link(c,a1,b1,-235,p,i===0?'#159775':'#b4c8bf',i===0?10:3);if(t>91&&t<94.7)pulse(c,a1,b1,-235,mod((t-91)*.95+i*.2,1),i===0?color.orange:'#74a99a',i===0?10:5);}}
   for(let i=0;i<4;i++){const p=move(t,77.06+i*.115,.42),x=lerp(2200+i*120,xs[i]!,p),y=yy(i);token(c,words[i]!,x,y,width[i]!,i===2&&t>=86.2?color.orange:color.paper,color.ink);if(t>=82){mono(c,`POSITION 0${i+1}`,x,y+95,18,'#64877e','center');for(let k=0;k<4;k++){const h=vectors[i]![k]!*43;round(c,x-53+k*34,y+142-h,20,h+5,3,'#6daea0');}}if(t>=90.8){const w=width[i]!*demoWeights[i]!;round(c,x-width[i]!/2,y-79,w,7,3,i===0?'#159775':'#bdcfbf');}}
   if(t>=86.2&&t<90.4){tag(c,'查询：它',1039,369,color.ink,color.white,25);link(c,[1110,406],[1110,441],0,1,color.orange,4);}
   if(t>=90.4)text(c,'小猫的信息，被更强地带入“它”。',960,819,32,'#397969','center');
  }else{
   text(c,'相关性，是算出来的。',84,174,61,color.ink);mono(c,'Q × Kᵀ / √d → SOFTMAX → VALUE MIX',87,239,21,'#658d80');
   const p=move(t,95,.4);c.save();c.globalAlpha=p;
   text(c,'查询向量',326,337,31,color.ink,'center');for(let j=0;j<4;j++){round(c,182+j*76,402,65,88,8,color.orange);text(c,query[j]!.toFixed(2),214+j*76,445,27,color.ink,'center');}
   link(c,[510,448],[687,448],0,move(t,95.32,.25),'#297b69',5);
   for(let i=0;i<4;i++)for(let j=0;j<4;j++){const v=vectors[i]![j]!,on=i===Math.floor(mod((t-95.5)*3.2,4));round(c,720+j*94,337+i*91,78,76,9,on?color.orange:'#d3e3d8');text(c,v.toFixed(2),759+j*94,376+i*91,24,on?color.ink:'#376d5c','center');}
   text(c,'各位置的信息',900,755,30,color.ink,'center');link(c,[1112,510],[1294,510],0,move(t,96.1,.24),'#297b69',5);
   text(c,'加权组合',1480,337,31,color.ink,'center');for(let i=0;i<4;i++){const value=vectors.reduce((s,v,k)=>s+v[i]!*demoWeights[k]!,0),h=value*190;round(c,1325+i*81,641-h,57,h,7,i===0?'#189877':'#66b69e');text(c,value.toFixed(2),1354+i*81,683,24,'#306a59','center');}tag(c,'相关信息进入新表示',1305,771,'#1c7e66',color.white,23);
   c.restore();mono(c,'自造向量的数值演示 · 非真实模型实测',86,848,18,'#739788');
  }
  return;
 }
 if(a.key==='predict'){
  if(t<107.4){
   text(c,'接下来，是什么？',85,174,63,color.white);mono(c,'NEXT-TOKEN PREDICTION',87,241,20,color.silver);
   text(c,'太阳从',235,492,98,color.white);round(c,690,418,286,151,17,'rgba(7,30,37,.7)','#438e82');
   if(t<103.2){if(Math.floor(t*3)%2===0)round(c,820,452,5,79,1,color.orange);text(c,'根据前文预测',830,641,28,color.silver,'center');}
   const selected=move(t,103.52,.42);const labels=['东方','西方','海底'];for(let i=0;i<3;i++){if(i>0&&t>=103.9)continue;const ys=[324,530,736],x=i===0?lerp(1300,832,selected):1300+move(t,103.64,.26)*850,y=i===0?lerp(ys[0]!,493,selected):ys[i]!;token(c,labels[i]!,x,y,247,i===0?color.orange:'#163b42',i===0?color.ink:'#a6c9bc');if(t<103.6){const fraction=[.76,.16,.08][i]!*move(t,100.5,.55);round(c,1470,ys[i]!-17,244*fraction,25,5,i===0?color.orange:'#4c8276');}}
   if(t>104.26){const p=move(t,104.26,.32);token(c,'升起',lerp(2030,1220,p),493,262,color.paper,color.ink);text(c,'。',1444,499,82,color.white);text(c,'一个词元接着一个词元',960,765,34,color.silver,'center');}
   mono(c,'候选排序为原理示意；不是固定答案表',87,848,18,color.silver);
  }else if(t<112){
   text(c,'重复预测，积累模式。',85,174,63,color.white);mono(c,'MANY EXAMPLES. REUSABLE PATTERNS.',87,241,20,color.silver);
   const examples=['太阳从东方升起。','橘猫把球推下桌子。','水遇冷可以结冰。','先提出问题，再寻找证据。','语言里，记录着许多规律。'];
   c.save();c.beginPath();c.rect(85,340,630,402);c.clip();for(let i=0;i<5;i++){const shift=mod((t-107.4)*260+i*73,780);text(c,examples[i]!,lerp(-485,430,shift/780),385+i*72,31,i%2?color.silver:color.white);}c.restore();
   const target=P([0,0,0]);for(let i=0;i<14;i++){const p=mod((t-107.4)*1.35+i*.13,1);const x=lerp(705,target[0],p),y=lerp(357+(i%5)*72,target[1],p);round(c,x,y,12+6*p,12+6*p,3,color.orange);}
   tag(c,'大量文本',87,798,color.mint,color.night,25);text(c,'模式留在参数里',1430,771,34,color.white,'center');
  }else if(t<117){
   text(c,'还要教它，怎样回答人。',85,174,59,color.white);mono(c,'INSTRUCTION DEMONSTRATIONS + FEEDBACK',87,241,20,color.silver);
   const updated=move(t,114.16,.36);text(c,'指令：用一句话说明什么是猫。',200,347,38,color.orange);
   round(c,192,425,1528,176,20,'#153c43');c.save();c.beginPath();c.rect(233,446,1439,133);c.clip();
   if(updated<1)text(c,'关于你的这个问题，实际上……',240-720*updated,510,48,'#7ea49a');if(updated>0)text(c,'猫是一种哺乳动物。',240+1430*(1-updated),510,57,color.white);c.restore();
   ['示范','比较','调整'].forEach((s,i)=>{const x=388+i*565;tag(c,s,x-53,743,t>=112.45+i*.7?color.mint:'#264a4e',t>=112.45+i*.7?color.night:color.silver,28);if(i<2)link(c,[x+110,743],[x+438,743],0,move(t,112.85+i*.7,.25),color.orange,4);});
   const cp=move(t,113.72,.33);cursor(c,lerp(1630,1450,cp),lerp(687,577,cp),Math.sin(clamp((t-114.05)/.24)*Math.PI));if(t>114.3)tick(c,1650,511,move(t,114.3,.2),color.mint,35);
   mono(c,'训练阶段示意，不表示每次对话都更新模型权重',87,848,18,color.silver);
  }else if(t<121){
   text(c,'对话，成为入口。',85,174,65,color.white);tag(c,'2022.11',1305,177,color.orange,color.night,28);
   round(c,247,300,1425,493,25,'#e4efe4');round(c,247,300,1425,60,25,'#2b665c');for(let i=0;i<3;i++)disk(c,288+i*28,330,7,i===0?color.orange:'#9cd0b8');mono(c,'CHAT / A NEW INTERFACE',1132,329,17,color.white);
   tag(c,'人',292,421,color.ink,color.white,25);text(c,'猫是什么？',400,421,42,color.ink);
   tag(c,'模型',292,558,'#178268',color.white,25);const full='猫是一种哺乳动物。',count=Math.floor(clamp((t-118.15)/1.55)*full.length);text(c,full.slice(0,count),425,558,48,color.ink);
   if(t>119.85){tick(c,1550,558,move(t,119.85,.22),'#188368',25);text(c,'从命令行，到自然语言交互',961,708,29,'#5a8074','center');}
  }else{
   text(c,'文字、图像、声音，汇入同一系统。',85,174,51,color.white);mono(c,'MULTIMODAL INTERACTION',87,240,19,color.silver);
   text(c,'这是什么？',206,345,43,color.orange);const hub=P([1.65,.2,0]),input=P([-4.7,.6,0]);
   link(c,[350,377],hub,-126,move(t,121.25,.36),color.mint,4);link(c,[input[0]+105,input[1]],hub,55,move(t,121.65,.4),color.mint,4);
   for(let i=0;i<38;i++){const h=7+Math.abs(Math.sin(t*12+i*.64)*Math.sin(i*.34+t))*40;round(c,177+i*12,765-h,6,h*2,3,color.mint);}text(c,'声音',365,846,25,color.silver,'center');
   link(c,[639,762],hub,53,move(t,122,.4),color.mint,4);if(t>123){link(c,[hub[0]+71,hub[1]],[1460,518],-55,move(t,123,.35),color.orange,5);text(c,'一只橘猫',1565,563,47,color.white,'center');tick(c,1574,654,move(t,123.8,.25),color.mint,30);}
   text(c,'图像',input[0],Math.min(814,input[1]+178),25,color.silver,'center');
  }
  return;
 }
 if(a.key==='verify'){
  text(c,'流畅，不等于真实。',85,174,66,color.ink);mono(c,'VERIFY THE CLAIM. TRACE THE SOURCE.',87,241,20,'#7b8f81');
  c.save();c.translate(856,511);c.rotate(-.025);c.shadowColor='rgba(27,53,45,.16)';c.shadowBlur=25;c.shadowOffsetY=18;round(c,-560,-184,1118,356,12,'#fffdf5');c.shadowColor='transparent';text(c,'一条看似可靠的回答',-490,-114,28,'#82968a');
  const fixed=t>=133.6;text(c,fixed?'暂不能确认。':'“已有研究证实……”',-487,-6,62,fixed?'#a57223':color.ink);text(c,'引用 [1]',312,90,31,t>=129?color.red:'#718a7d');for(let i=0;i<2;i++)round(c,-487,82+i*23,600-i*125,6,2,'#dfe6db');c.restore();
  const p=move(t,129.08,.36);link(c,[1240,623],[1620,669],30,1,t>=130?color.red:'#8da79a',4);disk(c,1630,667,53,color.paper,t>=130?color.red:'#8da79a');
  if(t<130){text(c,'?',1630,667,61,'#8ba092','center');}else{cross(c,1630,667,22);text(c,'没有找到来源',1580,780,30,color.red,'center');}
  if(t>=129&&t<133.6){c.strokeStyle=color.ink;c.lineWidth=9;c.beginPath();c.arc(lerp(1190,1630,p),lerp(565,666,p),83,0,Math.PI*2);c.stroke();c.beginPath();c.moveTo(lerp(1248,1688,p),lerp(623,724,p));c.lineTo(lerp(1302,1742,p),lerp(677,778,p));c.stroke();}
  if(t>=130.3&&t<133.6)stamp(c,'查无来源',829,462,t,130.3,color.red);
  if(t>=133){cursor(c,lerp(1740,1190,move(t,133,.35)),lerp(805,616,move(t,133,.35)));tag(c,'重要答案：核验原始资料',280,807,color.ink,color.white,27);tag(c,'关键决定：人来负责',1100,843,'#b07930',color.white,27);}
  mono(c,'虚构错误示例，仅演示核验过程',86,889,17,'#8a9586');
  return;
 }
 if(a.key==='outro'){
  const ink=color.white;
  if(t<143){text(c,'不是突然觉醒。',970,282,77,ink);text(c,'而是不停改进，教机器的方法。',970,382,35,color.silver);
   const centers=[1090,1390,1690];for(let i=0;i<3;i++){const p=hit(t,138.2+i*.16,.33);c.save();c.translate(centers[i]!,577);c.scale(p,p);disk(c,0,0,75,'#17494b');if(i===0){for(let j=0;j<3;j++){round(c,-40,-36+j*32,80,10,4,color.mint);}}else if(i===1){for(let j=0;j<3;j++){link(c,[-34,(j-1)*35],[32,0],0,1,color.mint,3);disk(c,-34,(j-1)*35,7,color.orange);}disk(c,32,0,11,color.mint);}else{round(c,-46,-35,93,62,13,color.mint);text(c,'…',0,-5,40,color.ink,'center');}c.restore();text(c,['写规则','学规律','人机协作'][i]!,centers[i]!,706,29,color.silver,'center');if(i<2){link(c,[centers[i]!+82,577],[centers[i+1]!-83,577],0,move(t,139+i*.6,.22),color.orange,4);if(t>139+i*.6)pulse(c,[centers[i]!+82,577],[centers[i+1]!-83,577],0,clamp((t-139-i*.6)/.6),color.orange,8);}}
  }else{
   text(c,t<148?'下一道题，':'问得更好，',990,292,75,ink);text(c,t<148?'由人来问。':'也验得更真。',990,403,87,color.orange);
   const typed='怎样验证这个答案？',count=Math.floor(clamp((t-143.65)/1.6)*typed.length);round(c,978,549,764,134,18,'#153e42','#4a9b89');text(c,typed.slice(0,count),1009,616,43,ink);const blink=Math.floor(t*2.5)%2;if(blink&&count<typed.length)round(c,1013+count*43,589,3,53,1,color.orange);
   const p=P([-4.35,.83,.8]);if(t>=148){brackets(c,p[0],p[1],125,110,color.mint);tick(c,p[0]+96,p[1]-52,move(t,148.3,.22),color.mint,20);}text(c,'能力向前，判断不能缺席。',996,758,29,color.silver);
  }
  if(t>150.9){c.save();c.globalAlpha=move(t,150.9,.2);mono(c,'原创动画 / 原创节奏配乐 / AI 合成旁白',86,871,19,color.silver);c.restore();}
 }
}
