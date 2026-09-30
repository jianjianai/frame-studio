import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, memoryClient, call, repo } from "./helpers.mjs";
import { readCreatorContext } from "../../scripts/creator-context.mjs";
import { projectCreationOptions } from "../../src/contracts/authoring.mjs";

const cli = (root, args, input) => {
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/film.mjs"), ...args], { cwd: root, encoding: "utf8", input });
  return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
};
test("CLI and MCP creation share defaults, dimensions, complete context and no-overwrite behavior", async () => {
  const f = fixture({ browser: true, renderer: "composition" });
  let m;
  try {
    m = await memoryClient(f.root);
    const created = await call(m.client, "frame_create_project", { project: "mcp-film", title: "MCP", width: 640, height: 360 });
    const local = cli(f.root, ["new", "cli-film", "CLI", "--width", "640", "--height", "360", "--json"]);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.value.output, path.join(f.root, "projects/cli-film"));
    assert.equal(local.value.project, "cli-film");
    for (const context of [created, local.value.context]) {
      assert.equal(context.metadata.duration, 24);
      assert.equal(context.metadata.renderer, "composition");
      assert.deepEqual({ ...context.metadata.composition }, { width: 640, height: 360 });
      assert.equal(context.entrypoints.visual, "./visual.json");
      assert.equal(context.authority.visual.mode, "document");
    }
    const duplicate = cli(f.root, ["new", "cli-film", "Overwrite", "--json"]);
    assert.notEqual(duplicate.status, 0);
    assert.equal(cli(f.root, ["context", "cli-film", "--json"]).value.metadata.title, "CLI");
    for (const args of [{ title: "Bad", width: 640 }, { title: "Bad", width: 640, height: 360, composition: { width: 640, height: 360 } }, { title: "Bad", duration: NaN }])
      assert.throws(() => projectCreationOptions(args));
    const bad = await m.client.callTool({ name: "frame_create_project", arguments: { project: "bad-film", title: "Bad", width: 640 } });
    assert.equal(bad.isError, true);
    assert.equal(fs.existsSync(path.join(f.root, "projects/bad-film")), false);
  } finally { await m?.close(); f.close(); }
});
test("help and describe are machine-readable, readonly discovery omits writes, and reference catalog is complete", async () => {
  const f = fixture({ browser: true });
  let m;
  try {
    for (const args of [["help", "--json"], ["composition", "missing", "--help", "--json"], ["audio", "missing", "edit", "--help", "--json"], ["describe", "job", "wait", "--json"], ["mcp", "--help", "--json"]]) {
      const response = cli(f.root, args);
      assert.equal(response.status, 0, response.stderr);
      assert.equal(response.value.schemaVersion, 1);
    }
    const edit = cli(f.root, ["describe", "audio", "edit", "--json"]).value;
    assert.equal(edit.requestSchema.properties.dryRun.default, false);
    const refs = cli(f.root, ["reference", "--json"]).value.references;
    assert(refs.some(ref => ref.name === "composition"));
    assert(refs.some(ref => ref.name === "audio-v7"));
    assert.match(cli(f.root, ["reference", "audio-v7", "--json"]).value.content, /audio\.json/);
    m = await memoryClient(f.root, { readOnly: true });
    const overview = await call(m.client, "frame_workspace_context");
    assert.equal(overview.readOnly, true);
    const help = await call(m.client, "frame_help", { limit: 100 });
    assert(!help.tools.some(tool => tool.name === "frame_create_project"));
    const tool = await call(m.client, "frame_tool_describe", { name: "audio" });
    assert.deepEqual(tool.inputSchema.required, ["project"]);
    assert.equal(tool.annotations.readOnlyHint, true);
    const denied = await m.client.callTool({ name: "frame_tool_describe", arguments: { name: "frame_audio_edit" } });
    assert.equal(denied.isError, true);
    await call(m.client, "frame_read_reference", { name: "composition" });
    await call(m.client, "frame_read_reference", { name: "audio-v7" });
    assert.equal(cli(f.root, ["describe", "typo", "--json"]).value.error.code, "UNKNOWN_COMMAND");
  } finally { await m?.close(); f.close(); }
});
test("Agent, CLI and MCP handoffs select the declared mix and preserve JSON dryRun without a flag", async () => {
  const f = fixture({ browser: true, renderer: "composition" });
  let m;
  try {
    m = await memoryClient(f.root);
    const legacy = await call(m.client, "frame_audio", { project: "test-film" });
    const document = { ...legacy.document, tracks: [...legacy.document.tracks, { id: "voice", name: "Voice" }] };
    const request = { expectedSha256: null, projectSha256: legacy.projectSha256, operations: [{ op: "replace", document }], dryRun: true };
    const dryAudio = cli(f.root, ["audio", "test-film", "edit", "--input", "-", "--json"], JSON.stringify(request));
    assert.equal(dryAudio.status, 0, dryAudio.stderr);
    assert.equal(fs.existsSync(f.file("audio.json")), false);
    await call(m.client, "frame_audio_edit", { project: "test-film", ...request, dryRun: false });
    const contexts = [readCreatorContext(f.root, { project: "test-film" }, {}), cli(f.root, ["context", "test-film", "--json"]).value,
      await call(m.client, "frame_project_context", { project: "test-film" })];
    for (const context of contexts) {
      assert.equal(context.entrypoints.audioDocument, "./audio.json");
      assert.equal(context.authority.audio.mode, "document");
      assert.equal(context.authority.audio.tracks, 2);
      assert.equal(context.audioTracks.length, 2);
      assert.equal(context.audioTracks[1].id, "voice");
      assert.match(context.authority.audio.sha256, /^[a-f0-9]{64}$/);
    }
    const visual = await call(m.client, "frame_composition", { project: "test-film" });
    const changes = { expectedSha256: visual.sha256, dryRun: true, operations: [{ op: "add", clip: { id: "background", source: { kind: "color", color: "#223344" }, start: 0, duration: 2 } }] };
    const dryVisual = cli(f.root, ["composition", "test-film", "edit", "--input", "-", "--json"], JSON.stringify(changes));
    assert.equal(dryVisual.status, 0, dryVisual.stderr);
    assert.equal((await call(m.client, "frame_composition", { project: "test-film" })).sha256, visual.sha256);
    const bad = cli(f.root, ["composition", "test-film", "get", "--input", "-", "--json"], "{}");
    assert.notEqual(bad.status, 0);
    assert.equal(bad.value.error.code, "INVALID_ARGUMENTS");
    assert.match(bad.value.error.nextAction, /schema/);
    const malformed = cli(f.root, ["audio", "test-film", "edit", "--input", "-", "--json"], "secret-sensitive-not-json");
    assert.equal(malformed.value.error.code, "INVALID_JSON");
    assert(!malformed.stdout.includes("secret-sensitive"));
    fs.writeFileSync(f.file("audio.json"), '{"schemaVersion":1,"tracks":"broken"}');
    const repair = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(repair.status, "needs_repair");
    assert(repair.engineering.issues.length);
  } finally { await m?.close(); f.close(); }
});
