import fs from "node:fs";
const [name, input = "{}"] = process.argv.slice(2);
if (!name || name === "help") {
  console.log(
    "FRAME server CLI: FRAME_URL=https://frame.example FRAME_TOKEN=... pnpm platform <operation> <JSON | @file | ->\nList operations: pnpm platform actions\nExample: pnpm platform repositories_list",
  );
} else {
  const base = process.env.FRAME_URL,
    token = process.env.FRAME_TOKEN;
  if (!base || !token) throw new Error("Set FRAME_URL and FRAME_TOKEN");
  const headers = { Authorization: "Bearer " + token };
  let response;
  if (name === "actions")
    response = await fetch(base + "/api/actions", { headers });
  else if (name === "upload") {
    const form = new FormData();
    form.set("license", process.env.FRAME_ASSET_LICENSE || "");
    form.set(
      "file",
      new Blob([fs.readFileSync(input)]),
      input.replaceAll("\\", "/").split("/").pop(),
    );
    response = await fetch(base + "/api/upload", {
      method: "POST",
      headers,
      body: form,
    });
  } else {
    const args = JSON.parse(
      input === "-"
        ? fs.readFileSync(0, "utf8")
        : input.startsWith("@")
          ? fs.readFileSync(input.slice(1), "utf8")
          : input,
    );
    response = await fetch(base + "/api/action", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
  }
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}
