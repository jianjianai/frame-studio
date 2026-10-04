import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8");
const serviceSource = compose.split("\nservices:\n")[1].split("\nnetworks:\n")[0];
const services = new Map(
  [...serviceSource.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]]),
);

test("the public studio never mounts the control socket; only the private controller does", () => {
  const studio = services.get("studio"), controller = services.get("controller");
  assert(studio && controller);
  assert.doesNotMatch(studio, /docker\.sock/);
  assert.match(studio, /user: "1000:1000"/);
  assert.match(studio, /FRAME_ROLE: api/);
  assert.match(controller, /docker\.sock/);
  assert.match(controller, /networks: \[internal\]/);
  assert.doesNotMatch(controller, /caddy|ports:/);
});

test("Dockge stack contains only persistent services, never one-shot initialization jobs", () => {
  assert.deepEqual([...services.keys()].sort(), ["controller", "postgres", "speech", "studio", "t3"]);
  assert.doesNotMatch(serviceSource, /data-init|initialize-data|service_completed_successfully|\bsleep\b/);
  for (const [name, service] of services) {
    assert.match(service, /restart: unless-stopped/, `${name} must be long-running`);
    assert.match(service, /healthcheck:/, `${name} must report health`);
  }
});

test("all works share one private T3 service with an independently versioned image and read-only FRAME runtime", () => {
  const studio = services.get("studio"), t3 = services.get("t3");
  assert(studio && t3);
  assert.match(t3, /image: ghcr\.io\/jianjianai\/frame-studio\/t3-code:\$\{FRAME_T3_VERSION(?::-[^}]+)?\}/);
  assert.doesNotMatch(t3, /\bFRAME_VERSION\b|docker\.sock|^\s+ports:|\bcaddy\b/m);
  assert.match(t3, /^    container_name: frame-t3$/m);
  assert.match(studio, /^      FRAME_T3_URL: http:\/\/frame-t3:3773$/m);
  assert.match(studio, /^      FRAME_T3_CONTAINER: frame-t3$/m);
  assert.match(t3, /^    networks: \[internal\]$/m);
  assert.match(t3, /- type: bind\n\s+source: \.\/data\/runtime\/current\n\s+target: \/opt\/frame\n\s+read_only: true/);
});

test("data initialization stays explicit, isolated and automatically removed outside Compose", () => {
  const guide = fs.readFileSync(new URL("../../docs/SERVER.md", import.meta.url), "utf8");
  const command = guide.match(/docker run --rm[\s\S]*?node server\/initialize-data\.mjs/)?.[0];
  assert(command, "Document a standalone auto-removed initialization command");
  assert.match(command, /--network none/);
  assert.match(command, /--read-only --user 0:0/);
  assert.match(command, /--cap-drop ALL/);
  assert.match(command, /--security-opt no-new-privileges:true/);
  assert.match(command, /target=\/data/);
  assert.doesNotMatch(command, /--label|docker\.sock|DATABASE_URL|FRAME_MASTER_KEY|--env/);
  assert(fs.existsSync(new URL("../../server/initialize-data.mjs", import.meta.url)));
});
