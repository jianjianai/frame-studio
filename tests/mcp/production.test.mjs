import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, repo, memoryClient, call, waitForJob } from "./helpers.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import {
  createRenderSession,
  framePng,
} from "../../scripts/render-session.mjs";
import { inputManifest } from "../../scripts/production-input.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import {
  reviewSegment,
  verifyDelivery,
  compareReviews,
  recordReview,
} from "../../scripts/production-media.mjs";

test("shared search, patch and checkpoint restoration reject ambiguity and changed versions", () => {
  const f = fixture();
  try {
    const w = new ProjectService(f.root);
    const original = w.readFile("test-film", "scene.ts");
    const found = w.search("test-film", { query: "createScene" });
    assert.ok(found.matches.some((m) => m.path === "scene.ts"));
    assert.throws(
      () =>
        w.patch("test-film", [
          {
            path: "scene.ts",
            expectedSha256: original.sha256,
            replacements: [{ find: "not present", replace: "x" }],
          },
        ]),
      /match count/,
    );
    const edited = w.patch("test-film", [
      {
        path: "scene.ts",
        expectedSha256: original.sha256,
        replacements: [
          { find: "createScene", replace: "createScene /* changed */" },
        ],
      },
    ]);
    assert.ok(edited.checkpoint);
    const beforeRestore = w.fingerprint("test-film");
    assert.equal(
      w.restore("test-film", edited.checkpoint, beforeRestore).dryRun,
      true,
    );
    fs.writeFileSync(f.file("public/new.bin"), Buffer.from([1, 2, 3]));
    assert.throws(
      () => w.restore("test-film", edited.checkpoint, beforeRestore, false),
      /changed/,
    );
    w.restore(
      "test-film",
      edited.checkpoint,
      w.fingerprint("test-film"),
      false,
    );
    assert.equal(w.readFile("test-film", "scene.ts").sha256, original.sha256);
    assert.deepEqual(
      fs.readFileSync(f.file("public/new.bin")),
      Buffer.from([1, 2, 3]),
    );
    assert.ok(w.history("test-film").checkpoints.length >= 2);
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/film.mjs"),
        "search",
        "test-film",
        "--query",
        "createScene",
        "--json",
      ],
      { cwd: f.root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).matches.length);
  } finally {
    f.close();
  }
});

test(
  "production page freezes code/assets and ignores broken sibling projects; project validation isolates types",
  { timeout: 120000 },
  async () => {
    const f = fixture({ browser: true });
    let session;
    try {
      fs.mkdirSync(path.join(f.root, "projects/broken-film"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(f.root, "projects/broken-film/project.ts"),
        "this is not valid typescript !!!",
      );
      const listed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/film.mjs"), "list", "--json"],
        { cwd: f.root, encoding: "utf8" },
      );
      assert.equal(listed.status, 0, listed.stderr);
      const catalog = JSON.parse(listed.stdout);
      assert.equal(catalog.projects[0].id, "test-film");
      assert.equal(catalog.errors[0].id, "broken-film");
      session = await createRenderSession({ root: f.root, width: 320 });
      const page = await session.page("test-film");
      const first = await framePng(page, 0.5);
      const input = session.input("test-film").fingerprint;
      fs.appendFileSync(
        f.file("scene.ts"),
        '\nthrow new Error("changed after capture");',
      );
      fs.writeFileSync(f.file("public/test.bin"), "changed asset");
      assert.notEqual(inputManifest(f.root, "test-film").fingerprint, input);
      assert.deepEqual(await framePng(page, 0.5), first);
      assert.equal(page.frameDiagnostics().errors.length, 0);
      const types = await executeProject(f.root, "test-film", "typecheck");
      assert.equal(types.status, "passed", types.output);
      assert.ok(!types.output.includes("broken-film"));
      const build = await executeProject(f.root, "test-film", "build");
      assert.equal(build.status, "passed", JSON.stringify(build));
      assert.ok(fs.existsSync(path.join(build.output, "index.html")));
    } finally {
      await session?.close();
      f.close();
    }
  },
);

test(
  "review package, actual final-media verification, A/B and time-bound review records work through CLI domain",
  { timeout: 180000 },
  async () => {
    const f = fixture({ browser: true });
    try {
      const review = await reviewSegment(f.root, "test-film", {
        start: 0,
        end: 0.5,
        width: 320,
        fps: 12,
      });
      assert.equal(review.status, "passed");
      const report = JSON.parse(fs.readFileSync(review.report, "utf8"));
      assert.equal(report.contentReview.listening, "not_run");
      assert.ok(report.audio.length >= 2);
      assert.ok(fs.existsSync(path.join(review.directory, "storyboard.png")));
      const delivery = await verifyDelivery(f.root, "test-film", {
        file: path.join(review.directory, "clip.mp4"),
      });
      assert.equal(delivery.status, "passed", JSON.stringify(delivery));
      assert.equal(delivery.media.decodedFrames, 6);
      assert.equal(delivery.version.matches, true);
      const wrong = await verifyDelivery(f.root, "test-film", {
        file: path.join(review.directory, "clip.mp4"),
        expected: { frames: 7 },
      });
      assert.equal(wrong.status, "failed");
      const comparison = compareReviews(
        f.root,
        "test-film",
        review.reviewId,
        review.reviewId,
      );
      assert.ok(fs.existsSync(comparison.page));
      const note = recordReview(f.root, "test-film", review.reviewId, {
        reviewer: "test",
        time: 0.2,
        note: "fixture note",
        visual: true,
      });
      assert.equal(note.listening, false);
      assert.equal(note.input, review.input);
      assert.throws(
        () =>
          recordReview(f.root, "test-film", review.reviewId, {
            reviewer: "test",
            time: 1,
            note: "bad range",
          }),
        /inside/,
      );
      const connection = await memoryClient(f.root);
      try {
        const image = await connection.client.callTool({
          name: "frame_review_artifact",
          arguments: {
            project: "test-film",
            reviewId: review.reviewId,
            name: "storyboard.png",
          },
        });
        assert.equal(image.content[0].type, "image");
        const job = await call(connection.client, "frame_start_validation", {
          project: "test-film",
          action: "typecheck",
        });
        assert.equal(
          (await waitForJob(connection.client, "test-film", job.id)).status,
          "succeeded",
        );
      } finally {
        await connection.close();
      }
    } finally {
      f.close();
    }
  },
);
