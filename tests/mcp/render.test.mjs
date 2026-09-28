import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture, memoryClient, call, waitForJob } from "./helpers.mjs";

test(
  "MCP edits a real scene, returns PNG pixels, exports mixed MP4 and persists results",
  { timeout: 180000 },
  async () => {
    const f = fixture({ browser: true });
    const session = await memoryClient(f.root);
    try {
      const { client } = session;
      const source = await call(client, "frame_read_file", {
        project: "test-film",
        path: "scene.ts",
      });
      await call(client, "frame_edit_files", {
        project: "test-film",
        changes: [
          {
            path: "scene.ts",
            expectedSha256: source.sha256,
            content: source.content.replace("#e4ead9", "#112233"),
          },
        ],
      });
      const started = await call(client, "frame_start_preview", {
        project: "test-film",
        mode: "frame",
        time: 0.5,
        width: 320,
        subtitles: false,
      });
      const busy = await client.callTool({
        name: "frame_edit_files",
        arguments: {
          project: "test-film",
          changes: [
            {
              path: "busy.md",
              expectedSha256: null,
              content: "not allowed during render",
            },
          ],
        },
      });
      assert.equal(busy.structuredContent.error.code, "PROJECT_BUSY");
      const frame = await waitForJob(client, "test-film", started.id);
      assert.equal(frame.status, "succeeded", JSON.stringify(frame));
      assert.equal(frame.sourceChanged, false);
      const result = await client.callTool({
        name: "frame_read_artifact",
        arguments: { project: "test-film", jobId: frame.id, name: "frame.png" },
      });
      const image = result.content.find((block) => block.type === "image");
      assert.ok(image, JSON.stringify(result));
      const raw = await sharp(Buffer.from(image.data, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.deepEqual([...raw.subarray(0, 3)], [0x11, 0x22, 0x33]);
      const resource = await client.readResource({
        uri: frame.artifacts[0].uri,
      });
      assert.equal(resource.contents[0].blob, image.data);
      const storyboardStart = await call(client, "frame_start_preview", {
        project: "test-film",
        times: [0, 0.5, 1],
        width: 320,
      });
      const storyboard = await waitForJob(
        client,
        "test-film",
        storyboardStart.id,
      );
      assert.equal(storyboard.status, "succeeded", JSON.stringify(storyboard));
      const manifestResult = await client.callTool({
        name: "frame_read_artifact",
        arguments: {
          project: "test-film",
          jobId: storyboard.id,
          name: "storyboard.png.json",
        },
      });
      const manifest = JSON.parse(manifestResult.content[1].text);
      assert.deepEqual(
        manifest.frames.map((item) => item.time),
        [0, 0.5, 1],
      );
      const invalid = await client.callTool({
        name: "frame_start_render",
        arguments: { project: "test-film", start: 1, end: 0 },
      });
      assert.equal(invalid.isError, true);
      const renderStart = await call(client, "frame_start_render", {
        project: "test-film",
        width: 320,
        start: 0,
        end: 0.5,
        fps: 12,
      });
      const video = await waitForJob(client, "test-film", renderStart.id);
      assert.equal(video.status, "succeeded", JSON.stringify(video));
      const report = JSON.parse(
        fs.readFileSync(
          path.join(video.directory, "video.mp4.render.json"),
          "utf8",
        ),
      );
      assert.equal(report.frames, 6);
      assert.ok(
        report.ffprobe.streams.some((stream) => stream.codec_type === "audio"),
      );
      assert.ok(
        report.ffprobe.streams.some(
          (stream) =>
            stream.codec_type === "video" && Number(stream.nb_frames) === 6,
        ),
      );
      const audio = spawnSync(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          path.join(video.directory, "video.mp4"),
          "-f",
          "f32le",
          "-ac",
          "1",
          "-",
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      assert.equal(audio.status, 0, audio.stderr.toString());
      let peak = 0;
      for (let i = 0; i + 4 <= audio.stdout.length; i += 4)
        peak = Math.max(peak, Math.abs(audio.stdout.readFloatLE(i)));
      assert.ok(
        peak > 0.001,
        "Generated audio must contain non-silent samples.",
      );
      const videoResult = await client.callTool({
        name: "frame_read_artifact",
        arguments: { project: "test-film", jobId: video.id, name: "video.mp4" },
      });
      assert.equal(videoResult.content[1].type, "resource_link");
      const traversed = await client.callTool({
        name: "frame_read_artifact",
        arguments: {
          project: "test-film",
          jobId: video.id,
          name: "../project.ts",
        },
      });
      assert.equal(traversed.isError, true);
      fs.appendFileSync(f.file("scene.ts"), "\n// changed externally\n");
      assert.equal(
        (
          await call(client, "frame_job", {
            project: "test-film",
            jobId: frame.id,
          })
        ).sourceChanged,
        true,
      );
      const restarted = await memoryClient(f.root, { readOnly: true });
      try {
        assert.equal(
          (
            await call(restarted.client, "frame_job", {
              project: "test-film",
              jobId: video.id,
            })
          ).status,
          "succeeded",
        );
      } finally {
        await restarted.close();
      }
      assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
    } finally {
      await session.close();
      f.close();
    }
  },
);

test(
  "cancel, timeout and client EOF stop owned jobs and release locks",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    const session = await memoryClient(f.root);
    try {
      const start = await call(session.client, "frame_start_render", {
        project: "test-film",
        width: 3840,
      });
      const observer = await memoryClient(f.root, { readOnly: true });
      try {
        assert.equal(
          (
            await call(observer.client, "frame_job", {
              project: "test-film",
              jobId: start.id,
            })
          ).status,
          "unobserved",
        );
      } finally {
        await observer.close();
      }
      // Wait for a real hidden renderer temporary, instead of cancelling before startup.
      const cancelDeadline = Date.now() + 30000;
      while (
        !fs.readdirSync(start.directory).some((name) => name.startsWith("."))
      ) {
        assert.ok(
          Date.now() < cancelDeadline,
          "Renderer did not reach its audio/video temporary stage.",
        );
        const state = await call(session.client, "frame_job", {
          project: "test-film",
          jobId: start.id,
        });
        assert.equal(state.status, "running", JSON.stringify(state));
        await sleep(25);
      }
      const cancelled = await call(session.client, "frame_cancel_job", {
        project: "test-film",
        jobId: start.id,
      });
      assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
      assert.deepEqual(fs.readdirSync(cancelled.directory), ["job.json"]);
      assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
      const timed = await memoryClient(f.root, { timeoutMs: 100 });
      try {
        const job = await call(timed.client, "frame_start_preview", {
          project: "test-film",
          width: 320,
        });
        assert.equal(
          (await waitForJob(timed.client, "test-film", job.id)).status,
          "timed_out",
        );
        assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
      } finally {
        await timed.close();
      }
      const scene = await call(session.client, "frame_read_file", {
        project: "test-film",
        path: "scene.ts",
      });
      await call(session.client, "frame_edit_files", {
        project: "test-film",
        changes: [
          {
            path: "scene.ts",
            expectedSha256: scene.sha256,
            content: scene.content.replace(
              "render(time) {",
              'render(time) { if (time > 0.1) throw new Error("intentional frame failure");',
            ),
          },
        ],
      });
      const failedStart = await call(session.client, "frame_start_preview", {
        project: "test-film",
        mode: "frame",
        time: 0.5,
        width: 320,
      });
      const failed = await waitForJob(
        session.client,
        "test-film",
        failedStart.id,
      );
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.ok(failed.log.includes("intentional frame failure"), failed.log);
      assert.deepEqual(fs.readdirSync(failed.directory), ["job.json"]);
      const changedScene = await call(session.client, "frame_read_file", {
        project: "test-film",
        path: "scene.ts",
      });
      await call(session.client, "frame_edit_files", {
        project: "test-film",
        changes: [
          {
            path: "scene.ts",
            expectedSha256: changedScene.sha256,
            content: scene.content,
          },
        ],
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(f.root, "scripts/mcp.mjs"), "--project", "test-film"],
        stderr: "pipe",
      });
      const client = new Client({ name: "disconnect-test", version: "1" });
      try {
        await client.connect(transport);
        const job = await call(client, "frame_start_preview", {
          project: "test-film",
          width: 3840,
          times: Array.from({ length: 48 }, (_, index) => index / 24),
        });
        await client.close();
        for (
          let tries = 0;
          tries < 50 && fs.existsSync(f.file(".cache/mcp/operation.lock"));
          tries++
        )
          await sleep(100);
        assert.equal(fs.existsSync(f.file(".cache/mcp/operation.lock")), false);
        const state = JSON.parse(
          fs.readFileSync(
            f.file("exports/mcp/" + job.id + "/job.json"),
            "utf8",
          ),
        );
        assert.equal(state.status, "cancelled", JSON.stringify(state));
      } finally {
        await client.close();
      }
    } finally {
      await session.close();
      f.close();
    }
  },
);
