import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--release", "--allow-skip"].includes(flag)))
  throw Error("Usage: node scripts/test-server.mjs [--release | --allow-skip]");
const release = flags.has("--release"), light = flags.has("--allow-skip");
if (release && light) throw Error("Release verification cannot allow missing integrations");
const url = process.env.FRAME_TEST_DATABASE_URL;
if (!url && !light) throw Error("FRAME_TEST_DATABASE_URL is required. Use a separate frame_test database; --allow-skip is development-only.");
if (url) {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !decodeURIComponent(parsed.pathname).includes("frame_test"))
    throw Error("Refusing tests against a database not named frame_test");
  if (process.env.DATABASE_URL) {
    const production = new URL(process.env.DATABASE_URL);
    if (production.hostname === parsed.hostname && (production.port || "5432") === (parsed.port || "5432") && production.pathname === parsed.pathname)
      throw Error("Test and application databases must be different");
  }
}
if (release && (process.env.FRAME_TEST_EXECUTOR !== "1" || !process.env.FRAME_TEST_HOST_ROOT || !process.env.FRAME_EXECUTOR_IMAGE))
  throw Error("Release gate requires FRAME_TEST_EXECUTOR=1, FRAME_TEST_HOST_ROOT and a locally built FRAME_EXECUTOR_IMAGE");
if (!light && !fs.existsSync("studio-dist/index.html"))
  throw Error("Build the current workbench first: pnpm build:studio");
if (light) console.warn("DEVELOPMENT-ONLY: missing integrations may be skipped; this is NOT a release acceptance result.");
const files = fs.readdirSync("tests/server").filter((name) => name.endsWith(".test.mjs")).sort().map((name) => path.join("tests/server", name));
let tail = "";
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
child.stdout.on("data", (chunk) => { process.stdout.write(chunk); tail = (tail + chunk).slice(-8 * 1024 * 1024); });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code) => {
  if (code !== 0) { process.exitCode = code || 1; return; }
  const skips = tail.split(/\r?\n/).filter((line) => /^\s*ok \d+\b.*# SKIP/i.test(line));
  if (release) {
    // A licensed user-supplied soundfont is an explicitly optional content fixture.
    // The generated soundfont regression always runs. No integration skips are allowed.
    const unexpected = skips.filter((line) => !line.includes("preserve GeneralUser synthesis"));
    const count = Number(tail.match(/# skipped (\d+)\s*$/m)?.[1] ?? -1);
    if (unexpected.length || count < 0 || count !== skips.length) {
      console.error("Release verification rejected missing/unknown skipped tests:", unexpected.join("\n"));
      process.exitCode = 1;
    }
  }
  if (skips.length) console.warn("Explicitly skipped cases:\n" + skips.join("\n"));
});
