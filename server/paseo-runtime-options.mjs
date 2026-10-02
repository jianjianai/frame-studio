/** Managed daemons use private work authentication; accept the controller's Docker DNS Host. */
export function paseoDaemonOptions(existing = {}) {
  return { ...existing, hostnames: true, relay: { ...existing.relay, enabled: false } };
}

/** Explicit deployment URLs win; desktop startLocalApp supplies its actual bound origin. */
export function paseoCallbackUrl(workId, { localMode = false, env = process.env } = {}) {
  const base = env.FRAME_AGENT_URL || env.FRAME_PUBLIC_URL ||
    (localMode ? "http://127.0.0.1:" + (env.PORT || 3000) : "http://studio:3000");
  let url;
  try { url = new URL(base); } catch { throw Error("Configure a valid FRAME_AGENT_URL or FRAME_PUBLIC_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error("Paseo callback origin must be HTTP(S) without credentials, query or fragment");
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/paseo/internal/" + workId;
  return url.href;
}

/** Only finite, locally authored startup guidance reaches the public operation envelope. */
export function paseoUnavailable(state, detail = "") {
  const stages = { prepare: "作品准备", runtime: "运行环境检查", configuration: "服务配置",
    launch: "服务启动", health: "服务连接", registration: "作品注册" };
  const stage = /^Paseo startup \((\w+)\):/.exec(String(detail))?.[1];
  const message = state === "waiting"
    ? "创作服务正在排队或启动，请稍后重新连接此作品。"
    : "创作服务启动失败" + (stages[stage] ? "（" + stages[stage] + "）" : "") + "，草稿和历史已保留，请重新连接重试。";
  return Object.assign(Error(message), { statusCode: 503, expose: true, code: state === "waiting" ? "PASEO_START_WAITING" : "PASEO_START_FAILED",
    recovery: "reconnect", retryable: true });
}

/** Only Docker's exact missing-container diagnostic means absence; transport/permission errors remain failures. */
export async function inspectPaseoContainer(runCommand, name) {
  try {
    const value = JSON.parse(await runCommand("docker", ["inspect", "--format", "{{json .}}", name],
      { timeout: 10000, max: 256 * 1024 }));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Docker container inspection");
    return value;
  } catch (error) {
    const missing = /^(?:Error: |Error response from daemon: )?No such (?:object|container): (.+)$/i.exec(String(error.message).trim());
    if (missing?.[1] === name) return null;
    throw error;
  }
}
