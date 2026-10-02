import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { command } from "../../server/process.mjs";
import { prepareDaemonSpeechModels } from "./speech-models.mjs";

const control = JSON.parse(
  await fs.readFile(process.env.FRAME_PASEO_CONTROL, "utf8"),
);
if (
  control.workId !== process.env.FRAME_PASEO_WORK_ID ||
  typeof control.capability !== "string"
)
  throw Error("Paseo work control identity mismatch");
const env = {
  ...process.env,
  PASEO_PASSWORD: control.capability,
  FRAME_PASEO_TOKEN: control.capability,
  FRAME_AGENT_TOKEN: control.workId + "." + control.capability,
  FRAME_AGENT_URL: process.env.FRAME_PASEO_URL.replace(
    /\/api\/paseo\/internal\/[^/]+$/,
    "",
  ),
  PASEO_WEB_UI_ENABLED: "false",
  PASEO_RELAY_ENABLED: "false",
  PASEO_LOG_FORMAT: "json",
  CODEX_HOME: path.join(process.env.HOME, ".codex"),
  CLAUDE_CONFIG_DIR: path.join(process.env.HOME, ".claude"),
};
if (!(await fs.stat(path.join(process.cwd(), ".git")).catch(() => null))) {
  await command("git", ["init", "-b", "frame-draft"]);
  await command("git", ["config", "user.name", "FRAME"]);
  await command("git", ["config", "user.email", "frame@localhost"]);
  await command("git", ["add", "--", "."]);
  await command("git", [
    "commit",
    "--allow-empty",
    "-m",
    "FRAME work baseline",
  ]);
}
const entry = path.join(
  process.env.FRAME_PASEO_ROOT,
  "node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
);
await prepareDaemonSpeechModels(env);
const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  process.stderr.write("Paseo supervisor failed to launch\n");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
