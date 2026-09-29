/** Explicit end-to-end authoring acceptance. Keeps its film/evidence in .cache/creator-flow/. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { creatorTaskIgnores } from "../server/creator-workspace.mjs";
import { readProject } from "../scripts/project-metadata.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const root = path.join(repo, ".cache/creator-flow/film-" + randomUUID());
const id = "creator-lab",
  folder = path.join(root, "projects", id);
fs.mkdirSync(root, { recursive: true });
for (const name of [
  "src",
  "public",
  "scripts",
  "templates",
  "docs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "index.html",
  "vite.config.ts",
  "vitest.config.ts",
  "AGENTS.md",
])
  fs.cpSync(path.join(repo, name), path.join(root, name), { recursive: true });
fs.symlinkSync(
  fs.realpathSync(path.join(repo, "node_modules")),
  path.join(root, "node_modules"),
  "dir",
);
const steps = [];
const run = (bin, args, { json = false, expected = 0 } = {}) => {
  const started = performance.now();
  const r = spawnSync(bin, args, {
    cwd: root,
    env: { ...process.env, FRAME_PROJECT: id },
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 24 * 1024 * 1024,
  });
  const step = {
    command: [bin, ...args],
    exitCode: r.status,
    elapsedMs: Math.round(performance.now() - started),
  };
  steps.push(step);
  assert.equal(r.status, expected, r.stderr + "\n" + r.stdout);
  console.log(JSON.stringify(step));
  return json ? JSON.parse(r.stdout) : r.stdout;
};
const film = (args, options = {}) =>
  run(process.execPath, [path.join(root, "scripts/film.mjs"), ...args], {
    json: args.includes("--json"),
    ...options,
  });
const tool = (name, args = {}, options = {}) =>
  run(
    process.execPath,
    [path.join(root, "scripts/work-tool.mjs"), name, JSON.stringify(args)],
    { json: true, ...options },
  );
const save = (name, value) => fs.writeFileSync(path.join(folder, name), value);
let outcome = { status: "failed", root };
try {
  film([
    "new",
    id,
    "创作回路 · 从光点到成片",
    "--renderer",
    "canvas",
    "--duration",
    "12",
    "--fps",
    "24",
    "--audio",
    "generated",
  ]);
  save(
    "scene.ts",
    `import type { Scene, SceneOptions } from '../../src/engine/types';
const drift = 0.018;
const clamp = (x:number) => Math.max(0, Math.min(1, x));
const ease = (x:number) => { x=clamp(x); return x*x*(3-2*x); };
export function createScene({width,height}:SceneOptions):Scene {
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d')!;
  return {canvas,render(t) {
    const w=width,h=height;
    ctx.fillStyle='#071222';ctx.fillRect(0,0,w,h);
    const zoom=1+0.04*Math.sin(t*.45); ctx.save();ctx.translate(w/2,h/2);ctx.scale(zoom,zoom);
    const a=ease((t-3)/1.5),b=ease((t-7)/1.5);
    const glow=ctx.createRadialGradient(0,0,0,0,0,w*.45);glow.addColorStop(0,'#123952');glow.addColorStop(1,'#071222');ctx.fillStyle=glow;ctx.fillRect(-w/2,-h/2,w,h);
    for(let i=0;i<85;i++){const x=((i*0.61803398875+t*drift)%1-.5)*w;const y=(Math.sin(i*19.17)*.5)*h;ctx.fillStyle='rgba(133,209,237,'+(0.08+(i%5)*.035)+')';ctx.beginPath();ctx.arc(x,y,1+(i%3)*.6,0,Math.PI*2);ctx.fill();}
    for(let k=0;k<4;k++) {ctx.beginPath();for(let i=0;i<=140;i++){const x=(i/140-.5)*w*.84;const y=Math.sin(i*.08-t*2+k*.6)*h*.10*(1-a)+Math.sin(i*.20-t*4+k)*h*.045*a*(1-b)+(k-1.5)*h*.09*a; i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.strokeStyle=['#57d2e4','#7ca8ff','#c298ff','#98eecc'][k];ctx.lineWidth=1.8+(k===0?1:0);ctx.globalAlpha=.24+.55*a;ctx.stroke();}
    ctx.globalAlpha=1;
    for(let i=0;i<24;i++) {const phase=i/24*Math.PI*2+t*.50;const radius=h*(.19+.035*Math.sin(t*.7));const ox=Math.cos(phase)*radius,oy=Math.sin(phase)*radius;const tx=(i/23-.5)*w*.72,ty=Math.sin(i*.7-t*2)*h*.06;const side=i%4,u=Math.floor(i/4)/5;const fx=side===0?-w*.23+u*w*.46:side===1?w*.23:side===2?w*.23-u*w*.46:-w*.23;const fy=side===0?-h*.19:side===1?-h*.19+u*h*.38:side===2?h*.19:h*.19-u*h*.38;const x=(ox*(1-a)+tx*a)*(1-b)+fx*b,y=(oy*(1-a)+ty*a)*(1-b)+fy*b;ctx.fillStyle=i%3?'#89e3e6':'#ffdd9a';ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=12;ctx.beginPath();ctx.arc(x,y,h*(.006+.002*Math.sin(t*4+i)),0,Math.PI*2);ctx.fill();}
    ctx.shadowBlur=0;
    const orbX=Math.sin(t*.65)*w*.14*(1-b),orbY=Math.cos(t*.8)*h*.07*(1-b);
    ctx.save();ctx.translate(orbX,orbY);ctx.rotate(Math.sin(t*.5)*.15*(1-b));ctx.fillStyle='#e5fbfc';ctx.shadowColor='#72e5ed';ctx.shadowBlur=22;ctx.beginPath();
    const s=h*(.028+.035*b);ctx.moveTo(-s*.5,-s);ctx.lineTo(s,-s*(1-b));ctx.lineTo(-s*.5,s);ctx.closePath();ctx.fill();ctx.restore();ctx.shadowBlur=0;
    if(b>0){ctx.globalAlpha=b;ctx.strokeStyle='#8ee7ee';ctx.lineWidth=2;ctx.strokeRect(-w*.23,-h*.19,w*.46,h*.38);ctx.globalAlpha=1;}
    ctx.restore();
  },dispose(){canvas.width=1;canvas.height=1;}};
}
`,
  );
  // A local synthesized impact tests file-audio import without an external provider.
  const frames = 16800,
    wav = Buffer.alloc(44 + frames * 4);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / 48000,
      v = Math.round(
        Math.sin(2 * Math.PI * (330 * t + 200 * t * t)) *
          Math.exp(-t * 16) *
          Math.min(1, t / 0.006) *
          8000,
      );
    wav.writeInt16LE(v, 44 + i * 4);
    wav.writeInt16LE(v, 46 + i * 4);
  }
  save("production/impact.wav", wav);
  film([
    "import",
    id,
    path.join(folder, "production/impact.wav"),
    "--license",
    "Original deterministic synthesis for FRAME creator acceptance; CC0",
    "--json",
  ]);
  const asset = JSON.parse(
    fs.readFileSync(path.join(folder, "public/assets.json"), "utf8"),
  ).find((a) => a.name === "impact.wav");
  assert(asset?.url);
  const { meta } = readProject(path.join(folder, "project.ts"));
  Object.assign(meta, {
    title: "创作回路 · 从光点到成片",
    status: "film",
    posterTime: 9.5,
    beats: [
      { id: "idea", at: 0, title: "光点汇聚", detail: "环绕运动与镜头推进" },
      {
        id: "rhythm",
        at: 4,
        title: "进入节奏",
        detail: "光点形成波形，节奏与冲击声同步",
      },
      {
        id: "delivery",
        at: 8,
        title: "形成画面",
        detail: "轨迹收束为影片画框",
      },
    ],
    audioTracks: [
      { id: "melody", name: "旋律", kind: "generated", gain: 0.5 },
      { id: "pulse", name: "节奏", kind: "generated", gain: 0.5 },
      {
        id: "impact-a",
        name: "第一次转场",
        kind: "file",
        src: asset.url,
        start: 4,
        duration: 0.35,
        gain: 0.6,
      },
      {
        id: "impact-b",
        name: "第二次转场",
        kind: "file",
        src: asset.url,
        start: 8,
        duration: 0.35,
        gain: 0.6,
      },
    ],
    subtitles: [
      { start: 0.35, end: 3.5, text: "一个想法，先找到运动的方向。" },
      { start: 4.1, end: 7.5, text: "画面、节奏与声音，共用一条时间线。" },
      { start: 8.2, end: 11.8, text: "反复回看，让每一次修改都留下证据。" },
    ],
  });
  save(
    "project.ts",
    "import type { AnimationProject } from '../../src/engine/types';\nconst project: AnimationProject = {..." +
      JSON.stringify(meta, null, 2) +
      ", load: () => import('./scene'), loadAudio: () => import('./audio')};\nexport default project;\n",
  );
  save(
    "production/brief.md",
    "# 创作回路\n\n12 秒原创技术验收动画：三个连续形变镜头、四条音轨、中文字幕、确定性倒跳。音效为本地合成，不是旁白；不访问外部语音服务。技术验收不代替成片审美与听觉评审。\n",
  );
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    creatorTaskIgnores.join("\n") + "\n",
  );
  run("git", ["init", "-b", "creator-acceptance"]);
  run("git", ["config", "user.name", "FRAME Acceptance"]);
  run("git", ["config", "user.email", "acceptance@localhost"]);
  run("git", [
    "add",
    "--",
    ...fs
      .readdirSync(root)
      .filter((name) => ![".git", "node_modules"].includes(name)),
  ]);
  run("git", ["commit", "-qm", "Initialize isolated real-film acceptance"]);
  const reportDir = path.join(folder, "records");
  fs.mkdirSync(reportDir, { recursive: true });
  const context = tool("context");
  assert.equal(context.projectInfo.duration, 12);
  assert.equal(context.audioTracks.length, 4);
  const checkpoint = film([
    "checkpoint",
    id,
    "--label",
    "before-motion-edit",
    "--json",
  ]);
  const current = film(["read", id, "--path", "scene.ts", "--json"]);
  save(
    "production/patch.json",
    JSON.stringify({
      changes: [
        {
          path: "scene.ts",
          expectedSha256: current.sha256,
          replacements: [
            {
              find: "const drift = 0.018;",
              replace: "const drift = 0.024;",
              count: 1,
            },
          ],
        },
      ],
    }),
  );
  film([
    "patch",
    id,
    "--input",
    path.join(folder, "production/patch.json"),
    "--dry-run",
    "--json",
  ]);
  film([
    "patch",
    id,
    "--input",
    path.join(folder, "production/patch.json"),
    "--json",
  ]);
  const conflict = film(
    [
      "patch",
      id,
      "--input",
      path.join(folder, "production/patch.json"),
      "--json",
    ],
    { expected: 1 },
  );
  assert.equal(conflict.error.code, "VERSION_CONFLICT");
  const history = film(["history", id, "--json"]);
  film([
    "restore",
    id,
    "--checkpoint",
    checkpoint.checkpoint,
    "--expected",
    history.fingerprint,
    "--json",
  ]);
  film([
    "restore",
    id,
    "--checkpoint",
    checkpoint.checkpoint,
    "--expected",
    history.fingerprint,
    "--apply",
    "--json",
  ]);
  assert(
    fs
      .readFileSync(path.join(folder, "scene.ts"), "utf8")
      .includes("const drift = 0.018;"),
  );
  const browser = film(["test-e2e", id, "--json"]);
  assert.equal(browser.status, "passed");
  const check = tool("check", { runtime: true, start: 3.5, end: 5.5 });
  assert.equal(check.status, "passed");
  film([
    "storyboard",
    id,
    "--times",
    "0.5,2.5,4.5,6.5,8.5,10.5",
    "--width",
    "480",
    "--out",
    path.join(folder, "exports/all-shots.png"),
    "--json",
  ]);
  const review = film([
    "review",
    id,
    "--start",
    "3.5",
    "--end",
    "5.5",
    "--width",
    "640",
    "--fps",
    "24",
    "--json",
  ]);
  assert.equal(review.status, "passed");
  const reviewFiles = fs.readdirSync(review.directory);
  assert(reviewFiles.includes("captions.srt"));
  assert(reviewFiles.includes("mix.wav"));
  assert.equal(
    reviewFiles.filter((n) => n.startsWith("track-") && n.endsWith(".wav"))
      .length,
    4,
  );
  const audioTiming = ["melody", "pulse", "impact-a", "impact-b"].map(
    (track) => {
      const bytes = fs.readFileSync(
        path.join(review.directory, `track-${track}.wav`),
      );
      assert.equal(bytes.toString("ascii", 36, 40), "data");
      let energy = 0,
        first = null,
        last = null;
      for (let i = 44; i < bytes.length; i += 4) {
        const value = bytes.readInt16LE(i) / 32768;
        energy += value * value;
        if (Math.abs(value) > 0.0001) {
          first ??= (i - 44) / 192000;
          last = (i - 44) / 192000;
        }
      }
      const rms = Math.sqrt(energy / ((bytes.length - 44) / 4));
      if (track === "impact-b") assert.equal(rms, 0);
      else assert(rms > 0.001);
      if (track === "impact-a") {
        assert(first >= 0.499 && first < 0.51);
        assert(last <= 0.851);
      }
      return { track, rms, first, last };
    },
  );
  assert(
    fs
      .readFileSync(path.join(review.directory, "captions.srt"), "utf8")
      .includes("00:00:00,600"),
  );
  const exported = film([
    "export",
    id,
    "--width",
    "960",
    "--fps",
    "24",
    "--segment-seconds",
    "4",
    "--json",
  ]);
  assert.equal(exported.status, "passed");
  const verify = film(["verify", id, "--file", exported.output, "--json"]);
  assert.equal(verify.status, "passed");
  assert.equal(verify.media.decodedFrames, 288);
  assert.equal(verify.version.matches, true);
  assert.equal(verify.contentReview.listening, "not_run");
  const scope = film(["scope", id, "--json"]);
  assert.equal(scope.passed, true);
  outcome = {
    status: "passed",
    root,
    project: id,
    steps,
    check,
    review,
    exported,
    verification: verify.report,
    audioTiming,
    decodedFrames: verify.media.decodedFrames,
    versionMatches: verify.version.matches,
    storyboard: path.join(folder, "exports/all-shots.png"),
    contentReview: { visual: "not_run", listening: "not_run" },
  };
} catch (error) {
  outcome = { status: "failed", root, steps, error: error.stack };
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.join(repo, ".cache/creator-flow"), { recursive: true });
  fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".cache/acceptance.json"),
    JSON.stringify(outcome, null, 2),
  );
  fs.writeFileSync(
    path.join(repo, ".cache/creator-flow/latest-acceptance.json"),
    JSON.stringify(outcome, null, 2),
  );
  console.log(
    JSON.stringify({
      status: outcome.status,
      root,
      error: outcome.error,
      output: outcome.exported?.output,
      report: path.join(root, ".cache/acceptance.json"),
    }),
  );
}
