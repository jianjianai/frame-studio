import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePatchedPaseoSource } from "../../scripts/build-paseo.mjs";

const execute = promisify(execFile);
const integration = fileURLToPath(
  new URL("../../integrations/paseo", import.meta.url),
);
const patchName = "0003-windows-web-build.patch";
const sha = (value) => createHash("sha256").update(value).digest("hex");

// Full context makes this actual upstream patch test independent of a private checkout or network.
async function buildScript() {
  const patch = await fs.readFile(
    path.join(integration, "patches", patchName),
    "utf8",
  );
  const lines = patch.trimEnd().split("\n");
  assert.equal(
    lines[0],
    "diff --git a/scripts/build-daemon-web-ui.mjs b/scripts/build-daemon-web-ui.mjs",
  );
  assert.equal(
    lines.filter((line) => line.startsWith("diff --git ")).length,
    1,
  );
  const header = lines.findIndex((line) => line.startsWith("@@ "));
  const counts = /^@@ -1,(\d+) \+1,(\d+) @@/.exec(lines[header]);
  assert.ok(
    counts,
    "the patch contains the complete pinned script in one hunk",
  );
  const before = [],
    after = [];
  for (const line of lines.slice(header + 1)) {
    assert.ok(
      [" ", "+", "-"].includes(line[0]),
      "valid complete unified patch line",
    );
    if (line[0] !== "+") before.push(line.slice(1));
    if (line[0] !== "-") after.push(line.slice(1));
  }
  assert.equal(before.length, Number(counts[1]));
  assert.equal(after.length, Number(counts[2]));
  const original = before.join("\n") + "\n";
  assert.equal(
    sha(original),
    "772b9ced6a2d50a6a460111b67f8d06c4c02da6a9769a2270928513205fc90d4",
    "preimage is the exact build script from official Paseo 919c737",
  );
  return { original, patched: after.join("\n") + "\n" };
}
async function directory(t) {
  const owned = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame npm 构建 空格 "),
  );
  t.after(() => fs.rm(owned, { recursive: true, force: true }));
  return owned;
}
async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const fakeNpm = String.raw`const fs=require('node:fs'),path=require('node:path');
const root=process.cwd();
fs.writeFileSync(path.join(root,'npm-capture.json'),JSON.stringify({argv:process.argv.slice(2),cwd:root,node:process.execPath,marker:process.env.FRAME_NPM_BUILD_MARKER}));
if(process.env.FRAME_NPM_BUILD_FAIL==='yes')process.exit(7);
const output=path.join(root,'packages/app/dist');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'index.html'),'<main>official web fixture 中文</main>');`;
async function runScript(script, env, preloader) {
  const args = [
    ...(preloader ? ["--import", pathToFileURL(preloader).href] : []),
    script,
  ];
  try {
    const result = await execute(process.execPath, args, {
      cwd: path.dirname(path.dirname(script)),
      env: { ...process.env, PATH: "", ...env },
      timeout: 10000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test(
  "Official npm CLI patch applies/reverses and participates in strict source proof without changing the caller index",
  { timeout: 20000 },
  async (t) => {
    const owned = await directory(t),
      source = path.join(owned, "source"),
      plugin = path.join(owned, "plugin");
    const script = path.join(source, "scripts/build-daemon-web-ui.mjs"),
      { original, patched } = await buildScript();
    await write(script, original);
    await write(
      path.join(source, ".gitignore"),
      "node_modules/\npackages/*/dist/\n",
    );
    const git = (args) => execute("git", args, { cwd: source });
    await git(["init", "-b", "main"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["config", "user.name", "Owned test"]);
    await git(["config", "user.email", "owned@invalid"]);
    await git(["add", "--", ".gitignore", "scripts/build-daemon-web-ui.mjs"]);
    await git(["commit", "-m", "Pinned official script preimage"]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const patch = path.join(integration, "patches", patchName);
    await git(["apply", "--check", patch]);
    await git(["apply", patch]);
    await git(["apply", "--reverse", "--check", patch]);
    assert.equal(await fs.readFile(script, "utf8"), patched);
    await write(path.join(plugin, "index.ts"), "export const frame=true;\n");
    await fs.cp(plugin, path.join(source, "plugin-examples/frame"), {
      recursive: true,
    });
    const index = await fs.readFile(path.join(source, ".git/index"));
    const options = {
      sourceDirectory: source,
      commit,
      patches: [patch],
      pluginDirectory: plugin,
    };
    await validatePatchedPaseoSource(options);
    assert.deepEqual(await fs.readFile(path.join(source, ".git/index")), index);
    await write(script, original);
    await assert.rejects(
      validatePatchedPaseoSource(options),
      /differs from its pinned commit and declared patches/,
    );
    await write(script, patched + "// undeclared change\n");
    await assert.rejects(
      validatePatchedPaseoSource(options),
      /differs from its pinned commit and declared patches/,
    );
    await write(script, patched);
    await validatePatchedPaseoSource(options);
    assert.deepEqual(await fs.readFile(path.join(source, ".git/index")), index);
    const metadata = JSON.parse(
      await fs.readFile(path.join(integration, "source.json"), "utf8"),
    );
    assert.equal(metadata.commit, "919c737c1948c5a16220307403a82e90d3e27ea0");
    assert.deepEqual(metadata.patches, [
      "0001-frame-embed.patch",
      "0002-frame-session-env.patch",
      patchName,
      "0004-frame-shared-speech-wait.patch",
      "0005-frame-single-workspace.patch",
      "0006-frame-host-startup.patch",
      "0007-frame-clickable-reference.patch",
      "0008-frame-worktree-workflow.patch",
    ]);
  },
);

test(
  "Patched official web export executes a validated npm-cli with Node, preserves args/env and propagates failure",
  { timeout: 20000 },
  async (t) => {
    const source = await directory(t),
      script = path.join(source, "scripts/build-daemon-web-ui.mjs");
    await write(script, (await buildScript()).patched);
    const cli = path.join(source, "工具 npm 中文 空格/bin/npm-cli.js");
    await write(cli, fakeNpm);
    const env = {
      npm_execpath: cli,
      FRAME_NPM_BUILD_MARKER: "preserved 中文 marker",
    };
    const result = await runScript(script, env);
    assert.equal(result.code, 0, result.stderr);
    const capture = JSON.parse(
      await fs.readFile(path.join(source, "npm-capture.json"), "utf8"),
    );
    assert.deepEqual(capture.argv, [
      "run",
      "build:web",
      "--workspace=@getpaseo/app",
    ]);
    assert.equal(capture.cwd, source);
    assert.equal(capture.node, process.execPath);
    assert.equal(capture.marker, env.FRAME_NPM_BUILD_MARKER);
    const target = path.join(
      source,
      "packages/server/dist/server/web-ui/index.html",
    );
    const expected = await fs.readFile(target, "utf8");
    assert.equal(expected, "<main>official web fixture 中文</main>");
    assert.ok((await fs.stat(target + ".gz")).size > 0);
    assert.ok((await fs.stat(target + ".br")).size > 0);
    const failure = await runScript(script, {
      ...env,
      FRAME_NPM_BUILD_FAIL: "yes",
    });
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Command failed with exit code 7:/);
    assert.equal(
      await fs.readFile(target, "utf8"),
      expected,
      "failed export never cleans the existing bundle",
    );
  },
);

test(
  "Npm resolver rejects wrong names/relative paths/directories and uses a validated module fallback",
  { timeout: 20000 },
  async (t) => {
    const source = await directory(t),
      script = path.join(source, "scripts/build-daemon-web-ui.mjs");
    await write(script, (await buildScript()).patched);
    const fallback = path.join(source, "node_modules/npm/bin/npm-cli.js");
    await write(fallback, fakeNpm);
    // Hide the machine's other npm installations to exercise the fallback deterministically.
    const loader = path.join(source, "npm-resolution-fixture.mjs");
    await write(
      loader,
      `import fs from 'node:fs/promises';import path from 'node:path';import{syncBuiltinESMExports}from'node:module';
const nativeStat=fs.stat;const owned=${JSON.stringify(source + path.sep)};
fs.stat=async(file,...args)=>{if(path.basename(String(file))==='npm-cli.js'&&!path.resolve(String(file)).startsWith(owned))throw Object.assign(Error('fixture npm not installed'),{code:'ENOENT'});return nativeStat(file,...args)};syncBuiltinESMExports();`,
    );
    const wrong = path.join(source, "pnpm.cjs"),
      marker = path.join(source, "unexpected-execution");
    await write(
      wrong,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`,
    );
    const relative = "relative/npm-cli.js";
    await write(
      path.join(source, relative),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');` +
        fakeNpm,
    );
    const folder = path.join(source, "directory/npm-cli.js");
    await fs.mkdir(folder, { recursive: true });
    for (const candidate of [wrong, relative, folder]) {
      const result = await runScript(
        script,
        { npm_execpath: candidate, FRAME_NPM_BUILD_MARKER: "fallback" },
        loader,
      );
      assert.equal(result.code, 0, result.stderr);
      const capture = JSON.parse(
        await fs.readFile(path.join(source, "npm-capture.json"), "utf8"),
      );
      assert.equal(capture.marker, "fallback");
    }
    assert.equal(
      await fs.access(marker).then(
        () => true,
        () => false,
      ),
      false,
    );
    await fs.rm(fallback);
    const absent = await runScript(script, { npm_execpath: wrong }, loader);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /Cannot locate npm-cli\.js/);
    assert.equal(
      await fs.access(marker).then(
        () => true,
        () => false,
      ),
      false,
    );
  },
);
