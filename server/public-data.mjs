const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
/** Only public, bounded material is persisted. Never store provider envelopes or auth. */
export function publicText(
  value,
  { limit = 64000, tail = false, env = process.env } = {},
) {
  let text = String(value ?? "")
    .replace(ansi, "")
    .replace(/\x00/g, "");
  for (const [key, secret] of Object.entries(env))
    if (
      /KEY|TOKEN|SECRET|PASSWORD/i.test(key) &&
      typeof secret === "string" &&
      secret.length >= 8
    )
      text = text.split(secret).join("[redacted]");
  text = text
    .replace(
      /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})/g,
      "[redacted]",
    )
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9_./+=-]{12,}/gi, "$1[redacted]");
  return text.length > limit
    ? tail
      ? text.slice(-limit)
      : text.slice(0, limit)
    : text;
}
