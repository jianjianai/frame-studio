import fs from "node:fs";
export async function readJsonInput(file, { maxBytes = 1024 * 1024 } = {}) {
  if (!file) throw Object.assign(new Error("Use --input <JSON file> or --input -."), { code: "INVALID_ARGUMENTS" });
  let data;
  if (file === "-") {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) throw Object.assign(new Error("JSON input exceeds 1 MiB."), { code: "INPUT_TOO_LARGE" });
      chunks.push(Buffer.from(chunk));
    }
    data = Buffer.concat(chunks).toString("utf8");
  } else {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error("Expected a JSON file within 1 MiB."), { code: "INPUT_TOO_LARGE" });
    data = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(data) > maxBytes) throw Object.assign(new Error("JSON input exceeds 1 MiB."), { code: "INPUT_TOO_LARGE" });
  }
  let value;
  try { value = JSON.parse(data); }
  catch { throw Object.assign(new Error("Invalid JSON; request contents are omitted."), { code: "INVALID_JSON" }); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("Expected a JSON object."), { code: "INVALID_INPUT" });
  return value;
}
