import {clamp} from './math';
export const DURATION=156;
export const CUES=[
 [0.45,4.602],[4.762,7.21],[7.37,10.682],[10.982,15.23],[15.39,18.966],[19.126,24.022],[24.182,28.91],[29.11,33.814],[33.974,38.966],[39.126,44.766],[44.926,49.894],[50.054,52.622],[52.972,57.436],[57.596,62.588],[62.748,67.476],[67.636,71.668],[71.908,77.908],[78.068,82.964],[83.124,88.524],[88.804,92.692],[92.852,98.228],[98.388,102.66],[102.82,107.092],[107.252,112.124],[112.284,116.484],[116.644,120.868],[121.028,125.564],[125.724,131.988],[132.288,138.12],[138.28,143.512],[143.672,148.808],[148.968,153.912]
] as const;
export const STARTS=CUES.map((q,i)=>i===0?0:q[0]);
export function cueAt(time:number){const t=clamp(time,0,DURATION);let i=0;while(i+1<STARTS.length&&t>=STARTS[i+1]!)i++;const start=STARTS[i]!,end=STARTS[i+1]??DURATION;return{i,u:clamp((t-start)/(end-start)),t,local:t-start,length:end-start};}
export const SCENES=[
 {from:0,to:2,year:'',name:'算得快，不等于看得懂'},
 {from:3,to:6,year:'1956',name:'把知识写成规则'},
 {from:7,to:11,year:'1986',name:'从样本中学习'},
 {from:12,to:15,year:'2012',name:'数据 × 算法 × 算力'},
 {from:16,to:18,year:'2016',name:'学习怎样决策'},
 {from:19,to:21,year:'2017',name:'信息之间的关联'},
 {from:22,to:27,year:'2022—2024',name:'从预测，到协作'},
 {from:28,to:29,year:'',name:'能力与可靠性'},
 {from:30,to:31,year:'',name:'值得解决的问题'}
] as const;
export const sceneAt=(i:number)=>SCENES.findIndex(s=>i>=s.from&&i<=s.to);
