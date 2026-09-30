import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentTools } from "../../server/agent-tools.mjs";

function materialFixture(
  t,
  { mime, filename, mode = "legacy", unconnectedVisual = false },
) {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "frame-agent-material-authority-"),
  );
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const bytes = Buffer.from("material import fixture"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    task = { id: randomUUID(), repo: randomUUID(), project: "authority-film" },
    asset = {
      id: randomUUID(),
      name: filename,
      mime,
      sha,
      bytes: bytes.length,
      license: "Fixture source and license",
      deleted: false,
    },
    project = path.join(data, "runs", task.id, "projects", task.project),
    metadata = unconnectedVisual
      ? 'const project = {renderer:"remotion",loadVisual:()=>import("./visual.json"),loadRemotion:()=>import("./react-root")}; export default project;\n'
      : "Existing metadata must remain unchanged during material import.\n",
    visual = '{"schemaVersion":1,"clips":[]}\n',
    reactRoot =
      "export default function Film(){return <div>React root without FrameScene</div>;}\n",
    audio = '{"existing":"authoritative mix must remain unchanged"}\n',
    calls = [];
  fs.mkdirSync(path.join(data, "blobs"), { recursive: true });
  fs.writeFileSync(path.join(data, "blobs", sha), bytes);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.ts"), metadata);
  if (unconnectedVisual) {
    fs.writeFileSync(path.join(project, "visual.json"), visual);
    fs.writeFileSync(path.join(project, "react-root.tsx"), reactRoot);
  }
  if (mode === "document")
    fs.writeFileSync(path.join(project, "audio.json"), audio);
  let route;
  agentTools({
    app: {
      post(url, handler) {
        assert.equal(url, "/api/agent/action");
        route = handler;
      },
    },
    db: {
      async one(sql, params) {
        assert.match(sql, /asset_repos/);
        assert.deepEqual(params, [asset.id, task.repo]);
        return { asset: asset.id };
      },
      async lock(key, handler) {
        assert.equal(key, "agent-material:" + task.id);
        return handler();
      },
    },
    data,
    assets: {
      async get(id) {
        assert.equal(id, asset.id);
        calls.push("asset");
        return asset;
      },
    },
    actions: {
      async call(name, args) {
        calls.push(name);
        assert.equal(name, "speech_generate");
        assert.equal(args.repo, task.repo);
        assert.equal(args.project, undefined);
        return {
          asset,
          requestId: "fixture-request",
          applied: { speed: 1 },
          warnings: [],
        };
      },
    },
    localMode: true,
  });
  return {
    task,
    asset,
    project,
    calls,
    async import(name = "use") {
      const result = await route({
        agentTask: task,
        body: {
          name,
          args:
            name === "speech"
              ? { engine: "fixture", text: "旁白" }
              : { asset: asset.id },
        },
      });
      assert.equal(result.mime, mime);
      assert.equal(
        result.url,
        "films/authority-film/imports/" +
          sha.slice(0, 20) +
          path.extname(filename),
      );
      assert.deepEqual(
        fs.readFileSync(
          path.join(project, result.path.split("/").slice(2).join("/")),
        ),
        bytes,
      );
      const refs = JSON.parse(
        fs.readFileSync(
          path.join(project, "production/materials.json"),
          "utf8",
        ),
      );
      assert.deepEqual(refs, [
        {
          asset: asset.id,
          path: result.path.split("/").slice(2).join("/"),
          sha256: sha,
          source: asset.license,
          name: filename,
        },
      ]);
      assert.equal(
        fs.readFileSync(path.join(project, "project.ts"), "utf8"),
        metadata,
      );
      if (mode === "document")
        assert.equal(
          fs.readFileSync(path.join(project, "audio.json"), "utf8"),
          audio,
        );
      else assert.equal(fs.existsSync(path.join(project, "audio.json")), false);
      if (unconnectedVisual) {
        assert.equal(
          fs.readFileSync(path.join(project, "visual.json"), "utf8"),
          visual,
        );
        assert.equal(
          fs.readFileSync(path.join(project, "react-root.tsx"), "utf8"),
          reactRoot,
        );
      }
      return result;
    },
  };
}

