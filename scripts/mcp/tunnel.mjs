import { spawn, spawnSync } from "node:child_process";

export function tunnelCommand(config, environment = process.env) {
  if (!["auto", "http2", "quic"].includes(config.tunnel.protocol))
    throw new Error("Tunnel protocol must be auto, http2 or quic");
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "HOME",
    "TEMP",
    "TMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    if (environment[key]) env[key] = environment[key];
  env.TUNNEL_TOKEN = config.tunnel.token;
  return {
    command: config.tunnel.executable,
    args: [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      config.tunnel.protocol,
      "--loglevel",
      "warn",
      "run",
    ],
    options: { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  };
}
export function checkTunnel(config) {
  const result = spawnSync(config.tunnel.executable, ["--version"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new Error(
      "cloudflared not available; set CLOUDFLARED_PATH to the installed executable",
    );
  return (result.stdout || result.stderr).trim().slice(0, 200);
}
export function startTunnel(
  config,
  { onExit = () => {}, onLog = () => {} } = {},
) {
  const spec = tunnelCommand(config),
    child = spawn(spec.command, spec.args, spec.options);
  let stopping = false;
  const redact = (text) =>
    [
      config.tunnel.token,
      config.bearerToken,
      config.oauth.password,
      ...config.oauth.clients.map((c) => c.client_secret),
    ]
      .filter(Boolean)
      .reduce((s, value) => s.replaceAll(value, "[redacted]"), text);
  let pending = "";
  child.stderr.on("data", (bytes) => {
    pending += bytes.toString();
    if (pending.length > 8192) pending = pending.slice(-8192);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) onLog(redact(line).slice(0, 1000));
  });
  const ready = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) onExit({ code, signal });
  });
  return {
    child,
    ready,
    async close() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null || !child.pid)
        return;
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      timer.unref();
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
