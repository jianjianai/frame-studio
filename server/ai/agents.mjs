import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appRoot } from "../config.mjs";

const rootRequire = createRequire(path.join(appRoot, "package.json"));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function resolveFrom(pkg, request) {
  const base = createRequire(rootRequire.resolve(pkg + "/package.json"));
  return base.resolve(request);
}

/** The ACP adapters and the CLIs they bundle (used for login/logout/status). */
export const AGENTS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    adapter: () => rootRequire.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"),
    cli() {
      if (process.env.CLAUDE_CODE_EXECUTABLE) return { command: process.env.CLAUDE_CODE_EXECUTABLE, args: [] };
      const sdk = resolveFrom("@agentclientprotocol/claude-agent-acp", "@anthropic-ai/claude-agent-sdk");
      const sdkRequire = createRequire(sdk);
      const ext = process.platform === "win32" ? ".exe" : "";
      for (const name of [
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`,
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl/claude${ext}`,
      ])
        try {
          return { command: sdkRequire.resolve(name), args: [] };
        } catch {}
      throw new Error("没有找到 Claude Code 程序，请重新安装依赖");
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    adapter: () => rootRequire.resolve("@agentclientprotocol/codex-acp/dist/index.js"),
    cli() {
      if (process.env.CODEX_PATH) return { command: process.env.CODEX_PATH, args: [] };
      const pkg = resolveFrom("@agentclientprotocol/codex-acp", "@openai/codex/package.json");
      return { command: process.execPath, args: [path.join(path.dirname(pkg), "bin", "codex.js")] };
    },
  },
};

/** Environment for agents and their CLIs: node on PATH, optional dedicated HOME. */
export function agentEnv(config, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FRAME_|ANTHROPIC_|OPENAI_|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)) delete env[key];
  const home = process.env.FRAME_AGENT_HOME;
  if (home) {
    fs.mkdirSync(home, { recursive: true });
    env.HOME = home;
    env.USERPROFILE = home;
  }
  env.PATH = [path.dirname(process.execPath), path.join(appRoot, "node_modules", ".bin"), env.PATH].filter(Boolean).join(path.delimiter);
  env.DISABLE_AUTOUPDATER = "1";
  env.NO_BROWSER = "1";
  env.BROWSER = process.platform === "win32" ? "" : "true";
  return { ...env, ...extra };
}

function runCli(agent, args, env, { input, timeoutMs = 20000 } = {}) {
  const { command, args: prefix } = AGENTS[agent].cli();
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: stripAnsi(out) });
    });
  });
}

/** Whether the account login of an agent CLI is present. */
export async function accountStatus(agent, env) {
  if (agent === "claude") {
    const { out } = await runCli("claude", ["auth", "status", "--json"], env);
    try {
      const json = JSON.parse(out.slice(out.indexOf("{")));
      return {
        loggedIn: Boolean(json.loggedIn),
        method: json.authMethod,
        detail: json.email || json.organization || json.subscriptionType || json.authMethod || "",
      };
    } catch {
      return { loggedIn: false, detail: out.trim().slice(0, 200) };
    }
  }
  const { out } = await runCli("codex", ["login", "status"], env);
  const text = out
    .split("\n")
    .filter((line) => !line.startsWith("WARNING"))
    .join("\n")
    .trim();
  return { loggedIn: /logged in/i.test(text) && !/not logged in/i.test(text), detail: text.slice(0, 200) };
}

export async function logout(agent, env) {
  await runCli(agent, agent === "claude" ? ["auth", "logout"] : ["logout"], env);
}

/**
 * Start an interactive account login and report what the user must do:
 *  - Claude: open `url`, then paste the code shown by Claude into `submit(code)`.
 *  - Codex (ChatGPT): open `url` and enter `userCode`; completes by itself.
 * `onDone(result)` fires when the CLI exits.
 */
export function startLogin(agent, env, onDone) {
  const { command, args } = AGENTS[agent].cli();
  const loginArgs = agent === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"];
  const child = spawn(command, [...args, ...loginArgs], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let resolveInfo;
  const info = new Promise((resolve) => (resolveInfo = resolve));
  const scan = () => {
    const text = stripAnsi(out);
    const url = text.match(/https:\/\/\S+/g)?.find((candidate) => /oauth|authorize|device|auth\./.test(candidate));
    if (!url) return;
    if (agent === "codex") {
      const userCode = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
      if (userCode) resolveInfo({ url, userCode, needsCode: false });
    } else resolveInfo({ url, needsCode: true });
  };
  child.stdout.on("data", (chunk) => {
    out += chunk;
    scan();
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
    scan();
  });
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolveInfo({ error: stripAnsi(out).trim().slice(-500) || "登录进程已退出" });
    onDone?.({ code, output: stripAnsi(out).trim().slice(-500) });
  });
  return {
    info,
    submit(code) {
      child.stdin.write(code.trim() + "\n");
    },
    cancel() {
      child.kill();
    },
  };
}
