import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('projects/the-learning-machine');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const expected=process.argv[2];if(!expected||sha(path.join(root,'project.ts'))!==expected)throw new Error('project.ts changed: refresh its SHA-256 before activation');
const r=JSON.parse(fs.readFileSync(path.join(root,'exports/mcp/dc03e735-7f15-42ea-a749-9b41f20a08d7/result.json'),'utf8'));
if(r.status!=='passed'||r.sentences.length!==32)throw new Error('Narration is not complete');
for(const f of['voice.wav','score.wav','foley.wav'])if(!fs.existsSync(path.join(root,'public/audio-r3',f)))throw new Error('Missing prepared audio: '+f);
const replacements=[['一九五六年','1956年'],['一九八六年','1986年'],['二零一二年','2012年'],['二零一六年','2016年'],['二零一七年','2017年'],['二零二二年','2022年'],['阿列克斯网络','AlexNet'],['阿尔法狗','AlphaGo'],['变换器架构','Transformer 架构'],['四比一','4比1']];
const subtitles=r.subtitles.map(s=>({start:+s.start.toFixed(3),end:+s.end.toFixed(3),text:replacements.reduce((t,[a,b])=>t.replaceAll(a,b),s.text)}));
const metadata={id:'the-learning-machine',title:'不是突然变聪明｜AI 的七十年',subtitle:'算得快，为什么不等于看得懂？',description:'R3 返工版。用156秒追踪人工智能从规则、样本学习到视觉、决策、注意力与多模态的因果链；重新设计三维技术场景，停用橘猫和旧版自制音乐。配乐使用Scott Buckley的Emergent（CC BY 4.0），已按叙事节选与混音；不是本项目原创曲目。中文旁白为AI合成。原理示意非模型实测。',renderer:'three',duration:156,fps:30,status:'film',accent:'#7abda0',poster:'films/the-learning-machine/poster.svg',posterTime:9.2,tags:['R3返工','AI发展','三维科技','Scott Buckley配乐'],audioTracks:[{id:'voice',name:'解说 · 云扬 AI合成',kind:'file',src:'films/the-learning-machine/audio-r3/voice.wav',gain:1},{id:'music',name:'Emergent · Scott Buckley · CC BY 4.0',kind:'file',src:'films/the-learning-machine/audio-r3/score.wav',gain:1},{id:'foley',name:'动作与空间声音',kind:'file',src:'films/the-learning-machine/audio-r3/foley.wav',gain:1}],beats:[
 {at:0,title:'算得快，不等于看得懂',detail:'轨道计算与手写数字的反差，追问AI为何长期积累。'},
 {at:10.982,title:'规则与例外',detail:'将条件送进规则装置，笔迹改变后匹配失效。'},
 {at:29.11,title:'让样本改变参数',detail:'样本、标签、预测误差、反向调整。'},
 {at:52.972,title:'数据、算法、算力合流',detail:'层级特征与并行计算打开深度视觉。'},
 {at:71.908,title:'从识别，到选择',detail:'神经网络、强化学习与搜索在棋盘汇合。'},
 {at:88.804,title:'信息彼此关联',detail:'句中信息按相关性组合，批量运算支撑训练。'},
 {at:102.82,title:'从预测，到协作',detail:'预测词元、文本训练、指令反馈、大众入口和多模态。'},
 {at:132.288,title:'流畅并不等于真实',detail:'追溯证据链，核验、权限与责任。'},
 {at:143.672,title:'值得解决的问题',detail:'计算的光回到笔尖，问题引导下一步。'}],subtitles,credits:["'Emergent' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au",'音乐已节选、交叉淡化与混音；曲目不是本项目原创。发布时保留配乐署名与许可说明。','三维场景、原始纹理、叙事与动作：本项目R3原创制作。','旁白：AI合成 zh-CN-YunyangNeural；非真人声音克隆。','史实、原论文、教学简化及授权说明见本项目 r3-sources.md 与 r3-direction.md。','不使用参考视频的画面、台词、音乐、标识或模型。']};
fs.writeFileSync(path.join(root,'project.ts'),`import type {AnimationProject} from '../../src/engine/types';\nconst project:AnimationProject={...${JSON.stringify(metadata,null,2)},load:()=>import('./scene')};\nexport default project;\n`);
const stamp=t=>{const n=Math.round(t*1000);return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')},${String(n%1000).padStart(3,'0')}`;};
fs.writeFileSync(path.join(root,'public/r3-captions.srt'),subtitles.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n'));
console.log(JSON.stringify({status:'activated',version:'R3',duration:156,cues:subtitles.length,tracks:3,metadataSha256:sha(path.join(root,'project.ts'))}));
