import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { localToolBinary, processLaunch } from "../../server/local-tools.mjs";

test("Windows npm CLI launch honors PATH order and preserves Unicode and shell metacharacters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame CLI 中文 "));
  try {
    const npm = path.join(root, "npm"), other = path.join(root, "other");
    fs.mkdirSync(npm); fs.mkdirSync(other);
    for (const [tool, pkg] of [["codex", "@openai/codex"], ["claude", "@anthropic-ai/claude-code"]]) {
      const packageRoot = path.join(npm, "node_modules", pkg);
      fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
      fs.writeFileSync(path.join(npm, tool + ".cmd"), "Known npm shim");
      fs.writeFileSync(path.join(other, tool + ".exe"), "Lower-priority executable");
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { [tool]: "bin/cli.mjs" } }));
      fs.writeFileSync(path.join(packageRoot, "bin/cli.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
      const env = { PATH: '"' + npm + '";' + other };
      assert.equal(localToolBinary(tool, { env, platform: "win32" }), path.join(npm, tool + ".cmd"));
      const args = ["exec", "引号 \" 与换行\n", "& echo unsafe", "%PATH%", "a b", ""];
      const launch = processLaunch(tool, args, { platform: "win32", env });
      assert.equal(launch.bin, process.execPath);
      assert.deepEqual(JSON.parse(execFileSync(launch.bin, launch.args, { encoding: "utf8", windowsHide: true })), args);
    }
    assert.throws(() => processLaunch(path.join(npm, "unsupported.cmd"), [], { platform: "win32" }), /Unsupported/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
