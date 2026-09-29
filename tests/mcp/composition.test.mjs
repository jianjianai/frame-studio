import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, memoryClient, call, repo } from "./helpers.mjs";
import { validateAsset } from "../../scripts/asset-format.mjs";
test("CLI and MCP share composition revisions, split semantics, dry run and read-only boundaries", async () => {
  const f = fixture({ browser: true, renderer: "composition" });
  let m, ro;
  try {
    m = await memoryClient(f.root);
    const initial = await call(m.client, "frame_composition", {
      project: "test-film",
    });
    assert.equal(initial.document.clips.length, 0);
    const operations = [
      {
        op: "add",
        clip: {
          id: "base",
          source: { kind: "color", color: "#223344" },
          start: 0,
          duration: 2,
          transform: {
            opacity: [
              { at: 0, value: 0 },
              { at: 2, value: 1 },
            ],
          },
        },
      },
    ];
    const preview = await call(m.client, "frame_composition_edit", {
      project: "test-film",
      expectedSha256: initial.sha256,
      operations,
      dryRun: true,
    });
    assert.equal(preview.document.clips.length, 1);
    assert.equal(
      (await call(m.client, "frame_composition", { project: "test-film" }))
        .sha256,
      initial.sha256,
    );
    const saved = await call(m.client, "frame_composition_edit", {
      project: "test-film",
      expectedSha256: initial.sha256,
      operations,
    });
    const cli = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/visual-cli.mjs"),
        "test-film",
        "edit",
        "--input",
        "-",
        "--json",
      ],
      {
        cwd: f.root,
        encoding: "utf8",
        input: JSON.stringify({
          expectedSha256: saved.sha256,
          operations: [{ op: "split", id: "base", at: 1, newId: "right" }],
        }),
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).document.clips.length, 2);
    const state = await call(m.client, "frame_composition", {
      project: "test-film",
    });
    assert.equal(state.document.clips[1].phase, 1);
    const conflict = await m.client.callTool({
      name: "frame_composition_edit",
      arguments: {
        project: "test-film",
        expectedSha256: saved.sha256,
        operations: [{ op: "remove", id: "right" }],
      },
    });
    assert.equal(conflict.isError, true);
    assert.equal(
      (await call(m.client, "frame_composition", { project: "test-film" }))
        .sha256,
      state.sha256,
    );
    const invalid = await m.client.callTool({
      name: "frame_composition_edit",
      arguments: {
        project: "test-film",
        expectedSha256: state.sha256,
        operations: [
          {
            op: "add",
            clip: {
              id: "bad",
              source: { kind: "image", src: "films/other/file.png" },
              start: 0,
              duration: 1,
            },
          },
        ],
      },
    });
    assert.equal(invalid.isError, true);
    ro = await memoryClient(f.root, { readOnly: true });
    const list = await ro.client.listTools();
    assert(
      !list.tools.some(
        (t) =>
          t.name === "frame_composition_edit" ||
          t.name === "frame_media_transcode",
      ),
    );
    assert(list.tools.some((t) => t.name === "frame_composition"));
  } finally {
    await ro?.close();
    await m?.close();
    f.close();
  }
});
test("Lottie intake rejects unrelated JSON and external images, preserving source", async () => {
  const f = fixture();
  try {
    const file = f.file("public/lottie.json"),
      data = {
        v: "5.7",
        w: 100,
        h: 100,
        fr: 30,
        ip: 0,
        op: 60,
        layers: [],
        assets: [],
      };
    fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(
      (await validateAsset(file, "lottie.json", fs.statSync(file).size)).type,
      "animation",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...data,
        assets: [{ p: "https://example.invalid/track.png" }],
      }),
    );
    await assert.rejects(
      validateAsset(file, "lottie.json", fs.statSync(file).size),
      /embedded/,
    );
    fs.writeFileSync(file, '{"unrelated":true}');
    await assert.rejects(
      validateAsset(file, "lottie.json", fs.statSync(file).size),
      /Invalid Lottie/,
    );
  } finally {
    f.close();
  }
});
