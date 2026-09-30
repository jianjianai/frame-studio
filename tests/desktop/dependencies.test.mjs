import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fingerprint, installDependencies } from "../../desktop/dependencies.mjs";

test("pnpm repairs failed installs, reuses an unchanged installation, and only fetches added packages", {
  skip: process.platform !== "win32", timeout: 120000,
}, async (t) => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = fs.mkdtempSync(path.join(repo, ".cache", "pnpm-installer-test-"));
  t.after(() => {
    if (!path.resolve(fixture).startsWith(path.join(repo, ".cache") + path.sep)) throw Error("Unexpected test cleanup path");
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const app = path.join(fixture, "app"), cache = path.join(fixture, "data", "runtimes"), tools = path.join(fixture, "tools");
  fs.mkdirSync(path.join(app, "desktop"), { recursive: true });
  fs.mkdirSync(path.join(tools, "tools", "pnpm"), { recursive: true });
  const npmRoot = execFileSync(process.env.ComSpec, ["/d", "/c", "npm root -g"], { encoding: "utf8", windowsHide: true }).trim();
  fs.copyFileSync(process.execPath, path.join(tools, "node.exe"));
  fs.copyFileSync(path.join(npmRoot, "pnpm", "pnpm.exe"), path.join(tools, "tools", "pnpm", "pnpm.exe"));
  fs.copyFileSync(path.join(repo, "desktop", "runtime-versions.json"), path.join(app, "desktop", "runtime-versions.json"));
  fs.writeFileSync(path.join(app, "pnpm-workspace.yaml"), "verifyDepsBeforeRun: false\n");
  fs.writeFileSync(path.join(app, ".npmrc"), "fetch-retries=0\n");
  const archives = {}, requests = { first: 0, second: 0, metadata: 0 };
  for (const name of ["first", "second"]) {
    const directory = path.join(fixture, name);
    fs.mkdirSync(path.join(directory, "package"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package", "package.json"), JSON.stringify({ name: `frame-test-${name}`, version: "1.0.0" }));
    const archive = path.join(fixture, `${name}.tgz`);
    execFileSync(path.join(process.env.SystemRoot, "System32", "tar.exe"), ["-czf", archive, "-C", directory, "package"], { windowsHide: true });
    const bytes = fs.readFileSync(archive);
    archives[name] = { bytes, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  }
  let unavailable = true;
  const registry = http.createServer((req, res) => {
    if (req.url.startsWith("/frame-test-")) {
      requests.metadata++;
      const name = req.url.slice("/frame-test-".length);
      if (!(name in archives)) { res.writeHead(404).end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: `frame-test-${name}`, "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": "2020-01-01T00:00:00Z" },
        versions: { "1.0.0": { name: `frame-test-${name}`, version: "1.0.0", dist: { integrity: archives[name].integrity, tarball: `http://127.0.0.1:${registry.address().port}/${name}.tgz` } } } }));
      return;
    }
    const name = req.url.slice(1).replace(".tgz", "");
    if (!(name in archives)) { res.writeHead(404).end(); return; }
    requests[name]++;
    if (unavailable) { res.writeHead(404).end("package temporarily missing"); return; }
    res.end(archives[name].bytes);
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${registry.address().port}`;
  fs.writeFileSync(path.join(app, ".npmrc"), `fetch-retries=0\nproduction=true\nregistry=${url}\n`);
  const configure = (names, version = "1.0.0") => {
    const dependencies = { "frame-test-first": "1.0.0" };
    const devDependencies = names.includes("second") ? { "frame-test-second": "1.0.0" } : undefined;
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "frame-test-app", version, dependencies, devDependencies }));
    const importers = Object.entries({ dependencies, devDependencies }).filter(([, value]) => value).map(([group, value]) => `    ${group}:\n` + Object.keys(value).map((name) => `      ${name}:\n        specifier: 1.0.0\n        version: 1.0.0`).join("\n")).join("\n");
    fs.writeFileSync(path.join(app, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\nimporters:\n  .:\n${importers}\npackages:\n${names.map((n) => `  frame-test-${n}@1.0.0:\n    resolution: {integrity: ${archives[n].integrity}, tarball: '${url}/${n}.tgz'}`).join("\n")}\nsnapshots:\n${names.map((n) => `  frame-test-${n}@1.0.0: {}`).join("\n")}\n`);
    const entry = fingerprint(app);
    fs.writeFileSync(path.join(app, "desktop", "runtime-manifest.json"), JSON.stringify({ dependencies: entry }));
    return entry;
  };
  try {
    const first = configure(["first"]);
    await assert.rejects(installDependencies(app, cache, tools), /pnpm 安装失败/);
    assert.equal(fs.existsSync(path.join(cache, first.id, "FRAME-RUNTIME.json")), false);
    unavailable = false;
    const installed = await installDependencies(app, cache, tools);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, "node_modules", "frame-test-first", "package.json"))).version, "1.0.0");
    const downloads = { ...requests };
    unavailable = true;
    assert.equal(configure(["first"], "2.0.0").id, first.id);
    assert.equal(await installDependencies(app, cache, tools), installed);
    assert.deepEqual(requests, downloads, "App-only updates must not contact the registry");
    unavailable = false;
    assert.notEqual(configure(["first", "second"], "2.0.0").id, first.id);
    const updated = await installDependencies(app, cache, tools);
    assert.equal(requests.first, downloads.first, "Existing packages must come from the pnpm store");
    assert.equal(requests.second, 1);
    assert.ok(fs.existsSync(path.join(updated, "node_modules", "frame-test-second", "package.json")));
    assert.ok(fs.existsSync(path.join(installed, "FRAME-RUNTIME.json")), "A dependency update retains the previous installation");
  } finally {
    await new Promise((resolve) => registry.close(resolve));
  }
});
