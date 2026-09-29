import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";

const [action, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--stack", "--out", "--backup"].includes(args[i]) || !args[i + 1]) throw Error("Invalid arguments");
  options[args[i].slice(2)] = path.resolve(args[i + 1]);
}
process.umask(0o077);
async function run(bin, argv, { cwd, output } = {}) {
  const fd = output ? fs.openSync(output, "wx", 0o600) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, argv, { cwd, stdio: ["ignore", fd ?? "pipe", "pipe"] });
      let text = "", size = 0, error;
      child.stdout?.on("data", (value) => {
        size += value.length;
        if (size > 8 * 1024 * 1024) { error = Error("Command output exceeded safety limit"); child.kill(); }
        else text += value;
      });
      // Compose configuration can contain credentials; never echo it on failure.
      child.stderr.on("data", () => {});
      child.once("error", reject);
      child.once("close", (code) => code === 0 && !error ? resolve(text.trim()) : reject(error || Error(`${bin} failed (${code}); inspect locally without sharing credentials`)));
    });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function fingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { bytes: fs.statSync(file).size, sha256: hash.digest("hex") };
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Expected a regular backup file");
}
async function verify(root) {
  regular(path.join(root, "manifest.json"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !manifest.files || Object.keys(manifest.files).sort().join(",") !== "database.dump,files.tar.gz") throw Error("Invalid backup manifest");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(root, name); regular(file);
    const actual = await fingerprint(file);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error("Backup checksum mismatch: " + name);
  }
  return manifest;
}
try {
  if (action === "verify") {
    if (!options.backup) throw Error("Usage: backup.mjs verify --backup <directory>");
    const manifest = await verify(options.backup);
    console.log(JSON.stringify({ verified: true, created: manifest.created, files: Object.keys(manifest.files) }));
  } else if (action === "create") {
    if (process.platform !== "linux") throw Error("Backup creation requires Linux, Docker Compose and GNU tar");
    if (!options.stack || !options.out) throw Error("Usage: backup.mjs create --stack <deployment directory> --out <new backup directory>");
    const stack = fs.realpathSync(options.stack);
    const out = path.join(fs.realpathSync(path.dirname(options.out)), path.basename(options.out));
    for (const name of ["data", "models", "postgres"]) {
      const stat = fs.lstatSync(path.join(stack, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Source bind-mount directories cannot be symbolic links");
    }
    if (fs.existsSync(out)) throw Error("Backup destination must not already exist");
    for (const name of ["data", "models"])
      if (out === path.join(stack, name) || out.startsWith(path.join(stack, name) + path.sep)) throw Error("Backup must be outside source data/model directories");
    for (const name of [".env", "compose.yaml"]) regular(path.join(stack, name));
    const compose = (...argv) => run("docker", ["compose", "--project-directory", stack, "-f", path.join(stack, "compose.yaml"), ...argv], { cwd: stack });
    const config = JSON.parse(await compose("config", "--format", "json"));
    const stored = parseEnv(fs.readFileSync(path.join(stack, ".env"), "utf8"));
    if (!stored.FRAME_MASTER_KEY || config.services?.studio?.environment?.FRAME_MASTER_KEY !== stored.FRAME_MASTER_KEY)
      throw Error("Effective master key differs from the saved .env; persist the correct key before backing up");
    for (const [service, target, source] of [["studio", "/data", "data"], ["speech", "/models", "models"], ["postgres", "/var/lib/postgresql", "postgres"]]) {
      const mount = config.services?.[service]?.volumes?.find((entry) => entry.target === target);
      if (mount?.type !== "bind" || path.resolve(mount.source) !== path.join(stack, source)) throw Error("This tool requires the documented data/models/postgres bind-mount layout");
    }
    const stopped = async () => {
      const running = (await compose("ps", "--status", "running", "--services")).split(/\s+/);
      if (running.includes("studio") || running.includes("speech") || !running.includes("postgres")) throw Error("Stop studio and speech, finish/stop all task containers, and keep postgres running before backup");
      if (await run("docker", ["ps", "-q", "--filter", "label=frame.task"])) throw Error("FRAME task containers are still running; backup refused");
    };
    await stopped();
    fs.mkdirSync(out, { recursive: false, mode: 0o700 });
    await run("docker", ["compose", "--project-directory", stack, "-f", path.join(stack, "compose.yaml"), "exec", "-T", "postgres", "pg_dump", "-U", "frame", "-d", "frame", "-Fc"], { cwd: stack, output: path.join(out, "database.dump") });
    await run("tar", ["--create", "--gzip", "--file", path.join(out, "files.tar.gz"), "--directory", stack, "--", "data", "models", ".env", "compose.yaml"]);
    await stopped();
    const files = {};
    for (const name of ["database.dump", "files.tar.gz"]) files[name] = await fingerprint(path.join(out, name));
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version: 1, created: new Date().toISOString(), images: Object.fromEntries(["studio", "speech", "postgres"].map((name) => [name, config.services[name].image])), files }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await verify(out);
    console.log(JSON.stringify({ created: true, backup: out, verified: true, warning: "Contains credentials and master key. Keep private; source services remain stopped." }));
  } else throw Error("Usage: backup.mjs create --stack <stack> --out <new directory> | verify --backup <directory>");
} catch (error) { console.error(error.message); process.exitCode = 1; }
