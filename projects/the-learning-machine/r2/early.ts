import {actAt,move,lerp,clamp,hit,color,type V3} from './time';
import {text,mono,tag,link,pulse,tick,cross,brackets,stamp,type Ctx,type Point} from './ink';
export type Project=(p:V3)=>Point;
export function drawEarly(c:Ctx,t:number,P:Project){
 const a=actAt(t),dark=['hook','learn','go'].includes(a.key),ink=dark?color.white:color.ink,sub=dark?'#9abfb7':'#638880';
 if(a.key==='hook'){
  const flip=t>=1.2&&t<6.3;const h=P([-3.45,1.42,.8]);if(t>2.2){brackets(c,h[0],h[1],190,150,flip?color.red:color.mint);if(flip)cross(c,h[0]+117,h[1]-71,13);}
  mono(c,'INPUT  /  ROTATION TEST',1050,263,22,color.silver);
  if(t<3.1){text(c,'翻过来，',1040,388,86,ink);text(c,'还是猫。',1040,506,116,color.orange);}
  else if(t<6.2){text(c,'它没变。',1040,382,89,ink);text(c,'机器却犹豫了。',1040,506,57,color.red);mono(c,'SAME OBJECT. DIFFERENT PIXELS.',1050,598,19,color.silver);}
  else{const p=move(t,6.23,.32);c.save();c.translate(60*(1-p),0);c.globalAlpha=p;text(c,'AI 的三道题',1030,358,83,ink);['写规则','学规律','预测下一个'].forEach((s,i)=>{const k=move(t,6.68+i*.17,.28);c.globalAlpha=k;tag(c,`0${i+1}`,1040,484+i*77,i===1?color.orange:color.mint);text(c,s,1160+30*(1-k),484+i*77,34,ink);});c.restore();}
  const base=P([-3.45,-3.14,0]);tag(c,flip?'人：还是猫　/　机器：？':'输入：同一只橘猫',base[0]-164,Math.min(826,base[1]),flip?color.red:color.mint,flip?color.white:color.night,23);
  return true;
 }
 if(a.key==='rules'){
  const fail=t>=22.85;const first=move(t,18.42,.37),second=move(t,19.08,.37);const ear=P([-3.65,1.32,1.15]),whisker=P([-3.6,.2,1.3]),p1=P([1.29,1.5,.1]),p2=P([1.29,.05,.1]),out=P([3.1,-1.8,.31]);
  text(c,t<18.3?'把知识，写成条件。':fail?'条件一变，答案就断了。':'两个条件，推出一个答案。',84,170,55,ink);
  mono(c,t<18.3?'SYMBOLS → RULES → DECISIONS':'IF  /  AND  /  THEN',87,235,20,sub);
  if(t>=18.3){link(c,ear,p1,-92,first,fail?color.red:'#1b9c7e',5);link(c,whisker,p2,48,second,'#1b9c7e',5);if(t<19)brackets(c,ear[0]-45,ear[1],105,91,color.orange);}
  text(c,'且',...P([5.74,.1,.1]),27,sub,'center');
  text(c,fail?'无法判断':t>=20?'猫':'?',out[0],out[1],fail?44:74,color.white,'center');
  if(t>=20&&!fail)tick(c,out[0]+142,out[1],move(t,20,.2),color.orange,21);
  if(fail){const p=P([-4.1,1.6,1.94]);text(c,'耳朵被遮住',p[0],p[1],31,color.white,'center');cross(c,p1[0]-18,p1[1],16);stamp(c,'现实总有例外',920,794,t,24.2,color.red);}
  else if(t>=13.3&&t<18.3){tag(c,'1956',87,795,color.ink,color.white,28);text(c,'达特茅斯：人工智能成为研究领域',235,795,28,sub);}
  return true;
 }
 if(a.key==='learn'){
  const close=t>=35.5&&t<40;
  text(c,close?'把“错了多少”，传回连接。':t>=43.5?'换一道没见过的题。':t>=40?'更新参数，再试一次。':t>=31.4?'先猜。错了，就改。':'不写死答案，给它带答案的样本。',84,170,52,ink);
  if(close){const p=P([-1.55,.4,.1]);const weight=lerp(.24,.68,move(t,36.8,.44));mono(c,'WEIGHT / 参数',p[0]-10,p[1]+120,25,color.silver,'center');text(c,weight.toFixed(2),p[0]-10,p[1]+208,101,color.orange,'center');text(c,'误差 → 调整方向',1290,734,34,color.silver,'center');}
  else{
   const input=P([-6.2,1.55,0]),pred=P([5.5,1.14,0]),truth=P([5.5,2.02,0]);tag(c,t>=43.5?'未见样本':'带答案样本',input[0]-82,input[1],t>=43.5?color.orange:color.mint,color.night,22);
   text(c,'答案：猫',truth[0],truth[1],31,color.orange,'center');
   const waiting=t<32.7||t>=43.5&&t<46.1,ok=t>=40.85&&!waiting;
   text(c,waiting?'预测：？':ok?'预测：猫':'预测：狗',pred[0],pred[1],37,waiting?ink:ok?color.mint:color.red,'center');
   if(!waiting){const p=P([5.5,-.64,0]);if(ok)tick(c,p[0],p[1],move(t,t>=43.5?46.1:40.85,.2),color.mint,26);else cross(c,p[0],p[1],21);}
   [-3.3,0,3.3].forEach((x,i)=>{const p=P([x,-1.99,0]);text(c,['输入','可调整的连接','输出'][i]!,p[0],p[1]+44,i===1?27:25,sub,'center');});
   if(t>=33.3&&t<35.5){const p=clamp((t-33.65)/1.28);link(c,[1390,797],[410,797],80,1,color.orange,3);pulse(c,[1390,797],[410,797],80,p,color.red,10);text(c,'误差返回',925,812,29,color.orange,'center');}
   if(t>=43.5){text(c,'训练 ≠ 泛化',960,815,37,color.orange,'center');}
  }
  return true;
 }
 if(a.key==='vision'){
  if(t<50.9){text(c,'像素，',1050,357,80,ink);text(c,'需要被组织成模式。',1050,467,44,ink);mono(c,'SCAN → REPRESENTATION',1050,563,19,sub);}
  else if(t<60){text(c,t>=55.5?'2012 / 深度视觉的突破':'边缘，组合成更复杂的模式。',85,170,54,ink);const names=['输入图像','边缘','局部','模式'];for(let i=0;i<4;i++){const p=move(t,50.9+i*.17,.38);if(p>0){const q=P([(-1.5+i)*3.32,-1.8,0]);c.save();c.globalAlpha=p;text(c,names[i]!,q[0],q[1]+22,29,sub,'center');c.restore();if(i<3&&t>52.3){const a1=P([(-1.5+i)*3.32+1.46,0,0]),b1=P([(-.5+i)*3.32-1.46,0,0]);link(c,a1,b1,0,move(t,52.35+i*.21,.2),'#168b72',4);}}}if(t>=55.5){tag(c,'AlexNet',87,813,color.ink,color.white,27);text(c,'数据 × 深度网络 × GPU',287,813,29,sub);}}
  else{text(c,'一批任务，同时计算。',85,170,59,ink);mono(c,'DATA × PARALLEL COMPUTE',87,242,20,sub);const p=P([-5.6,1.5,0]);tag(c,'样本批次',p[0]-44,p[1]-50,color.orange,color.ink,25);text(c,'并行计算单元',1390,785,29,sub,'center');}
  return true;
 }
 if(a.key==='go'){
  if(t<67.2){text(c,'机器，开始学习怎么选。',85,170,55,ink);mono(c,'FROM RECOGNITION TO DECISION',87,242,19,color.silver);}
  else if(t<72.5){['筛选落点','评估局面','配合搜索'].forEach((s,i)=>{const active=t>=67.2+i*.72;const x=250+i*660;text(c,s,x,182,48,active?color.orange:sub,'center');if(i<2)link(c,[x+152,184],[x+490,184],0,move(t,67.7+i*.72,.24),color.mint,3);});const positions:V3[]=[[-1.44,-1.11,-.48],[.96,-1.11,1.44],[2.4,-1.11,-2.4]];positions.forEach((q,i)=>{if(t<69.55||i===1){const p=P(q);tag(c,['A','B','C'][i]!,p[0]+24,p[1]-35,i===1&&t>=69.55?color.mint:color.orange,color.night,23);}});}
  else{const s=hit(t,73.15,.35);c.save();c.translate(1445,345);c.scale(s,s);text(c,'4 : 1',0,0,145,color.orange,'center',700);text(c,'2016 · 对阵李世石',0,114,30,ink,'center');c.restore();text(c,'学习 + 搜索',1320,785,36,ink,'center');}
  return true;
 }
 return false;
}
