import fs from "node:fs/promises";
try {
  const value = JSON.parse(await fs.readFile("/tmp/frame-controller-health.json", "utf8"));
  if (!value.connected || value.ready === false || Date.now() - value.checked > 40000) process.exitCode = 1;
} catch { process.exitCode = 1; }
