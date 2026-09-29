import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the public studio never mounts the control socket; only the private controller does", () => {
  const compose = fs.readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8");
  const studio = compose.slice(compose.indexOf("  studio:"), compose.indexOf("  data-init:"));
  const controller = compose.slice(compose.indexOf("  controller:"), compose.indexOf("  postgres:"));
  assert.doesNotMatch(studio, /docker\.sock/);
  assert.match(studio, /user: "1000:1000"/);
  assert.match(studio, /FRAME_ROLE: api/);
  assert.match(controller, /docker\.sock/);
  assert.match(controller, /networks: \[internal\]/);
  assert.doesNotMatch(controller, /caddy|ports:/);
});
