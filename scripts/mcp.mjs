import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createFrameServer } from "./mcp/server.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(
    "FRAME MCP: node scripts/mcp.mjs [--project <id>]... [--read-only] [--job-timeout-seconds 600]\nWorkspace is fixed to this script's checkout. stdout is reserved for MCP.",
  );
} else {
  try {
    const options = {
      root: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      projects: [],
      readOnly: false,
      timeoutMs: 600000,
    };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg !== "--project" && seen.has(arg))
        throw new Error("Duplicate option: " + arg);
      seen.add(arg);
      if (
        arg === "--project" &&
        args[index + 1] &&
        !args[index + 1].startsWith("--")
      )
        options.projects.push(args[++index]);
      else if (arg === "--read-only") options.readOnly = true;
      else if (arg === "--job-timeout-seconds" && args[index + 1]) {
        const seconds = Number(args[++index]);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
          throw new Error("Job timeout must be 1..3600 seconds.");
        options.timeoutMs = seconds * 1000;
      } else throw new Error("Unknown or incomplete option: " + arg);
    }
    const sessions = new Set();
    // Factory invocation is owned by the SDK's modern/legacy protocol negotiation.
    const handle = serveStdio(
      () => {
        const session = createFrameServer(options);
        sessions.add(session);
        return session.server;
      },
      { onerror: (error) => console.error("[frame-mcp]", error.message) },
    );
    let closing;
    const close = () => {
      closing ??= (async () => {
        await Promise.all([...sessions].map((session) => session.close()));
        await handle.close();
      })().catch((error) => {
        console.error("[frame-mcp]", error.message);
        process.exitCode = 1;
      });
      return closing;
    };
    process.stdin.once("end", close);
    process.stdin.once("close", close);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    console.error("[frame-mcp]", error.message);
    process.exitCode = 1;
  }
}
