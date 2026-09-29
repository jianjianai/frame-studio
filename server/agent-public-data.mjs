const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|signature|encrypted_content|redacted_thinking)$/i;
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
/** Only public, bounded material is persisted. Never store provider envelopes or auth. */
export function publicAgentText(value, { limit = 64000, tail = false, env = process.env } = {}) {
  let text = String(value ?? "").replace(ansi, "").replace(/\x00/g, "");
  for (const [key, secret] of Object.entries(env))
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof secret === "string" && secret.length >= 8)
      text = text.split(secret).join("[redacted]");
  text = text.replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})/g, "[redacted]")
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9_./+=-]{12,}/gi, "$1[redacted]");
  return text.length > limit ? (tail ? text.slice(-limit) : text.slice(0, limit)) : text;
}
export function publicAgentData(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return publicAgentText(value, { limit: 16000 });
  if (depth > 5) return "[nested content omitted]";
  if (Array.isArray(value)) return value.slice(0, 80).map((v) => publicAgentData(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, val]) => [
    key, sensitiveKey.test(key) ? "[redacted]" : publicAgentData(val, depth + 1),
  ]));
  return String(value);
}
export function publicToolOutput(value) {
  if (typeof value === "string") return publicAgentText(value, { limit: 32000, tail: true });
  const blocks = Array.isArray(value) ? value : value?.content || value?.contentItems;
  if (Array.isArray(blocks)) return publicAgentText(blocks.filter((b) => ["text", "inputText", "output_text"].includes(b?.type)).map((b) => b.text).join("\n"), { limit: 32000, tail: true });
  return publicAgentText(value == null ? "" : JSON.stringify(publicAgentData(value), null, 2), { limit: 32000, tail: true });
}
/** Read paths and real line counts from a unified patch; no filesystem access here. */
export function parseAgentDiff(diff, maxFiles = 100) {
  const files = [];
  let current;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (files.length >= maxFiles) break;
      const match = line.match(/^diff --git (?:"a\/(.+)"|a\/(.+)) (?:"b\/(.+)"|b\/(.+))$/);
      const path = match?.[3] || match?.[4] || "文件";
      current = { path, kind: "modify", added: 0, removed: 0, diff: "", binary: false, truncated: false };
      files.push(current);
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.kind = "add";
    if (line.startsWith("deleted file mode")) current.kind = "delete";
    if (line.startsWith("rename to ")) { current.path = line.slice(10); current.kind = "rename"; }
    if (line.startsWith("rename from ")) current.previousPath = line.slice(12);
    if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
    if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
    if (current.diff.length < 64000) current.diff += line + "\n";
    else current.truncated = true;
  }
  return files;
}
