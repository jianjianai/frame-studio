import fs from "node:fs";
const [name, input = "{}"] = process.argv.slice(2);
if (!name || name === "help") {
  console.log(
    'Work material tools: node scripts/work-tool.mjs assets \'{"search":"背景"}\' | engines | use \'{"asset":"UUID"}\' | speech \'{"engine":"UUID","text":"旁白"}\'. JSON also accepts @file or stdin (-). All files are saved inside the current work.',
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
