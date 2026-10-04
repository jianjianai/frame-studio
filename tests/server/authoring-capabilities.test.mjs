import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { operations } from "../../server/operations.mjs";
import {
  isMcpOperation,
  toolAnnotations,
} from "../../server/platform-toolkit.mjs";
import {
  getAuthoringCapabilities,
  authoringCapabilitySummary,
  capabilityFilterShape,
} from "../../src/contracts/capabilities.mjs";
import { describeFilmCommand } from "../../scripts/film-command-catalog.mjs";
import { runWorkTool } from "../../scripts/work-tool.mjs";
import { readCreatorContext } from "../../scripts/creator-context.mjs";
import { fixture } from "../mcp/helpers.mjs";

function registryFixture(t) {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "frame-capability-registry-"),
  );
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  return operations({
    db: { lock: async (_key, fn) => fn() },
    data,
    repos: {},
    assets: {},
    tasks: {},
    secrets: {},
    github: {},
    retention: {},
  });
}

test("platform discovery exposes a read-only capability tool and exact shared filters", async (t) => {
  const actions = registryFixture(t);
  assert(isMcpOperation("capabilities"));
  assert.equal(toolAnnotations("capabilities").readOnlyHint, true);
  assert.equal(toolAnnotations("capabilities").openWorldHint, false);
  const schema = await actions.call("tool_describe", {
    name: "frame_capabilities",
  });
  assert.deepEqual(
    schema.inputSchema,
    z.toJSONSchema(z.strictObject(capabilityFilterShape), {
      io: "input",
      unrepresentable: "any",
    }),
  );
  assert.deepEqual(
    schema.inputSchema,
    describeFilmCommand("capabilities").requestSchema,
  );
  const help = await actions.call("help", { query: "frame_capabilities" });
  assert(help.tools.some((tool) => tool.name === "frame_capabilities"));
  const refs = await actions.call("authoring_reference", {});
  assert(refs.references.some((ref) => ref.name === "capabilities"));
  const create = await actions.call("tool_describe", {
    name: "frame_works_create",
  });
  assert(create.inputSchema.properties.renderer.enum.includes("remotion"));
  assert.equal(create.inputSchema.properties.renderer.default, "composition");
});

test("platform and credential-free Agent capabilities return identical filtered facts", async (t) => {
  const actions = registryFixture(t);
  for (const filters of [
    {},
    { category: "audio" },
    { id: "remotion" },
    { query: "路径" },
  ]) {
    const platform = await actions.call("capabilities", filters);
    const agent = await runWorkTool(["capabilities", JSON.stringify(filters)], {
      env: {},
    });
    assert.deepEqual(platform, getAuthoringCapabilities(filters));
    assert.deepEqual(agent, platform);
  }
  for (const input of [
    { category: "invalid" },
    { id: "not-installed" },
    { query: "" },
    { unexpected: true },
  ]) {
    await assert.rejects(actions.call("capabilities", input));
    await assert.rejects(
      runWorkTool(["capabilities", JSON.stringify(input)], { env: {} }),
    );
  }
});

test("new neutral work README and bounded Agent context expose every supported capability", () => {
  const f = fixture({ renderer: "composition" });
  try {
    const text = fs.readFileSync(f.file("README.md"), "utf8");
    assert(!text.includes("{{CAPABILITY_OVERVIEW}}"));
    for (const item of getAuthoringCapabilities().items)
      assert(text.includes(item.name), item.name);
    const context = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(context.projectInfo.renderer, "composition");
    assert.equal(context.authority.visual.clips, 0);
    assert.deepEqual(context.capabilities, authoringCapabilitySummary());
    assert(Buffer.byteLength(JSON.stringify(context.capabilities)) < 8000);
    assert(
      context.commands.capabilities.includes("work-tool.mjs capabilities"),
    );
    assert.equal(context.files.readme.truncated, true);
    assert.match(context.files.readme.text, /film capabilities/);
    assert.match(context.files.readme.text, /FrameScene/);
    assert.match(context.files.readme.text, /authority/);
    // Keep capability discovery available even when the entry metadata needs repair.
    fs.writeFileSync(f.file("project.ts"), "invalid metadata");
    const damaged = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(damaged.status, "needs_repair");
    assert.deepEqual(damaged.capabilities, authoringCapabilitySummary());
  } finally {
    f.close();
  }
});

test("an explicit Remotion work preserves its real entrypoint and neutral capability discovery", () => {
  const f = fixture({ renderer: "remotion" });
  try {
    const context = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(context.projectInfo.renderer, "remotion");
    assert.equal(context.entrypoints.remotion, "./composition");
    assert.equal(fs.existsSync(f.file("composition.tsx")), true);
    assert.equal(context.authority.visual.mode, "code");
    assert.equal(context.authority.visual.path, "./composition");
    assert.deepEqual(context.capabilities, authoringCapabilitySummary());
    assert.match(context.files.readme.text, /未显式指定 renderer 时/);
    assert.match(
      context.files.readme.text,
      /当前 renderer 以工程 context 为准/,
    );
    assert.match(context.files.readme.text, /FrameScene/);
  } finally {
    f.close();
  }
});

test("a retained Canvas document does not override a migrated Remotion visual root", () => {
  const f = fixture({ renderer: "remotion" });
  try {
    fs.writeFileSync(
      f.file("visual.json"),
      JSON.stringify({
        schemaVersion: 1,
        background: "transparent",
        clips: [],
      }),
    );
    const metadata = fs.readFileSync(f.file("project.ts"), "utf8");
    const loader = "load: () => import('./scene')";
    assert(metadata.includes(loader));
    fs.writeFileSync(
      f.file("project.ts"),
      metadata.replace(
        loader,
        loader + ", loadVisual: () => import('./visual.json')",
      ),
    );
    const context = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(context.authority.visual.mode, "code");
    assert.equal(context.authority.visual.path, "./composition");
    assert.equal(context.authority.visual.reference, "remotion");
    assert.equal(
      context.authority.visual.canvasComposition.path,
      "visual.json",
    );
    assert.match(
      context.authority.visual.canvasComposition.sha256,
      /^[a-f0-9]{64}$/,
    );
    assert.match(
      context.authority.visual.canvasComposition.connection,
      /Only visible.*explicitly.*FrameScene/,
    );
    assert.equal(context.entrypoints.visual, "./visual.json");
  } finally {
    f.close();
  }
});
