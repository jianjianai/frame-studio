// Isolated deployment acceptance: exercises worker orchestration with a fixture CLI, not an AI provider.
import fs from "node:fs";
import assert from "node:assert/strict";
const base = process.env.FRAME_SMOKE_URL || "http://127.0.0.1:45842";
if (!process.env.FRAME_SMOKE_PASSWORD)
  throw Error("Isolated test credentials required");
const r = await fetch(base + "/api/login", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.FRAME_SMOKE_PASSWORD }),
});
assert.equal(r.status, 200);
const cookie = r.headers.get("set-cookie").split(";")[0];
const api = async (name, args = {}) => {
  const r = await fetch(base + "/api/action", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const v = await r.json();
  assert.equal(r.status, 200, JSON.stringify(v));
  return v;
};
const work = await api("works_create", {
  title: "Worker bridge acceptance",
  duration: 2,
});
const tool = "/data/tools/codex/fixture-bridge/node_modules/.bin/codex",
  marker = "/data/tools/codex/current";
const old = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
assert(!fs.existsSync(tool));
fs.mkdirSync(tool.slice(0, tool.lastIndexOf("/")), { recursive: true });
fs.writeFileSync(
  tool,
  `#!/usr/bin/env node
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const call=(name,args={})=>JSON.parse(execFileSync(process.execPath,['scripts/work-tool.mjs',name,JSON.stringify(args)],{encoding:'utf8'}));
(async()=>{const assets=call('assets'),engine=call('engines')[0];if(!assets.length)throw Error('Seed material required');const ref=call('use',{asset:assets[0].id});const voice=call('speech',{engine:engine.id,text:'后台创作任务可以使用素材与中文语音。'});const forbidden=await fetch(process.env.FRAME_AGENT_URL+'/api/action',{method:'POST',headers:{Authorization:'Bearer '+process.env.FRAME_AGENT_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({name:'settings_get'})});if(forbidden.status!==401)throw Error('Task token leaked administrator access');fs.writeFileSync('projects/'+process.env.FRAME_PROJECT+'/production/bridge-test.json',JSON.stringify({ref,voice,denied:forbidden.status}));await new Promise(r=>setTimeout(r,5000));console.log(JSON.stringify({type:'result',session_id:'fixture-session',is_error:false}));})().catch(e=>{console.error(e.message);process.exitCode=1});
`,
  { mode: 0o755 },
);
fs.writeFileSync(marker, "fixture-bridge");
try {
  await api("settings_save", {
    provider: "codex",
    secret: "fixture-only-no-upstream",
  });
  const chat = await api("works_chat_create", {
      id: work.id,
      title: "Bridge fixture",
      provider: "codex",
    }),
    task = await api("chats_send", {
      id: chat.id,
      prompt: "Fixture bridge acceptance",
    });
  let result;
  for (let n = 0; n < 180; n++) {
    const t = (await api("task_get", { id: task.id })).task;
    const snapshot =
      "/data/runs/" +
      task.id +
      "/projects/" +
      work.project +
      "/production/bridge-test.json";
    if (t.state === "running" && fs.existsSync(snapshot)) {
      assert(
        !fs.existsSync(
          "/data/repos/" +
            work.repo +
            "/projects/" +
            work.project +
            "/production/bridge-test.json",
        ),
        "running worker must not write original",
      );
    }
    if (!["running", "queued"].includes(t.state)) {
      assert.equal(t.state, "succeeded", JSON.stringify(t));
      result = t;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(result);
  const source = await api("works_read", {
    id: work.id,
    path: "production/bridge-test.json",
  });
  const report = JSON.parse(source.content);
  assert.equal(report.denied, 401);
  assert(
    (await api("works_tasks", { id: work.id })).some((t) => t.kind === "build"),
    "successful agent schedules preview",
  );
  const data = {
    work: work.id,
    task: result.id,
    scope:
      "fixture CLI with real worker container, material bridge and local Chinese speech; external model not called",
    report,
  };
  fs.writeFileSync(
    "/evidence/agent-bridge-smoke.json",
    JSON.stringify(data, null, 2),
  );
  console.log(
    "PASS: isolated worker material + speech, task token cannot use admin API, original unchanged until completion, automatic preview",
  );
} finally {
  if (old) fs.writeFileSync(marker, old);
  else fs.unlinkSync(marker);
  fs.rmSync("/data/tools/codex/fixture-bridge", {
    recursive: true,
    force: true,
  });
}
