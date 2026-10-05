import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const defaults = () => ({
  version: 1,
  repos: [],
  recent: [],
  ai: { profiles: [], defaultProfile: "claude-account", permission: "edits" },
  speech: { defaultProvider: "edge", providers: {} },
  github: { accounts: [] },
  mcp: { tokens: [], clients: [], grants: [] },
});

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

function writeJson(file, value, mode = 0o644) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(temp, file);
}

/** settings.json holds everything shown in the UI; secrets.json holds keys and tokens only. */
export class Settings {
  constructor(home, events) {
    this.file = path.join(home, "settings.json");
    this.secretsFile = path.join(home, "secrets.json");
    this.events = events;
    this.data = { ...defaults(), ...readJson(this.file, {}) };
    for (const [key, value] of Object.entries(defaults()))
      if (value && typeof value === "object" && !Array.isArray(value)) this.data[key] = { ...value, ...this.data[key] };
    this.secrets = readJson(this.secretsFile, {});
  }
  get(key) {
    return structuredClone(this.data[key]);
  }
  update(key, change) {
    const next = typeof change === "function" ? change(structuredClone(this.data[key])) : change;
    this.data[key] = next;
    writeJson(this.file, this.data);
    this.events?.emit({ type: "settings", key });
    return structuredClone(next);
  }
  secret(name) {
    return this.secrets[name] || "";
  }
  setSecret(name, value) {
    if (value) this.secrets[name] = value;
    else delete this.secrets[name];
    writeJson(this.secretsFile, this.secrets, 0o600);
    fs.chmodSync(this.secretsFile, 0o600);
  }
  hasSecret(name) {
    return Boolean(this.secrets[name]);
  }
}
