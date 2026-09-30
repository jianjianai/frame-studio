import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { command } from "./process.mjs";
import { localToolBinary } from "./local-tools.mjs";
import {
  providerModelsSchema,
  providerModels,
} from "../src/contracts/ai-models.mjs";
import { discoverModels, recordConnectionTest } from "./provider-catalog.mjs";
import {
  deleteProvider,
  providerUsage,
  normalizeProviderUrl,
} from "./provider-lifecycle.mjs";
import { problem, hash } from "./security.mjs";

export function toolBinary(data, tool) {
  const bin = tool === "codex" ? "codex" : "claude";
  if (process.env.FRAME_LOCAL_MODE === "1") return localToolBinary(bin);
  const marker = path.join(data, "tools", tool, "current");
  if (!fs.existsSync(marker)) return bin;
  const version = fs.readFileSync(marker, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw problem(500, "Invalid tool version marker");
  return path.join(data, "tools", tool, version, "node_modules", ".bin", bin);
}
const localToolCache = new Map();
async function localToolAvailable(data, tool) {
  return (await localToolStatus(data, tool)).ready;
}
async function localToolStatus(data, tool, refresh = false) {
  const old = localToolCache.get(tool);
  if (!refresh && old && Date.now() - old.checked < 15000) return old.status;
  const binary = toolBinary(data, tool);
  const version = await command(binary, ["--version"], { timeout: 10000 }).catch(() => "");
  let ready = false;
  if (version) {
    const auth = await command(binary, tool === "codex" ? ["login", "status"] : ["auth", "status"], { timeout: 10000, combined: true }).catch(() => null);
    ready = auth !== null && !/"loggedIn"\s*:\s*false|not logged in/i.test(auth);
  }
  const status = { tool, installed: !!version, ready, version: version.slice(0, 160), path: version ? binary : "", state: !version ? "unavailable" : ready ? "ready" : "unconfigured", message: !version ? "本机未找到 CLI，请安装后重新检测。" : ready ? "已安装并登录，可以创作。" : "已安装，请先登录后重新检测。" };
  localToolCache.set(tool, { checked: Date.now(), status });
  return status;
}

export class Connections {
  constructor(db, data, secrets) {
    Object.assign(this, { db, data, secrets });
    this.children = new Map();
  }
  async localStatus(refresh = false) {
    return Promise.all(["codex", "claude"].map(tool => localToolStatus(this.data, tool, refresh)));
  }
  async list() {
    const rows = await this.db.all(
        "SELECT * FROM connections WHERE state<>'deleted' ORDER BY created",
      );
    const available = process.env.FRAME_LOCAL_MODE === "1"
      ? Object.fromEntries((await this.localStatus()).map(status => [status.tool, status]))
      : null;
    return rows.map((row) => {
      const c = this.secrets.decrypt(row.config);
      return {
        ...row,
        config: undefined,
        revision: hash(row.name + "\n" + row.config),
        baseUrl: c.baseUrl || "",
        publicCatalog: c.publicCatalog !== false,
        model: c.model || "",
        models:
          c.models ||
          (c.model
            ? [{ id: c.model, name: c.model.slice(0, 100), enabled: true }]
            : []),
        enabled: c.enabled !== false,
        lastTest: c.lastTest || null,
        configured:
          available && row.mode === "official" ? available[row.tool].ready
            : row.mode === "official" ? row.state === "ready" : !!c.apiKey,
        ...(available && row.mode === "official" ? { state: available[row.tool].state, error: available[row.tool].ready ? null : available[row.tool].message, localRuntime: available[row.tool] } : {}),
      };
    });
  }
  async save({
    id = randomUUID(),
    name,
    tool,
    mode,
    baseUrl = "",
    model = "",
    apiKey,
    models,
    enabled,
    expectedRevision,
    publicCatalog,
  }) {
    if (process.env.FRAME_LOCAL_MODE === "1" &&
      (mode !== "official" || !["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].includes(id) || apiKey))
      throw problem(400, "本地模式只使用电脑上已安装的 Codex 和 Claude CLI");
    baseUrl = normalizeProviderUrl(baseUrl, tool);
    const old = await this.db.one("SELECT * FROM connections WHERE id=$1", [
      id,
    ]);
    if (old?.state === "deleted")
      throw problem(404, "提供商已删除，不能重新保存；请新建提供商");
    if (old && (old.tool !== tool || old.mode !== mode))
      throw problem(
        409,
        "Create another connection to change tool or authentication type",
      );
    if (
      old &&
      expectedRevision &&
      expectedRevision !== hash(old.name + "\n" + old.config)
    )
      throw problem(409, "提供商配置已在其他位置更新，请重新打开配置后再保存");
    const config = old ? this.secrets.decrypt(old.config) : {};
    if (publicCatalog !== undefined) config.publicCatalog = publicCatalog;
    if (enabled !== undefined) config.enabled = enabled;
    if (models !== undefined)
      config.models = providerModelsSchema.parse(models);
    if (config.models) {
      if (
        model &&
        !config.models.some((entry) => entry.id === model && entry.enabled)
      )
        throw problem(400, "默认模型必须属于已启用的模型列表");
      if (
        mode === "api" &&
        config.models.length &&
        !model &&
        config.enabled !== false
      )
        throw problem(400, "请从已启用模型中选择默认模型");
    }
    if (
      config.baseUrl !== baseUrl ||
      apiKey ||
      config.model !== model ||
      models !== undefined
    )
      delete config.lastTest;
    const identityChanged = Boolean(apiKey && apiKey !== config.apiKey);
    Object.assign(config, { baseUrl, model });
    if (apiKey) config.apiKey = apiKey;
    const state =
      mode === "api"
        ? config.apiKey
          ? "ready"
          : "unconfigured"
        : old?.state || "unconfigured";
    if (old) {
      const saved = await this.db.pool.query(
        "UPDATE connections SET name=$2,config=$3,state=$4,error=NULL,auth_generation=auth_generation+$7 WHERE id=$1 AND config=$5 AND name=$6 AND state<>'deleted'",
        [id, name, this.secrets.encrypt(config), state, old.config, old.name, identityChanged ? 1 : 0],
      );
      if (!saved.rowCount)
        throw problem(409, "提供商配置刚刚发生变化，请重新打开后保存");
    } else {
      await this.db.pool.query(
        "INSERT INTO connections(id,name,tool,mode,config,state) VALUES($1,$2,$3,$4,$5,$6)",
        [id, name, tool, mode, this.secrets.encrypt(config), state],
      );
    }
    return (await this.list()).find((x) => x.id === id);
  }
  async resolve(id) {
    const row = await this.db.one("SELECT * FROM connections WHERE id=$1", [
      id,
    ]);
    if (!row || row.state === "deleted")
      throw problem(404, "提供商已删除或不存在");
    if (row.state !== "ready")
      throw problem(409, "请先连接或重新登录这个模型提供商");
    if (process.env.FRAME_LOCAL_MODE === "1" && row.mode === "official" && !(await localToolAvailable(this.data, row.tool)))
      throw problem(409, `${row.tool === "codex" ? "Codex" : "Claude"} CLI 未安装或不可用`);
    const config = this.secrets.decrypt(row.config);
    if (config.enabled === false)
      throw problem(409, "此提供商已停用，请在设置中启用");
    return { ...row, ...config };
  }
  async selection(id, model) {
    const config = await this.resolve(id);
    const selected = model === undefined ? config.model || "" : model;
    if (
      !providerModels(config).some(
        (entry) => entry.id === selected && entry.enabled !== false,
      )
    )
      throw problem(400, "所选模型已停用或不属于此提供商，请重新选择");
    return { ...config, model: selected };
  }
  async setEnabled(id, enabled) {
    const row = await this.db.one("SELECT * FROM connections WHERE id=$1", [
      id,
    ]);
    if (!row || row.state === "deleted")
      throw problem(404, "提供商已删除或不存在");
    const config = this.secrets.decrypt(row.config);
    config.enabled = enabled;
    const result = await this.db.pool.query(
      "UPDATE connections SET config=$2 WHERE id=$1 AND config=$3",
      [id, this.secrets.encrypt(config), row.config],
    );
    if (!result.rowCount)
      throw problem(409, "提供商配置刚刚发生变化，请刷新后重试");
    return (await this.list()).find((entry) => entry.id === id);
  }
  async discover(id) {
    const row = await this.db.one("SELECT * FROM connections WHERE id=$1", [
      id,
    ]);
    if (!row || row.state === "deleted")
      throw problem(404, "提供商已删除或不存在");
    return discoverModels(
      { ...row, ...this.secrets.decrypt(row.config) },
      fetch,
      this.catalogLoader,
    );
  }
  async usage(id) {
    return providerUsage(this.db, id);
  }
  async delete(args) {
    if (process.env.FRAME_LOCAL_MODE === "1")
      throw problem(400, "本地模式的 CLI 连接不能删除");
    return deleteProvider(this, args);
  }
  async test(id, model) {
    const row = await this.db.one("SELECT * FROM connections WHERE id=$1", [
      id,
    ]);
    if (!row || row.state === "deleted")
      throw problem(404, "提供商已删除或不存在");
    const config = this.secrets.decrypt(row.config),
      started = Date.now();
    if (model !== undefined) {
      if (
        !providerModels({ ...row, ...config }).some(
          (entry) => entry.id === model && entry.enabled !== false,
        )
      )
        throw problem(400, "模型不属于此提供商或已停用");
      config.model = model;
    }
    const saveTest = (ok, message) =>
      recordConnectionTest(this, id, config, {
        ok,
        model: config.model || "",
        at: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        message,
      });
    try {
      if (row.mode === "official") {
        const root = path.join(this.data, "auth", id);
        await command(
          toolBinary(this.data, row.tool),
          row.tool === "codex" ? ["login", "status"] : ["auth", "status"],
          {
            env: process.env.FRAME_LOCAL_MODE === "1" ? process.env : {
              HOME: root,
              CODEX_HOME: path.join(root, "codex"),
              CLAUDE_CONFIG_DIR: path.join(root, "claude"),
              OPENAI_API_KEY: "",
              CODEX_API_KEY: "",
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
            },
            timeout: 20000,
          },
        );
      } else {
        if (!config.model || !config.apiKey)
          throw problem(400, "请先填写模型名称和 API Key");
        const codex = row.tool === "codex",
          base = (
            config.baseUrl ||
            (codex ? "https://api.openai.com/v1" : "https://api.anthropic.com")
          ).replace(/\/$/, "");
        const response = await fetch(
          base +
            (codex
              ? "/responses"
              : base.endsWith("/v1")
                ? "/messages"
                : "/v1/messages"),
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              ...(codex
                ? { Authorization: "Bearer " + config.apiKey }
                : {
                    "x-api-key": config.apiKey,
                    "anthropic-version": "2023-06-01",
                  }),
            },
            body: JSON.stringify(
              codex
                ? {
                    model: config.model,
                    input: "Reply with READY.",
                    max_output_tokens: 64,
                    store: false,
                  }
                : {
                    model: config.model,
                    messages: [{ role: "user", content: "Reply with READY." }],
                    max_tokens: 64,
                  },
            ),
            signal: AbortSignal.timeout(45000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw problem(
            502,
            `模型测试失败（HTTP ${response.status}），请检查地址、模型及凭据`,
          );
        }
        const result = await response.json();
        if (result.error || result.type === "error")
          throw problem(502, "模型服务返回错误，请检查连接配置");
      }
      await this.db.pool.query(
        "UPDATE connections SET state='ready',error=NULL WHERE id=$1 AND state<>'deleted'",
        [id],
      );
      await saveTest(
        true,
        row.mode === "official"
          ? "官方账号登录有效；模型能力需在创作时确认"
          : "模型请求成功",
      );
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        message:
          row.mode === "official"
            ? "官方 CLI 已确认登录；实际模型可用性在创作时检查"
            : "模型请求成功",
      };
    } catch (error) {
      const message = error.statusCode
        ? error.message
        : row.mode === "official"
          ? "官方登录检查失败，请重新登录"
          : "模型连接失败或超时，请检查服务地址与网络";
      await saveTest(false, message);
      if (row.mode === "official" && process.env.FRAME_LOCAL_MODE !== "1")
        await this.db.pool.query(
          "UPDATE connections SET state='expired',error=$2 WHERE id=$1 AND state<>'deleted'",
          [id, message],
        );
      throw problem(error.statusCode || 502, message);
    }
  }
  async migrate() {
    if (process.env.FRAME_LOCAL_MODE === "1") {
      for (const [tool, id] of [["codex", "00000000-0000-4000-8000-000000000001"], ["claude", "00000000-0000-4000-8000-000000000002"]]) {
        if (await this.db.one("SELECT id FROM connections WHERE id=$1", [id])) continue;
        await this.save({ id, name: tool === "codex" ? "本机 Codex CLI" : "本机 Claude CLI", tool, mode: "official" });
        await this.db.pool.query("UPDATE connections SET state='ready' WHERE id=$1", [id]);
      }
      return;
    }
    if (!(await this.db.one("SELECT id FROM connections LIMIT 1"))) {
      for (const tool of ["codex", "claude"]) {
        const old = await this.db.setting(tool);
        const c = old?.encrypted ? this.secrets.decrypt(old.encrypted) : {};
        if (c.apiKey) {
          const connection = await this.save({
            name: tool === "codex" ? "Codex 默认连接" : "Claude 默认连接",
            tool,
            mode: "api",
            ...c,
          });
          await this.db.pool.query(
            "UPDATE chats SET connection=$1 WHERE provider=$2 AND connection IS NULL",
            [connection.id, tool],
          );
        }
      }
    }
    await this.db.pool.query(
      "UPDATE auth_flows SET state='expired' WHERE state='pending'",
    );
  }
  async begin(kind, target) {
    if (process.env.FRAME_LOCAL_MODE === "1" && kind !== "github")
      throw problem(400, `请在电脑终端运行 ${kind === "codex" ? "codex login" : "claude auth login"}，然后返回工作台检查登录`);
    const begin = () => this.beginLocked(kind, target);
    return kind === "github" ? begin() : this.db.lock(`connection:${target}`, begin);
  }
  async beginLocked(kind, target) {
    if (kind !== "github") {
      const row = await this.db.one("SELECT * FROM connections WHERE id=$1", [
        target,
      ]);
      if (
        !row ||
        row.state === "deleted" ||
        row.mode !== "official" ||
        row.tool !== kind
      )
        throw problem(400, "Choose an official account connection");
      if (
        await this.db.one(
          "SELECT id FROM tasks WHERE input->>'connection'=$1 AND state IN ('running','cancelling') LIMIT 1",
          [target],
        )
      )
        throw problem(409, "请先停止使用该账号的创作");
    }
    return this.db.lock(`login:${target || kind}`, async () => {
      const pending = await this.db.one(
        "SELECT * FROM auth_flows WHERE kind=$1 AND target IS NOT DISTINCT FROM $2 AND state='pending' AND expires>now()",
        [kind, target || null],
      );
      if (pending) return pending;
      const id = randomUUID();
      const root = path.join(
        this.data,
        "auth",
        kind === "github" ? id : target,
      );
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const env = {
        ...process.env,
        HOME: root,
        GH_CONFIG_DIR: root,
        GH_PROMPT_DISABLED: "1",
        GH_BROWSER: "/bin/true",
        BROWSER: "/bin/true",
        CODEX_HOME: path.join(root, "codex"),
        CLAUDE_CONFIG_DIR: path.join(root, "claude"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      };
      for (const key of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
      ])
        delete env[key];
      const args =
        kind === "github"
          ? [
              "auth",
              "login",
              "--hostname",
              "github.com",
              "--git-protocol",
              "https",
              "--web",
            ]
          : kind === "codex"
            ? ["login", "--device-auth"]
            : ["auth", "login"];
      fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
      fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      await this.db.pool.query(
        "INSERT INTO auth_flows(id,target,kind,expires) VALUES($1,$2,$3,now()+interval '15 minutes')",
        [id, target || null, kind],
      );
      if (kind !== "github") await this.db.pool.query(
        "UPDATE connections SET auth_generation=auth_generation+1,state='authorizing',error=NULL WHERE id=$1", [target],
      );
      const child = spawn(
        kind === "github" ? "gh" : toolBinary(this.data, kind),
        args,
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      this.children.set(id, child);
      let output = "",
        saving = Promise.resolve(),
        finished = false;
      const inspect = (chunk) => {
        output = (output + chunk.toString())
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
          .slice(-16000);
        const urls = [...output.matchAll(/https:\/\/[^\s<>"\x1b]+/g)].map(
          (x) => x[0],
        );
        const url = urls.find((value) => {
          try {
            return [
              "github.com",
              "auth.openai.com",
              "chatgpt.com",
              "claude.ai",
              "console.anthropic.com",
              "platform.claude.com",
            ].includes(new URL(value).hostname);
          } catch {
            return false;
          }
        });
        const code =
          output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] ||
          output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0];
        const info = {
          url,
          code,
          needsCode: kind === "claude",
          message:
            kind === "claude"
              ? "在官方页面授权后，将返回的验证码粘贴到这里。"
              : "打开官方页面完成授权；此页面会自动更新。",
        };
        saving = saving
          .then(() =>
            this.db.pool.query(
              "UPDATE auth_flows SET info=$2 WHERE id=$1 AND state='pending'",
              [id, info],
            ),
          )
          .catch(() => {});
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
      timer.unref();
      const finish = async (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.children.delete(id);
        await saving;
        try {
          if (code !== 0) throw new Error("授权未完成或已过期，请重新登录");
          let linked = target;
          if (kind === "github") {
            const token = await command(
              "gh",
              ["auth", "token", "--hostname", "github.com"],
              { env },
            );
            linked = (await this.github.connect(token, target)).id;
          } else {
            await command("chown", ["-R", "1000:1000", root]);
            await this.db.pool.query(
              "UPDATE connections SET state='ready',error=NULL WHERE id=$1 AND state<>'deleted'",
              [target],
            );
          }
          await this.db.pool.query(
            "UPDATE auth_flows SET state='succeeded',target=$2,info='{}' WHERE id=$1",
            [id, linked],
          );
        } catch (e) {
          await this.db.pool.query(
            "UPDATE auth_flows SET state='failed',info=$2 WHERE id=$1",
            [id, { message: e.message }],
          );
        } finally {
          if (kind === "github")
            fs.rmSync(root, { recursive: true, force: true });
        }
      };
      child.once("error", () => {
        void finish(1).catch(() => {});
      });
      child.once("close", (code) => {
        void finish(code).catch(() => {});
      });
      child.stdin.on("error", () => {});
      if (kind === "github") child.stdin.write("\n");
      return this.flow(id);
    });
  }
  async flow(id) {
    const row = await this.db.one("SELECT * FROM auth_flows WHERE id=$1", [id]);
    if (!row) throw problem(404, "Login not found");
    if (
      row.state === "pending" &&
      new Date(row.expires).getTime() <= Date.now()
    ) {
      this.children.get(id)?.kill("SIGTERM");
      row.state = "expired";
      await this.db.pool.query(
        "UPDATE auth_flows SET state='expired',info='{}' WHERE id=$1",
        [id],
      );
    }
    return row;
  }
  async submit(id, code) {
    const flow = await this.flow(id);
    const child = this.children.get(id);
    if (flow.kind !== "claude" || flow.state !== "pending" || !child)
      throw problem(409, "Login expired; start again");
    if (!code.trim() || /[\r\n\x00]/.test(code))
      throw problem(400, "Invalid authorization code");
    child.stdin.write(code.trim() + "\n");
    return { ok: true };
  }
  close() {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}
