import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'project.ts');
const current=await fs.readFile(target,'utf8');
const expected=process.argv[2];
if(!expected||createHash('sha256').update(current).digest('hex')!==expected)throw new Error('Expected current project.ts SHA-256 is required; refusing to overwrite a changed file.');
const speech=JSON.parse(await fs.readFile(path.join(root,'exports/mcp/5ff96556-d13b-413a-9f88-9cbdd810901a/result.json'),'utf8'));
if(speech.status!=='passed'||speech.sentences.length!==39)throw new Error('Narration bundle not complete.');
const replacements=[['一九五零年','1950年'],['一九五六年','1956年'],['一九九七年','1997年'],['一九八六年','1986年'],['二零一二年','2012年'],['二零一六年','2016年'],['二零一七年','2017年'],['二零二二年','2022年'],['阿列克斯网络','AlexNet'],['阿尔法狗','AlphaGo'],['变换器架构','Transformer 架构'],['四比一','4比1']];
const subtitles=speech.subtitles.map(s=>({...s,text:replacements.reduce((v,[a,b])=>v.replaceAll(a,b),s.text)}));
const beats=[
 [0,'机器为什么能够学习？','穿行服务器阵列，计算核心与猫的形状在信号中出现。'],
 [26,'1950—1956 · 起点','纸带与终端，将一个问题转化为研究领域。'],
 [48,'规则与搜索','传送带分拣、搜索树展开、棋子落下，例外阻塞规则装置。'],
 [76,'学习与反向传播','前向计算、误差返回、连接更新、预测改变。'],
 [114,'2012 · 深度视觉','猫与像素对应；特征层展开，芯片支持并行训练。'],
 [144,'2016 · AlphaGo','落子、分支搜索、评估与选择；原创建模的示意棋局。'],
 [170,'2017 · Transformer','词元之间的关联进入权重矩阵与并行层。'],
 [206,'生成式与多模态','词元预测、芯片装配、基础设施拉远、文字图像声音汇流。'],
 [239,'下一个问题','核验错误，将计算系统放回人类使用工具的场景。']
].map(([at,title,detail])=>({at,title,detail}));
const metadata={id:'the-learning-machine',title:'学习的机器｜AI 如何走到今天',subtitle:'从纸上的规则，到会学习的网络。',description:'4分24秒原创三维科普短片。以物体运动讲解规则、反向传播、图像识别、围棋搜索、注意力与大模型。浅灰薄荷绿的技术可视化、跨尺度镜头、中文AI合成旁白、原创配乐与音效。可视化为教学示意，非实测模型数据。',renderer:'three',duration:264,fps:30,status:'film',accent:'#77bba2',poster:'films/the-learning-machine/poster.svg',posterTime:20,tags:['AI发展史','三维科普','中文旁白','原创音乐'],audioTracks:[{...speech.audioTrack,name:'中文旁白 · AI合成',gain:1},{id:'score',name:'原创配乐 · 六音主题',kind:'generated',gain:1},{id:'foley',name:'机械 / 信号 / 转场音效',kind:'generated',gain:1}],beats,subtitles,credits:['原创叙事、三维场景、程序配乐与音效：FRAME · 学习的机器','中文旁白：AI合成声音，zh-CN-YunxiNeural；没有复用参考片声音。','参考片只研究视觉语言，不使用其画面、模型、音乐或品牌标识。','史实资料、原论文与示意说明：参见本项目制作资料中的 sources.md。','本片不是完整年表，也不声称不同研究路线按时间互相替代。']};
await fs.writeFile(target,`import type { AnimationProject } from '../../src/engine/types';\nconst project:AnimationProject={...${JSON.stringify(metadata,null,2)},load:()=>import('./scene'),loadAudio:()=>import('./audio')};\nexport default project;\n`);
console.log(JSON.stringify({written:target,subtitles:subtitles.length,duration:264,voiceVersion:speech.version,sha256:createHash('sha256').update(await fs.readFile(target)).digest('hex')}));
