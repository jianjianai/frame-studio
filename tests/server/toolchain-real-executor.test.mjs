import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { command } from "../../server/process.mjs";
import { PlatformClient } from "../../scripts/platform/client.mjs";
import { probeMedia } from "../../scripts/production-media.mjs";
import { filmSources } from "../fixtures/toolchain-film/sources.mjs";

const enabled = process.env.FRAME_TEST_EXECUTOR === "1";
const decodeRpc = (body) =>
  JSON.parse(
    body.startsWith("{")
      ? body
      : body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
  );
test(
  "real film: MCP atomic source installation → Docker frame/render → CLI wait/download → decoded media",
  { skip: !enabled, timeout: 240000 },
  async (t) => {
    const databaseUrl = process.env.FRAME_TEST_DATABASE_URL;
    assert.match(new URL(databaseUrl).pathname, /frame_test/);
    assert(process.env.FRAME_TEST_HOST_ROOT);
    const relative = ".cache/toolchain-executor-" + randomUUID(),
      data = path.resolve(relative);
    const artifactDirectory = path.resolve(
      ".cache/toolchain-real-film",
      randomUUID(),
    );
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const oldHost = process.env.FRAME_HOST_DATA;
    process.env.FRAME_HOST_DATA = path.posix.join(
      process.env.FRAME_TEST_HOST_ROOT,
      relative,
    );
    const db = await database(databaseUrl, "real-film-test-password-2026");
    await db.pool.query("TRUNCATE repos,tokens RESTART IDENTITY CASCADE");
    const platform = await createApp({
      db,
      data,
      masterKey: "63".repeat(32),
      scheduler: false,
    });
    const taskIds = [],
      tickErrors = [];
    let clock,
      pendingTick,
      rpcId = 0;
    try {
      await platform.app.listen({ host: "127.0.0.1", port: 0 });
      const base = `http://127.0.0.1:${platform.app.server.address().port}`;
      const repo = await platform.actions.call("repositories_add", {
        name: "Actual audiovisual acceptance",
      });
      const token = await platform.actions.call("tokens_create", {
        name: "real-film-toolchain",
      });
      const rpc = async (name, args = {}) => {
        const response = await fetch(base + "/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer " + token.token,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++rpcId,
            method: "tools/call",
            params: { name: "frame_" + name, arguments: args },
          }),
        });
        assert.equal(response.status, 200);
        const result = decodeRpc(await response.text()).result;
        assert(!result.isError, JSON.stringify(result));
        return result;
      };
      const value = (result) =>
        result.structuredContent ??
        JSON.parse(result.content.find((item) => item.type === "text").text);
      const cli = new PlatformClient({
        url: base,
        token: token.token,
        timeoutMs: 150000,
      });
      const work = value(
        await rpc("works_create", {
          repo: repo.id,
          title: "Real MCP + CLI signal journey",
          renderer: "canvas",
          duration: 24,
          audio: "generated",
          fps: 30,
        }),
      );
      const changes = [];
      for (const [file, content] of Object.entries(filmSources(work.project))) {
        const previous = value(
          await rpc("works_read_lines", {
            id: work.id,
            path: file,
            lineCount: 1,
          }),
        );
        changes.push({ path: file, content, expectedSha256: previous.sha256 });
      }
      const installed = value(
        await rpc("works_edit", { id: work.id, changes }),
      );
      assert(installed.applied);
      assert(installed.validation.passed);
      // A real local SVG is streamed through the HTTP upload API, not a fabricated material row.
      const assetFile = path.join(artifactDirectory, "signal.svg");
      fs.writeFileSync(
        assetFile,
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#79e8e0"/></svg>',
      );
      const asset = await cli.upload(assetFile, {
        repo: repo.id,
        license: "Original test artwork",
        mime: "image/svg+xml",
      });
      const attached = value(
        await rpc("works_use_asset", { id: work.id, asset: asset.id }),
      );
      assert(attached);
      const assets = value(await rpc("works_assets", { id: work.id }));
      assert(JSON.stringify(assets).includes(asset.id));
      clock = setInterval(() => {
        if (pendingTick) return;
        pendingTick = platform.tasks
          .tick()
          .catch((error) => tickErrors.push(error.message))
          .finally(() => {
            pendingTick = null;
          });
      }, 100);
      const frame = value(
        await rpc("works_task", {
          id: work.id,
          kind: "frame",
          input: { time: 13, width: 640 },
        }),
      );
      taskIds.push(frame.id);
      const readyFrame = (await cli.wait(frame.id, { timeoutMs: 150000 })).task;
      assert.equal(readyFrame.state, "succeeded");
      const png = readyFrame.result.artifacts.find((artifact) =>
        artifact.path.endsWith(".png"),
      );
      assert(png);
      const native = await rpc("artifact_read", {
        id: frame.id,
        path: png.path,
      });
      assert(
        native.content.some(
          (item) => item.type === "image" && item.mimeType === "image/png",
        ),
      );
      const frameDownload = await cli.download(
        frame.id,
        png.path,
        path.join(artifactDirectory, "frame.png"),
      );
      assert.equal(frameDownload.bytes, png.bytes);
      const render = await cli.call("works_task", {
        id: work.id,
        kind: "render",
        requestKey: randomUUID(),
        input: { width: 640, fps: 24, start: 12, end: 14, subtitles: false },
      });
      taskIds.push(render.id);
      const ready = (await cli.wait(render.id, { timeoutMs: 150000 })).task;
      assert.equal(ready.state, "succeeded");
      const artifact = ready.result.artifacts.find((item) =>
        item.path.endsWith(".mp4"),
      );
      assert(artifact);
      const download = await cli.download(
        render.id,
        artifact.path,
        path.join(artifactDirectory, "clip.mp4"),
      );
      assert.equal(download.bytes, artifact.bytes);
      const probe = await probeMedia(download.output),
        video = probe.streams.find((stream) => stream.codec_type === "video"),
        audio = probe.streams.find((stream) => stream.codec_type === "audio");
      assert.equal(video.width, 640);
      assert.equal(video.height, 360);
      assert.equal(Number(video.nb_read_frames), 48);
      assert.equal(video.avg_frame_rate, "24/1");
      assert.equal(audio.channels, 2);
      assert(Math.abs(Number(video.duration) - 2) < 0.05);
      const checkpoint = value(
        await rpc("works_checkpoint", {
          id: work.id,
          name: "Verified audiovisual source",
        }),
      );
      assert(checkpoint.id);
      const report = {
        passed: true,
        source: "actual HTTP MCP + platform CLI + pinned Docker executor",
        project: work.project,
        work: work.id,
        sourceEditFiles: changes.length,
        uploadedAsset: asset.id,
        frame: {
          task: frame.id,
          nativeImage: true,
          bytes: frameDownload.bytes,
          sha256: frameDownload.sha256,
        },
        render: {
          task: render.id,
          bytes: download.bytes,
          sha256: download.sha256,
          runtimeImage: ready.runtime?.image,
          width: video.width,
          height: video.height,
          frames: Number(video.nb_read_frames),
          fps: video.avg_frame_rate,
          duration: video.duration,
          audioChannels: audio.channels,
          serverChecksumAvailable: download.checksumVerified,
        },
        checkpoint: checkpoint.id,
        tickErrors,
        artifactDirectory: path.relative(process.cwd(), artifactDirectory),
      };
      assert.deepEqual(tickErrors, []);
      fs.mkdirSync(".cache/real-film", { recursive: true });
      fs.writeFileSync(
        ".cache/real-film/platform-acceptance.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      t.diagnostic(JSON.stringify(report));
    } finally {
      clearInterval(clock);
      await pendingTick;
      for (const id of taskIds)
        await command("docker", ["rm", "-f", "frame-task-" + id]).catch(
          () => {},
        );
      await platform.app.close();
      if (oldHost === undefined) delete process.env.FRAME_HOST_DATA;
      else process.env.FRAME_HOST_DATA = oldHost;
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