for (const mode of ["legacy", "document"])
  test(
    "Agent audio material imports give actionable authoritative mix instructions in " +
      mode +
      " works",
    async (t) => {
      const fixture = materialFixture(t, {
        mime: "audio/wav",
        filename: "voice.wav",
        mode,
      });
      const result = await fixture.import();
      assert.deepEqual(fixture.calls, ["asset"]);
      assert.match(result.nextAction, /node scripts\/work-tool\.mjs context/);
      assert.match(result.nextAction, /film audio authority-film get --json/);
      assert.match(result.nextAction, /authority\.audio\.mode is document/);
      assert.match(result.nextAction, /authority\.audio\.mode is legacy/);
      assert.match(result.nextAction, /expectedSha256:null.*projectSha256/);
      assert.match(
        result.nextAction,
        /film audio authority-film edit --input projects\/authority-film\/production\/material-import\.json --json/,
      );
      assert.match(
        result.nextAction,
        /put operations.*file source.*track.*timed clip/,
      );
      assert.match(
        result.nextAction,
        /Do not change stale project\.ts audioTracks/,
      );
      assert(
        result.nextAction.includes(
          "film audio-media authority-film probe --src " +
            result.url +
            " --json",
        ),
      );
      assert.doesNotMatch(
        result.nextAction,
        /Add this URL to a file audioTrack in project\.ts/,
      );
    },
  );

test("Agent final speech preserves synthesis results and uses authoritative mix integration", async (t) => {
  const fixture = materialFixture(t, {
    mime: "audio/mpeg",
    filename: "narration.mp3",
    mode: "document",
  });
  const result = await fixture.import("speech");
  assert.deepEqual(fixture.calls, ["speech_generate"]);
  assert.equal(result.requestId, "fixture-request");
  assert.deepEqual(result.applied, { speed: 1 });
  assert.deepEqual(result.warnings, []);
  assert.match(result.nextAction, /authoritative audio\.json/);
  assert.match(result.nextAction, /measure duration.*subtitles/);
});

for (const [mime, filename, kind] of [
  ["image/png", "picture.png", "image"],
  ["video/webm", "footage.webm", "video"],
])
  test(
    "Agent " +
      kind +
      " imports offer visual document and code entrypoints rather than audio tracks",
    async (t) => {
      const fixture = materialFixture(t, { mime, filename });
      const result = await fixture.import();
      assert.deepEqual(fixture.calls, ["asset"]);
      assert.match(
        result.nextAction,
        /For other renderers, inspect authority\.visual/,
      );
      assert.match(
        result.nextAction,
        /first inspect context\.projectInfo\.renderer/,
      );
      assert.match(
        result.nextAction,
        /specific FrameScene used by this root consumes that Canvas child document/,
      );
      assert.match(
        result.nextAction,
        /declared loadVisual alone does not prove visual\.json is visible/,
      );
      assert(
        result.nextAction.indexOf("context.projectInfo.renderer") <
          result.nextAction.indexOf("composition authority-film get"),
      );
      assert.match(
        result.nextAction,
        /film composition authority-film get --json/,
      );
      assert.match(
        result.nextAction,
        /film composition authority-film edit --input projects\/authority-film\/production\/material-import\.json --json/,
      );
      assert.match(
        result.nextAction,
        new RegExp("add a " + kind + " source clip"),
      );
      assert.match(
        result.nextAction,
        /If the renderer is remotion.*actual context\.entrypoints\.remotion.*composition\.tsx.*reference remotion/,
      );
      assert.match(result.nextAction, /Video sound is enabled explicitly/);
      assert.doesNotMatch(result.nextAction, /film audio authority-film edit/);
    },
  );

test("Agent visual imports prioritize a custom React root despite an unconnected loadVisual document", async (t) => {
  const fixture = materialFixture(t, {
    mime: "image/png",
    filename: "overlay.png",
    unconnectedVisual: true,
  });
  const result = await fixture.import();
  assert.deepEqual(fixture.calls, ["asset"]);
  assert.match(
    result.nextAction,
    /first inspect context\.projectInfo\.renderer/,
  );
  assert.match(
    result.nextAction,
    /start with the actual context\.entrypoints\.remotion/,
  );
  assert.match(
    result.nextAction,
    /Edit visual\.json only after verifying.*FrameScene.*consumes that Canvas child document/,
  );
  assert.match(
    result.nextAction,
    /loadVisual alone does not prove visual\.json is visible/,
  );
  assert(
    result.nextAction.indexOf("If the renderer is remotion") <
      result.nextAction.indexOf("For other renderers"),
  );
  assert.doesNotMatch(
    result.nextAction,
    /For document mode.*read .*composition.*For code mode.*Remotion/,
  );
});

