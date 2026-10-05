import { randomUUID } from "node:crypto";
import { AiManager } from "./manager.mjs";
import { accountStatus, agentEnv, logout, startLogin } from "./agents.mjs";
import { PROVIDER_PRESETS } from "./profiles.mjs";
import { readJson, sendFile } from "../http.mjs";
import { problem, notFound } from "../util.mjs";

export function aiPlugin(services) {
  const { router, settings, events } = services;
  const ai = (services.ai = new AiManager(services));
  const logins = new Map();
  services.closers.push(() => ai.close());

  // ---- profiles, accounts ---------------------------------------------------
  router.get("/api/ai/profiles", () => ({
    profiles: ai.profiles.list(),
    presets: PROVIDER_PRESETS,
    defaultProfile: settings.get("ai").defaultProfile,
    autoCommit: settings.get("ai").autoCommit,
    permission: settings.get("ai").permission || "edits",
  }));
  router.post("/api/ai/profiles", async ({ req }) => ai.profiles.save(await readJson(req)));
  router.delete("/api/ai/profiles/:id", ({ params }) => ai.profiles.remove(params.id));
  router.patch("/api/ai/settings", async ({ req }) => {
    const body = await readJson(req);
    return settings.update("ai", (current) => ({
      ...current,
      ...(body.defaultProfile ? { defaultProfile: ai.profiles.get(body.defaultProfile).id } : {}),
      ...("autoCommit" in body ? { autoCommit: Boolean(body.autoCommit) } : {}),
      ...(["ask", "edits", "auto", "full"].includes(body.permission) ? { permission: body.permission } : {}),
    }));
  });
  router.get("/api/ai/accounts/:agent", async ({ params }) => {
    if (!["claude", "codex"].includes(params.agent)) throw notFound("未知 AI");
    return accountStatus(params.agent, agentEnv(services.config));
  });
  router.post("/api/ai/accounts/:agent/logout", async ({ params }) => {
    if (!["claude", "codex"].includes(params.agent)) throw notFound("未知 AI");
    await logout(params.agent, agentEnv(services.config));
    for (const [key, entry] of ai.processes)
      if (entry.process.agent === params.agent && entry.process.profile.kind === "account") {
        ai.processes.delete(key);
        entry.process.kill();
      }
    return accountStatus(params.agent, agentEnv(services.config));
  });
  /** Start an account login. Returns a URL (and a device code for ChatGPT). */
  router.post("/api/ai/accounts/:agent/login", async ({ params }) => {
    if (!["claude", "codex"].includes(params.agent)) throw notFound("未知 AI");
    for (const login of logins.values()) if (login.agent === params.agent) login.flow.cancel();
    const id = randomUUID();
    const flow = startLogin(params.agent, agentEnv(services.config), async (result) => {
      logins.delete(id);
      const status = await accountStatus(params.agent, agentEnv(services.config));
      events.emit({ type: "ai-login", id, agent: params.agent, done: true, status, output: status.loggedIn ? "" : result.output });
    });
    logins.set(id, { agent: params.agent, flow });
    const info = await Promise.race([flow.info, new Promise((resolve) => setTimeout(() => resolve({ error: "登录程序没有返回登录地址" }), 30000))]);
    if (info.error) {
      flow.cancel();
      throw problem(502, info.error);
    }
    return { id, ...info };
  });
  router.post("/api/ai/logins/:id/code", async ({ params, req }) => {
    const login = logins.get(params.id);
    if (!login) throw notFound("登录已结束，请重新开始");
    const { code } = await readJson(req);
    if (!code?.trim()) throw problem(400, "请粘贴授权码");
    login.flow.submit(code);
    return { ok: true };
  });
  router.delete("/api/ai/logins/:id", ({ params }) => {
    logins.get(params.id)?.flow.cancel();
    logins.delete(params.id);
  });

  // ---- sessions -----------------------------------------------------------------
  router.get("/api/ai/sessions", ({ query }) => ai.list({ work: query.work, repo: query.repo }));
  router.post("/api/ai/sessions", async ({ req }) => ai.create(await readJson(req)));
  router.get("/api/ai/sessions/:id", ({ params }) => ({
    session: ai.publicMeta(ai.get(params.id)),
    transcript: ai.transcript(params.id),
    pending: [...ai.permissions].filter(([, item]) => item.session === params.id).map(([id]) => id),
  }));
  router.patch("/api/ai/sessions/:id", async ({ params, req }) => {
    const body = await readJson(req);
    if (body.title) ai.rename(params.id, body.title);
    if (body.profile) return ai.switchProfile(params.id, body);
    if (body.configId) return ai.setConfig(params.id, body.configId, body.value);
    return ai.publicMeta(ai.get(params.id));
  });
  router.delete("/api/ai/sessions/:id", ({ params }) => ai.remove(params.id));
  router.get("/api/ai/sessions/:id/images/:name", ({ params, req, res }) =>
    sendFile(req, res, ai.imageFile(params.id, params.name), { cache: "private, max-age=31536000, immutable" }),
  );
  router.post("/api/ai/sessions/:id/prompt", async ({ params, req }) => ai.prompt(params.id, await readJson(req)));
  router.post("/api/ai/sessions/:id/cancel", ({ params }) => ai.cancel(params.id));
  router.post("/api/ai/permissions/:id", async ({ params, req }) => {
    const { optionId } = await readJson(req);
    ai.respondPermission(params.id, optionId);
  });
}
