import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { loadRemoteConfig } from "./mcp/remote-config.mjs";
import { RemoteAuth, validateOAuthClients } from "./mcp/remote-auth.mjs";
import { startRemoteServer } from "./mcp/remote-http.mjs";
import { checkTunnel, startTunnel } from "./mcp/tunnel.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "env-file": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const command = positionals[0] || "serve";
  if (positionals.length > 1) throw new Error("Unexpected arguments");
  if (values.help || command === "help")
    console.log(
      "FRAME remote MCP: pnpm film mcp-remote init|check|serve|revoke [--env-file .env] [--json]\nConfigure the public origin, exact OAuth callbacks and optional Cloudflare tunnel in the private env file.",
    );
  else if (command === "init") {
    const file = path.resolve(root, values["env-file"] || ".env");
    const text = fs
      .readFileSync(path.join(root, ".env.example"), "utf8")
      .replace(
        "REPLACE_WITH_RANDOM_TOKEN",
        randomBytes(32).toString("base64url"),
      )
      .replace(
        "REPLACE_WITH_PRIVATE_PASSWORD",
        randomBytes(24).toString("base64url"),
      );
    fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        status: "created",
        file,
        next: "Edit public URL, project ids and exact OAuth callbacks. Enable the tunnel only after configuring its hostname and token. Secrets were saved, not printed.",
      }),
    );
  } else {
    const config = loadRemoteConfig(root, {
      envFile: values["env-file"] || ".env",
    });
    if (command === "check") {
      validateOAuthClients(config);
      const tunnel = config.tunnel.enabled ? checkTunnel(config) : "disabled";
      console.log(
        JSON.stringify({
          status: "valid",
          endpoint: config.resource,
          auth: config.mode,
          projects: config.projects.length ? config.projects : "*",
          readOnly: config.readOnly,
          tunnel,
          liveConnection: "not_checked",
        }),
      );
    } else if (command === "revoke") {
      const auth = new RemoteAuth(config);
      try {
        auth.revokeAll();
      } finally {
        auth.close();
      }
      console.log(
        JSON.stringify({
          status: "revoked",
          message:
            "OAuth authorizations revoked. For static Bearer tokens, rotate the env value and restart.",
        }),
      );
    } else if (command === "serve") {
      if (config.tunnel.enabled) checkTunnel(config);
      const app = await startRemoteServer(config);
      let tunnel, closing;
      const close = () =>
        (closing ??= (async () => {
          try {
            await tunnel?.close();
          } finally {
            await app.close();
          }
        })().catch(() => {
          console.error(
            "[frame-remote] Shutdown failed; inspect the local state lock.",
          );
          process.exitCode = 1;
        }));
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      try {
        if (config.tunnel.enabled) {
          tunnel = startTunnel(config, {
            onExit: ({ code }) => {
              console.error(
                "[frame-remote] Tunnel exited (" + code + "); shutting down.",
              );
              process.exitCode = 1;
              void close();
            },
            onLog: (line) => console.error("[cloudflared]", line),
          });
          await tunnel.ready;
        }
        console.log(
          JSON.stringify({
            status: "listening",
            local: app.url,
            endpoint: config.resource,
            auth: config.mode,
            tunnel: config.tunnel.enabled
              ? "process_started; external reachability not yet verified"
              : "disabled",
          }),
        );
      } catch (error) {
        await close();
        throw error;
      }
    } else throw new Error("Use init, check, serve or revoke");
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      error:
        error.code === "EEXIST"
          ? "Configuration already exists; it was not overwritten."
          : error.message,
    }),
  );
  process.exitCode = 1;
}