for (const { label, mime, filename, expectations } of [
  {
    label: "GLB by extension",
    mime: "application/octet-stream",
    filename: "product.GLB",
    expectations: [
      /capabilities --id three --json/,
      /createThreeScene from src\/engine\/scene-adapters\.ts and loadGltf/,
      /referenced buffers\/textures/,
      /scene resource, not a visual source\.kind/,
      /context\.projectInfo\.renderer.*actual context\.entrypoints\.remotion/,
      /loadVisual declaration alone does not make a model visible/,
    ],
  },
  {
    label: "glTF by MIME",
    mime: "model/gltf+json",
    filename: "model.blob",
    expectations: [
      /capabilities --id three --json/,
      /loadGltf/,
      /companion files/,
      /register that module and a scene clip/,
    ],
  },
  {
    label: "SF2 by extension",
    mime: "application/octet-stream",
    filename: "instruments.sf2",
    expectations: [
      /capabilities --id soundfont --json/,
      /SoundFont SF2 bank/,
      /createSampledScoreAudio/,
      /SHA-256 from production\/materials\.json/,
      /generators.*loadAudio/,
    ],
  },
  {
    label: "MIDI by audio MIME",
    mime: " Audio\/X-MIDI; charset=binary ",
    filename: "score.bin",
    expectations: [
      /capabilities --id soundfont --json/,
      /MIDI score/,
      /Parse the MIDI.*required event score.*separately imported compatible SF2 bank/,
      /generator inputs, not decoded file audio/,
    ],
  },
  {
    label: "MIDI by extension",
    mime: "application/octet-stream",
    filename: "music.MID",
    expectations: [
      /MIDI score/,
      /createSampledScoreAudio/,
      /generated source with engine:"soundfont"/,
    ],
  },
  {
    label: "font by MIME",
    mime: "font/woff2",
    filename: "typography.blob",
    expectations: [
      /capabilities --category visual --json/,
      /FontFace/,
      /@font-face/,
      /Await font readiness/,
    ],
  },
  {
    label: "font by extension",
    mime: "application/octet-stream",
    filename: "typeface.TTF",
    expectations: [
      /font resource/,
      /project-local CSS for Remotion\/DOM/,
      /not standalone visual clip or file audio sources/,
    ],
  },
  {
    label: "unclassified JSON",
    mime: "application/json",
    filename: "settings.json",
    expectations: [
      /JSON extension or MIME does not identify an animation/,
      /capabilities --id lottie --json/,
      /validateLottie from src\/engine\/lottie-document\.mjs/,
      /only a valid self-contained Lottie animation/,
      /context\.projectInfo\.renderer.*actual context\.entrypoints\.remotion/,
      /edit a child visual\.json only after confirming this FrameScene consumes it/,
      /Other JSON belongs/,
    ],
  },
  {
    label: "JSON by extension",
    mime: "application/octet-stream",
    filename: "animation.JSON",
    expectations: [
      /inspect the contents/,
      /validateLottie/,
      /Do not invent a JSON visual source\.kind/,
    ],
  },
  {
    label: "unknown resource",
    mime: "application/octet-stream",
    filename: "custom-data.bin",
    expectations: [
      /capabilities --json/,
      /inspect the actual file format/,
      /confirm a documented adapter or project-local implementation/,
      /successful import do not prove runtime support/,
      /Do not invent a visual source\.kind/,
    ],
  },
])
  test(
    "Agent " + label + " import requires its real resource integration",
    async (t) => {
      const fixture = materialFixture(t, { mime, filename });
      const result = await fixture.import();
      assert.deepEqual(fixture.calls, ["asset"]);
      assert(result.nextAction.includes(result.url));
      for (const expectation of expectations)
        assert.match(result.nextAction, expectation);
      assert.doesNotMatch(result.nextAction, /matching supported media kind/);
      assert.doesNotMatch(result.nextAction, /add a .* source clip/);
      assert.doesNotMatch(
        result.nextAction,
        /audio-media authority-film probe/,
      );
      assert.doesNotMatch(
        result.nextAction,
        /authoritative audio\.json with .* audio .* edit/,
      );
    },
  );

test("Agent generic-MIME audio still offers real codec probing by filename", async (t) => {
  const fixture = materialFixture(t, {
    mime: "application/octet-stream",
    filename: "narration.WAV",
  });
  const result = await fixture.import();
  assert.match(result.nextAction, /authoritative audio\.json/);
  assert(
    result.nextAction.includes(
      "audio-media authority-film probe --src " + result.url + " --json",
    ),
  );
  assert.match(result.nextAction, /confirm codec support/);
});
