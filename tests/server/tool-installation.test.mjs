import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installToolVersion } from "../../server/tool-installation.mjs";

test("selecting an installed version never invokes npm or changes its files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "codex/1.2.3/node_modules/@openai/codex/package.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: "1.2.3" }));
  const before = await fs.readFile(file, "utf8");
  const result = await installToolVersion({ provider: "codex", version: "1.2.3", root,
    run: async bin => { assert.notEqual(bin, "npm"); return "codex 1.2.3"; } });
  assert.equal(result.version, "1.2.3");
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal(await fs.readFile(path.join(root, "codex/current"), "utf8"), "1.2.3");
});
