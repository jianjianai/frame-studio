import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { t3Environment } from "../../scripts/start-t3.mjs";

test("local T3 retains actual CLI login homes while its native UI state has an independent directory", () => {
  const inherited = { HOME: "/users/creator", USERPROFILE: "C:\\Users\\Creator", PATH: "/tools", FRAME_LOCAL_MODE: "1", CODEX_HOME: "/users/creator/.codex", T3CODE_DEV_AUTH_TOKEN: "fixture-only" };
  const env = t3Environment({ runtimeRoot: "/runtime/t3", dataRoot: "/frame-data", inherited });
  assert.equal(env.HOME, inherited.HOME); assert.equal(env.USERPROFILE, inherited.USERPROFILE);
  assert.equal(env.CODEX_HOME, inherited.CODEX_HOME);
  assert.equal(env.T3CODE_HOME, path.join("/frame-data", "ai/t3"));
  assert.equal(env.T3CODE_DEV_AUTH_TOKEN, undefined);
});
test("Docker T3 uses its persistent shared CLI home and allows explicit service environment overrides", () => {
  const env = t3Environment({ runtimeRoot: "/runtime/t3", dataRoot: "/frame-data", inherited: { HOME: "/root", PATH: "/original" }, env: { PATH: "/managed", FRAME_CALLBACK_URL: "http://frame-web:3000" } });
  assert.equal(env.HOME, path.join("/frame-data", "ai/t3/home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.PATH, path.join("/runtime/t3", "bin") + path.delimiter + "/managed");
  assert.equal(env.FRAME_CALLBACK_URL, "http://frame-web:3000");
});
