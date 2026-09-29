import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { waitForAgentAnswer } from "./agent-question-client.mjs";
const [name, input = "{}"] = process.argv.slice(2);
if (!name || name === "help") {
  console.log(`Work tools: node scripts/work-tool.mjs <action> '<JSON>'
Actions: assets {search}, engines, engine_add {name,url,model,voice,apiKey}, engine_test {engine,text,speed}, use {asset}, speech {engine,text,voice,speed}.
ask {title,questions:[{id,question,header,options:[{id,label,description}],multiSelect,allowOther}]} waits for a human answer directly in the FRAME chat and returns it to this same task. Only ask for necessary creative decisions, never passwords or API keys. At most four questions, twelve options each. Do not invent an answer or finish while waiting.
JSON accepts @file or stdin (-); use those for credentials in engine_add. engines lists ready built-ins and voices. engine_test creates temporary audio only; speech saves narration as a work material. Built-ins are immutable.`);
} else {
  if (!process.env.FRAME_AGENT_URL || !process.env.FRAME_AGENT_TOKEN) throw new Error("Available inside an active platform AI task");
  const args = JSON.parse(input === "-" ? fs.readFileSync(0, "utf8") : input.startsWith("@") ? fs.readFileSync(input.slice(1), "utf8") : input);
  if (name === "ask") {
    const answer = await waitForAgentAnswer({ ...args, requestKey: args.requestKey || randomUUID() });
    console.log(JSON.stringify({ questions: answer.payload.questions, answers: answer.answers }));
  } else {
    const r = await fetch(process.env.FRAME_AGENT_URL + "/api/agent/action", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { Authorization: "Bearer " + process.env.FRAME_AGENT_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    console.log(await r.text());
    if (!r.ok) process.exitCode = 1;
  }
}
