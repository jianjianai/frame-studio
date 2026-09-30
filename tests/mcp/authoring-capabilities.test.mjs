import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { call, fixture, memoryClient, repo } from "./helpers.mjs";
import { getAuthoringCapabilities, authoringCapabilitySummary } from "../../src/contracts/capabilities.mjs";

const cli = (root, args) => spawnSync(process.execPath, [path.join(repo, "scripts/film.mjs"), ...args], { cwd: root, encoding: "utf8" });

test("capabilities can be discovered before creation with focused CLI and readonly MCP results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-capability-discovery-"));
  let m;
  try {
    m = await memoryClient(root, { readOnly: true });
    for (const filter of [{}, { category: "audio" }, { query: "GSAP" }, { id: "remotion" }, { category: "visual", query: "remotion" }]) {
      const args = ["capabilities", ...Object.entries(filter).flatMap(([key, value]) => ["--" + key, value]), "--json"];
      const result = cli(root, args);
      assert.equal(result.status, 0, result.stderr);
      const expected = getAuthoringCapabilities(filter);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      assert.deepEqual(await call(m.client, "frame_capabilities", filter), expected);
    }
    assert.equal(fs.existsSync(path.join(root, "projects")), false, "Discovery does not create a project");
    const readable = cli(root, ["capabilities", "--query", "GSAP"]);
    assert.equal(readable.status, 0, readable.stderr);
    assert.match(readable.stdout, /GSAP/);
    assert.match(readable.stdout, /类型:/);
    assert.match(readable.stdout, /入口:/);
    assert.match(readable.stdout, /边界:/);
    assert.match(readable.stdout, /\n类型:/, "Text output has real line breaks");
    const none = cli(root, ["capabilities", "--query", "not-a-real-capability"]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /没有匹配/);
  } finally { await m?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("capability filters reject unknown, duplicate, malformed and positional inputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-capability-validation-"));
  let m;
  try {
    m = await memoryClient(root, { readOnly: true });
    for (const args of [
      ["--category", "unknown"], ["--id", "unknown-capability"], ["--query", ""],
      ["--query", " ".repeat(2)], ["--query", "x".repeat(201)], ["--id", "x".repeat(101)],
      ["--unsupported"], ["--unsupported", "--help"], ["unexpected-project"],
      ["--help", "-h"],
      ["--category", "audio", "--category", "visual"],
      ["--category", "audio", "--category", "visual", "--help"],
      ["--query", "GSAP", "--query=Tone"], ["--id=remotion", "--id", "three"],
      ["--json"],
    ]) {
      const result = cli(root, ["capabilities", ...args, "--json"]);
      assert.notEqual(result.status, 0, JSON.stringify(args));
      assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENTS");
    }
    for (const args of [
      { category: "unknown" }, { id: "unknown-capability" }, { query: "" },
      { query: "  " }, { query: "x".repeat(201) }, { id: "x".repeat(101) },
      { unsupported: true }, { project: "test-film" },
    ]) {
      const result = await m.client.callTool({ name: "frame_capabilities", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
  } finally { await m?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI and MCP schemas, help and resources discover the same capability entrypoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-capability-schemas-"));
  let m;
  try {
    m = await memoryClient(root, { readOnly: true });
    const help = JSON.parse(cli(root, ["help", "--json"]).stdout);
    assert(help.commands.some(command => command.name === "capabilities"));
    const described = JSON.parse(cli(root, ["describe", "capabilities", "--json"]).stdout);
    const filteredHelp = cli(root, ["capabilities", "--category", "audio", "--help", "--json"]);
    assert.equal(filteredHelp.status, 0, filteredHelp.stderr);
    assert.deepEqual(JSON.parse(filteredHelp.stdout), described);
    assert.equal(described.requestSchema.additionalProperties, false);
    assert.deepEqual(described.options.category.enum, ["visual", "media", "animation", "audio"]);
    assert.equal(described.options.query.maxLength, 200);
    assert.equal(described.options.id.maxLength, 100);
    assert.equal(described.requestSchema.required, undefined, "No project or filters are required");
    const localHelp = await call(m.client, "frame_help", { query: "capabilities", limit: 100 });
    assert(localHelp.tools.some(tool => tool.name === "frame_capabilities"));
    const tool = await call(m.client, "frame_tool_describe", { name: "capabilities" });
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema, described.requestSchema, "CLI and MCP share the authoritative filter schema");
    assert.deepEqual(tool.inputSchema.properties.category.enum, described.options.category.enum);
    assert.equal(tool.inputSchema.properties.query.maxLength, 200);
    assert.equal(tool.inputSchema.required, undefined);
    const resources = await m.client.listResources();
    assert(resources.resources.some(resource => resource.uri === "frame://capabilities"));
    const resource = await m.client.readResource({ uri: "frame://capabilities" });
    assert.deepEqual(JSON.parse(resource.contents[0].text), getAuthoringCapabilities());
    const context = await call(m.client, "frame_workspace_context");
    assert.deepEqual(context.capabilities, authoringCapabilitySummary());
    assert.match(context.discovery, /frame_capabilities/);
    assert(!Object.hasOwn(context.capabilities, "items"), "Bootstrap contains a summary instead of the detailed catalog");
    assert((await call(m.client, "frame_renderers")).adapters.length);
    assert((await call(m.client, "frame_audio_engines")).engines.length);
    for (const args of [["composition", "engines", "--json"], ["audio", "engines", "--json"]]) {
      const result = cli(root, args);
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { await m?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("project handoffs include compact capabilities and a focused discovery command", async () => {
  const f = fixture({ renderer: "composition" });
  let m;
  try {
    m = await memoryClient(f.root, { readOnly: true });
    for (const report of [
      JSON.parse(cli(f.root, ["inspect", "test-film", "--json"]).stdout),
      JSON.parse(cli(f.root, ["context", "test-film", "--json"]).stdout),
      await call(m.client, "frame_project_context", { project: "test-film" }),
    ]) {
      assert.deepEqual(report.capabilities, authoringCapabilitySummary());
      assert(!Object.hasOwn(report.capabilities, "items"));
      assert.equal(report.metadata.renderer, "composition");
    }
    const context = JSON.parse(cli(f.root, ["context", "test-film", "--json"]).stdout);
    assert.equal(context.commands.capabilities, "pnpm --silent film capabilities --json");
  } finally { await m?.close(); f.close(); }
});
