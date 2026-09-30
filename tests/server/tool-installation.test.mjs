import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installToolVersion } from "../../server/tool-installation.mjs";

test("selecting an installed version never invokes npm or changes its files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(
    root,
    "codex/1.2.3/node_modules/@openai/codex/package.json",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: "1.2.3" }));
  const before = await fs.readFile(file, "utf8");
  const result = await installToolVersion({
    provider: "codex",
    version: "1.2.3",
    root,
    run: async (bin) => {
      assert.notEqual(bin, "npm");
      return "codex 1.2.3";
    },
  });
  assert.equal(result.version, "1.2.3");
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal(
    await fs.readFile(path.join(root, "codex/current"), "utf8"),
    "1.2.3",
  );
});

test("a failed install keeps the selected version and removes staging files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-tools-failed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.writeFile(path.join(root, "codex/current"), "1.2.3");
  const stages = [];
  await assert.rejects(
    installToolVersion({
      provider: "codex",
      version: "1.3.0",
      root,
      onProgress: (stage) => stages.push(stage),
      run: async () => {
        throw Error("network failed");
      },
    }),
    /network failed/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "codex/current"), "utf8"),
    "1.2.3",
  );
  assert.deepEqual(await fs.readdir(path.join(root, "codex")), ["current"]);
  assert.deepEqual(stages, ["准备安装", "下载并安装官方版本"]);
});

test("successful installation validates its binary before switching and reports actual stages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-tools-success-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.writeFile(path.join(root, "codex/current"), "1.2.3");
  const stages = [];
  const result = await installToolVersion({
    provider: "codex",
    version: "1.3.0",
    root,
    onProgress: (stage) => stages.push(stage),
    run: async (bin, args) => {
      assert.equal(
        await fs.readFile(path.join(root, "codex/current"), "utf8"),
        "1.2.3",
      );
      if (bin === "npm") {
        const file = path.join(
          args[args.indexOf("--prefix") + 1],
          "node_modules/@openai/codex/package.json",
        );
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ version: "1.3.0" }));
        assert.ok(args.includes("@openai/codex@1.3.0"));
        return "";
      }
      return "codex-cli 1.3.0";
    },
  });
  assert.equal(result.version, "1.3.0");
  assert.equal(
    await fs.readFile(path.join(root, "codex/current"), "utf8"),
    "1.3.0",
  );
  assert.deepEqual(stages, [
    "准备安装",
    "下载并安装官方版本",
    "验证新版本",
    "验证并切换版本",
    "更新完成",
  ]);
});

test("a CLI reporting the wrong version cannot replace the current selection", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-tools-mismatch-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.writeFile(path.join(root, "codex/current"), "1.2.3");
  await assert.rejects(
    installToolVersion({
      provider: "codex",
      version: "1.3.0",
      root,
      run: async (bin, args) => {
        if (bin === "npm") {
          const file = path.join(
            args[args.indexOf("--prefix") + 1],
            "node_modules/@openai/codex/package.json",
          );
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ version: "1.3.0" }));
          return "";
        }
        return "codex-cli 1.2.3";
      },
    }),
    /CLI version/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "codex/current"), "utf8"),
    "1.2.3",
  );
  assert.deepEqual(await fs.readdir(path.join(root, "codex")), ["current"]);
});
