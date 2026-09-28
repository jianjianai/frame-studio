export const DURATION = 264;
export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const mix = (a: number, b: number, p: number) => a + (b - a) * p;
export const smooth = (t: number, a: number, b: number) => { const p = clamp((t - a) / (b - a)); return p * p * (3 - 2 * p); };
export const mod = (x: number, n: number) => ((x % n) + n) % n;
export const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); };
export const chapters = [
  {start:0, end:26, year:'THE LEARNING MACHINE', title:'学习的机器', line:'从执行规则，到从数据中学习'},
  {start:26, end:48, year:'1950 — 1956', title:'一个问题，开启一个领域', line:'机器能否思考？'},
  {start:48, end:76, year:'RULES & SEARCH · 1997', title:'先把世界写成规则', line:'明确的边界之外，还有无穷的例外'},
  {start:76, end:114, year:'LEARNING · 1986', title:'不再只写规则，而是调整连接', line:'输入 → 预测 → 误差 → 更新'},
  {start:114, end:144, year:'DEEP VISION · 2012', title:'让机器，从像素中发现模式', line:'数据 × 网络 × 并行计算'},
  {start:144, end:170, year:'ALPHAGO · 2016', title:'搜索与学习，在棋盘上汇合', line:'策略网络 · 价值评估 · 搜索'},
  {start:170, end:206, year:'TRANSFORMER · 2017', title:'让信息，看见彼此', line:'注意力：按相关程度组合信息'},
  {start:206, end:239, year:'FOUNDATION MODELS · 2022 — 2024', title:'从预测词元，到多模态协作', line:'模型的背后，是整个计算系统'},
  {start:239, end:264, year:'THE NEXT QUESTION', title:'工具的边界，仍在拓展', line:'流畅 ≠ 真实　　规模 ≠ 可靠'},
] as const;
export function chapterAt(time: number) { const t = clamp(time, 0, DURATION - 1e-6); return Math.max(0, chapters.findIndex(c => t < c.end)); }
export type V3 = [number, number, number];
export type Shot = { t: number; p: V3; look: V3; fov?: number };
export function cameraAt(shots: Shot[], time: number) {
  let i = 0; while (i + 1 < shots.length && shots[i + 1]!.t <= time) i++;
  const a = shots[i]!, b = shots[Math.min(i + 1, shots.length - 1)]!;
  const p = a === b ? 0 : smooth(time, a.t, b.t);
  return { p: a.p.map((v,j) => mix(v,b.p[j]!,p)) as V3, look: a.look.map((v,j) => mix(v,b.look[j]!,p)) as V3, fov:mix(a.fov ?? 42,b.fov ?? 42,p) };
}
export const voiceWindows: [number,number][] = [[3.2,7.904],[9.5,14.108],[15.7,19.636],[21.2,24.68],[26,30.392],[32.2,37.168],[40,45.328],[48,53.088],[55,59.776],[62,67.64],[70,73.912],[76.5,80.148],[82,86.488],[88.5,92.988],[95,100.688],[102,106.68],[109,112.696],[115,120.232],[122.5,127.78],[130,135.832],[137.5,141.724],[144,149.28],[151.5,156.924],[159,163.344],[165,168.84],[171,175.968],[178.5,183.756],[185,190.208],[192.5,197.3],[199,203.872],[206.5,211.132],[213.5,218.708],[221,225.992],[228,232.2],[233.5,238.06],[239.5,244.756],[246.5,251.564],[254,257.432],[258.7,262.204]];
export function duckAt(t: number) { let speech = 0; for (const [a,b] of voiceWindows) { if (t > a - .28 && t < b + .7) speech = Math.max(speech,smooth(t,a-.28,a)*(1-smooth(t,b,b+.7))); } return 1 - .64 * speech; }
