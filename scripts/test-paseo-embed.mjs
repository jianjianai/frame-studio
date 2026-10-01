import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--source")
  throw new Error(
    "Usage: node scripts/test-paseo-embed.mjs --source <pinned patched official source>",
  );
const source = path.resolve(argv[1]);
const pin = JSON.parse(
  await fs.readFile(path.join(root, "integrations/paseo/source.json"), "utf8"),
);
let head = "";
await new Promise((resolve, reject) => {
  const child = spawn("git", ["rev-parse", "HEAD"], {
    cwd: source,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => {
    head += chunk;
  });
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error("The official source is not a Git checkout")),
  );
});
if (head.trim() !== pin.commit)
  throw new Error("The embed harness requires the exact official source pin");
await fs.access(path.join(source, "node_modules/vitest/vitest.mjs"));
await fs.access(path.join(source, "packages/app/dist/index.html"));
const temporary = path.join(source, ".cache", "frame-embed-" + randomUUID());
await fs.mkdir(temporary, { recursive: true });
try {
  let template = await fs.readFile(
    path.join(root, "integrations/paseo/tests/official-embed.test.ts"),
    "utf8",
  );
  const mappings = [
    [
      'from "./test-utils/fake-agent-client.js"',
      'from "../../packages/server/src/server/test-utils/fake-agent-client.js"',
    ],
    [
      'from "./test-utils/paseo-daemon.js"',
      'from "../../packages/server/src/server/test-utils/paseo-daemon.js"',
    ],
    [
      'from "../../../app/src/utils/host-routes"',
      'from "../../packages/app/src/utils/host-routes"',
    ],
    [
      'from "../../../../plugin-examples/frame/shared/bridge"',
      'from "../../plugin-examples/frame/shared/bridge"',
    ],
    [
      'path.resolve(import.meta.dirname, "../../../..")',
      'path.resolve(import.meta.dirname, "../..")',
    ],
    [
      'path.resolve(clone, "../prototype-browser")',
      'process.env.FRAME_PASEO_REPORT_DIR ?? path.resolve(clone, "../prototype-browser")',
    ],
  ];
  for (const [from, to] of mappings) {
    if (template.split(from).length !== 2)
      throw new Error("The official embed test template changed: " + from);
    template = template.replace(from, to);
  }
  const target = path.join(temporary, "official-embed.test.ts");
  await fs.writeFile(target, template);
  const report = path.join(root, ".cache/paseo-integration/official-embed");
  await fs.mkdir(report, { recursive: true });
  await run(
    process.execPath,
    [
      path.join(source, "node_modules/vitest/vitest.mjs"),
      "run",
      target,
      "--config",
      path.join(source, "packages/server/vitest.config.ts"),
      "--root",
      source,
      "--bail=1",
    ],
    {
      cwd: path.join(source, "packages/server"),
      stdio: "inherit",
      env: { ...process.env, FRAME_PASEO_REPORT_DIR: report },
    },
  );
} finally {
  // Only this run's UUID directory is removed; the official source and dependencies are retained.
  if (path.dirname(temporary) !== path.join(source, ".cache"))
    throw new Error("Unsafe temporary path");
  await fs.rm(temporary, { recursive: true, force: true });
}
