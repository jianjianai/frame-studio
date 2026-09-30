import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, repo } from "./helpers.mjs";
const run = (root, args, input) => {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts/film.mjs"), ...args], { cwd: root, encoding: "utf8", input, timeout: 60000 });
  return { ...r, value: JSON.parse(r.stdout) };
};
test("CLI keeps full validation evidence on disk, exposes exact edit schemas and respects request dryRun", { timeout: 90000 }, () => {
  const f = fixture({ browser: true });
  try {
    const report = run(f.root, ["validate", "test-film", "--json"]);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(report.value.status, "passed");
    assert(!report.value.input.files);
    assert(report.value.input.fileCount > 50);
    const full = JSON.parse(fs.readFileSync(report.value.report, "utf8"));
    assert.equal(full.input.fingerprint, report.value.input.fingerprint);
    assert.equal(full.input.files.length, report.value.input.fileCount);
    assert(report.stdout.length < 10000);
    const read = run(f.root, ["read", "test-film", "--path", "README.md", "--json"]).value;
    for (const command of ["edit", "patch"]) {
      const request = command === "edit" ?
        { changes: [{ path: "README.md", expectedSha256: read.sha256, content: "preview-only\n" }], dryRun: true } :
        { changes: [{ path: "README.md", expectedSha256: read.sha256, replacements: [{ find: "#", replace: "##", count: 99 }] }], dryRun: true };
      // A coherent edit previews successfully; an ambiguous patch refuses without changing anything.
      const result = run(f.root, [command, "test-film", "--input", "-", "--json"], JSON.stringify(request));
      if (command === "edit") assert.equal(result.status, 0, result.stderr);
      else assert.notEqual(result.status, 0);
      assert.equal(run(f.root, ["read", "test-film", "--path", "README.md", "--json"]).value.sha256, read.sha256);
      const descriptor = run(f.root, ["describe", command, "--json"]).value;
      assert.equal(descriptor.requestSchema.properties.dryRun.default, false);
      assert(descriptor.requestSchema.properties.changes.items.properties.expectedSha256);
    }
    const invalid = run(f.root, ["validate", "test-film", "--input", "-", "--json"], "{}");
    assert.equal(invalid.value.error.code, "INVALID_ARGUMENTS");
    const large = run(f.root, ["edit", "test-film", "--input", "-", "--json"], " ".repeat(1024 * 1024 + 1));
    assert.equal(large.value.error.code, "INPUT_TOO_LARGE");
  } finally { f.close(); }
});
test("durable CLI wait reaches terminal states and status fails for a failed job without cancelling it", { timeout: 90000 }, () => {
  const f = fixture({ browser: true });
  try {
    const started = run(f.root, ["job", "test-film", "start", "--kind", "typecheck", "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const waited = run(f.root, ["job", "test-film", "wait", "--id", started.value.id, "--deadline-seconds", "30", "--json"]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(waited.value.status, "succeeded");
    const failed = run(f.root, ["job", "test-film", "start", "--kind", "verify", "--json"]);
    assert.equal(failed.status, 0, failed.stderr);
    const finished = run(f.root, ["job", "test-film", "wait", "--id", failed.value.id, "--deadline-seconds", "30", "--json"]);
    assert.equal(finished.status, 1);
    assert.equal(finished.value.status, "failed");
    const status = run(f.root, ["job", "test-film", "status", "--id", failed.value.id, "--json"]);
    assert.equal(status.status, 1);
    assert.equal(status.value.status, "failed");
    const invalid = run(f.root, ["job", "test-film", "status", "--id", started.value.id, "--kind", "typecheck", "--json"]);
    assert.equal(invalid.value.error.code, "INVALID_ARGUMENTS");
  } finally { f.close(); }
});
