import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import os from "node:os";
import { resolveExecution } from "./execution-selection.mjs";
import { freezePaseoExecution, paseoExecutionConfig } from "./paseo-selection.mjs";
import { confinedAsync } from "./project-files.mjs";
import { atomicPaseoJson } from "./paseo-manager.mjs";
import { problem, hash } from "./security.mjs";

export const paseoSessionOpenSchema = z.strictObject({
  version: z.literal(1), agentId: z.string().min(1).max(256), workspaceId: z.string().nullable(),
  provider: z.string().min(1).max(256), cwd: z.string().min(1).max(4096),
  reason: z.enum(["create", "resume", "refresh", "import"]), purpose: z.enum(["interactive", "history"]),
});

/** Credentials are resolved only for the selected native profile and never enter the public daemon config. */
export async function paseoSessionEnvironment({ workId, request, manager, workService, connections, db, secrets, data, localMode }) {
  const input = paseoSessionOpenSchema.parse(request);
  const work = await workService.works.get(workId, { active: true });
  const workspace = await manager.resolveAgentWorkspace(workId, input.cwd);
  const canonicalCwd = path.resolve(input.cwd);
  const binding = await manager.store.getWork(workId);
  if (binding?.workspaceId && input.workspaceId && input.workspaceId !== binding.workspaceId &&
      workspace.nativeCheckout === (localMode ? workspace.prepared.workspace.workspaceRoot : "/workspace"))
    throw problem(409, "Native workspace identity changed");
  let agent = null;
  if (input.reason !== "create" && input.reason !== "import") {
    agent = await manager.agent(workId, input.agentId);
    if (!agent || agent.provider !== input.provider || path.resolve(agent.cwd) !== canonicalCwd)
      throw problem(404, "Native agent does not belong to this work or profile");
  }
  const env = { FRAME_PROJECT: work.project, FRAME_PASEO_WORK_ID: workId,
    FRAME_PASEO_AGENT_ID: input.agentId, FRAME_AGENT_TOKEN: await manager.agentCredential(workId, input.agentId) };
  const match = /^frame-([0-9a-f-]{36})$/i.exec(input.provider);
  if (!match) return { version: 1, env }; // Official/custom/ACP native profiles keep their own configuration.
  const connectionId = z.uuid().parse(match[1]);
  // The desktop's selected official CLI may authenticate through its own environment.
  // These keys are issued to that session only, never to the daemon or another provider.
  const localOfficialEnvironment = tool => {
    const names = tool === "codex" ? ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]
      : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    return Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  };

  return db.lock("paseo-profile:" + workId + ":" + input.agentId, async () => {
    const config = await connections.resolve(connectionId);
    if (config.enabled === false || !["codex", "claude"].includes(config.tool))
      throw problem(409, "This FRAME provider profile is unavailable");
    const selection = await freezePaseoExecution({ db, connections, secrets, connection: connectionId,
      config, model: agent?.model ?? config.model });
    const recordPath = await confinedAsync(data, "paseo/" + workId + "/launches/" + input.agentId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
    const localAuth = localMode && config.mode === "official" ? localOfficialEnvironment(config.tool) : {};
    const hasLocalKey = config.tool === "codex" ? !!(localAuth.CODEX_API_KEY || localAuth.OPENAI_API_KEY)
      : !!(localAuth.ANTHROPIC_API_KEY || localAuth.ANTHROPIC_AUTH_TOKEN);
    const localAuthIdentity = hasLocalKey ? hash(JSON.stringify(localAuth)) : null;
    const old = await fs.readFile(recordPath, "utf8").then(JSON.parse).catch(error => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (old && (old.agentId !== input.agentId || old.workId !== workId)) throw problem(409, "Native launch identity conflict");
    if (old && (old.localAuthIdentity ?? null) !== localAuthIdentity)
      throw problem(409, "本机 CLI 登录身份已变化，请新建会话后发送");
    const previous = old ? { ...old.selection, model: selection.model } : selection;
    resolveExecution(previous, paseoExecutionConfig(config), config.tool);
    const home = await confinedAsync(data, "paseo/" + workId + "/home/profiles/" + input.provider + "/generation-" + selection.authGeneration);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const nativeHome = localMode ? home : "/paseo-home/profiles/" + input.provider + "/generation-" + selection.authGeneration;
    env[config.tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = nativeHome;
    if (config.mode === "official" && !hasLocalKey) {
      const origin = localMode
        ? (config.tool === "codex" ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
          : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"))
        : await confinedAsync(data, "auth/" + connectionId + "/" + config.tool);
      const stamp = path.join(home, ".frame-auth-generation");
      const installed = await fs.readFile(stamp, "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error; return null;
      });
      if (installed !== selection.authGeneration) {
        if (installed !== null) throw problem(409, "Provider login identity changed; create a new native agent");
        const names = config.tool === "codex" ? ["auth.json"] : [".credentials.json"];
        let credentials = 0;
        for (const name of names) {
          const source = path.join(origin, name);
          const stat = await fs.lstat(source).catch(error => {
            if (error.code !== "ENOENT") throw error; return null;
          });
          if (!stat) continue;
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1024 * 1024)
            throw problem(409, "Provider login credential file is invalid");
          await fs.copyFile(source, path.join(home, name));
          await fs.chmod(path.join(home, name), 0o600);
          credentials++;
        }
        if (!credentials) throw problem(409, "Provider login credentials are missing; sign in again");
        await fs.writeFile(stamp, selection.authGeneration, { mode: 0o600 });
      }
    }
    if (hasLocalKey) Object.assign(env, localAuth);
    if (config.apiKey) {
      if (config.tool === "claude") {
        env.ANTHROPIC_API_KEY = config.apiKey;
        if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
      } else {
        env.CODEX_API_KEY = config.apiKey;
        env.OPENAI_API_KEY = config.apiKey;
        if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
      }
    }
    await atomicPaseoJson(recordPath, { version: 1, workId, agentId: input.agentId, selection, localAuthIdentity });
    return { version: 1, env };
  });
}
