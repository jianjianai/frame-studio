import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, memoryClient, call, repo } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import { remotionProjectAssets } from "../../scripts/remotion-project-assets.mjs";

test("Remotion CLI/MCP scaffolding, authoritative component, JSON props and asset isolation", async () => {
  const f = fixture({ browser: true });
  let m;
  try {
    m = await memoryClient(f.root);
    const result = await call(m.client, "frame_create_project", {
      project: "react-film",
      title: 'React "影片"',
      renderer: "remotion",
      width: 640,
      height: 360,
    });
    assert.equal(result.metadata.renderer, "remotion");
    assert.equal(result.entrypoints.remotion, "./composition");
    assert.equal(result.authority.visual.reference, "remotion");
    assert.match(
      fs.readFileSync(
        path.join(f.root, "projects/react-film/composition.tsx"),
        "utf8",
      ),
      /useCurrentFrame/,
    );
    const command = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/film.mjs"),
        "new",
        "react-cli",
        "React",
        "--renderer",
        "remotion",
        "--json",
      ],
      { cwd: f.root, encoding: "utf8" },
    );
    assert.equal(command.status, 0, command.stderr);
    assert.equal(
      JSON.parse(command.stdout).context.entrypoints.remotion,
      "./composition",
    );
    const ref = spawnSync(
      process.execPath,
      [path.join(repo, "scripts/film.mjs"), "reference", "remotion", "--json"],
      { cwd: f.root, encoding: "utf8" },
    );
    assert.equal(ref.status, 0, ref.stderr);
    assert.match(JSON.parse(ref.stdout).content, /FrameScene/);
    const source =
      'import {staticFile as asset,Sequence} from "remotion"; const url=asset("a b.png");';
    const a = remotionProjectAssets(
      source,
      path.join(f.root, "projects/react-film/composition.tsx"),
      f.root,
    ).code;
    const b = remotionProjectAssets(
      source,
      path.join(f.root, "projects/react-cli/composition.tsx"),
      f.root,
    ).code;
    assert.match(a, /films\/react-film/);
    assert.match(b, /films\/react-cli/);
    assert.match(a, /const asset=/);
    const namespace = remotionProjectAssets(
      'import * as R from "remotion";R.staticFile("a.png")',
      path.join(f.root, "projects/react-film/a.ts"),
      f.root,
    ).code;
    assert.match(namespace, /staticFile:/);
  } finally {
    await m?.close();
    f.close();
  }
});
