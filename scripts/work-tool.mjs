import fs from "node:fs";
const [name, input = "{}"] = process.argv.slice(2);
if (!name || name === "help") {
  console.log(
    'Work tools: node scripts/work-tool.mjs assets \'{"search":"背景"}\' | engines | engine_add \'{"name":"My TTS","url":"https://service.example/v1","model":"tts","voice":"default","apiKey":"..."}\' | engine_test \'{"engine":"UUID","text":"试听","speed":1}\' | use \'{"asset":"UUID"}\' | speech \'{"engine":"UUID","text":"正式旁白","voice":"voice-id","speed":1}\'. JSON also accepts @file or stdin (-); use these for secrets. engines lists built-ins and voices. engine_test creates only temporary audio in the work cache; speech saves narration as a work material. Built-ins are ready and immutable.',
  );
} else {
  if (!process.env.FRAME_AGENT_URL || !process.env.FRAME_AGENT_TOKEN)
    throw new Error("Available inside an active platform AI task");
  const args = JSON.parse(
    input === "-"
      ? fs.readFileSync(0, "utf8")
      : input.startsWith("@")
        ? fs.readFileSync(input.slice(1), "utf8")
        : input,
  );
  const r = await fetch(process.env.FRAME_AGENT_URL + "/api/agent/action", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.FRAME_AGENT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  console.log(await r.text());
  if (!r.ok) process.exitCode = 1;
}
