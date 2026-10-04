import { linkSharedRuntime } from "../../scripts/shared-runtime.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { command } from "../../server/process.mjs";

const enabled = process.env.FRAME_TEST_EXECUTOR === "1";
const driver = process.env.FRAME_EXPORT_DOCKER_DRIVER === "1";
const label = "frame.test.export-workspace";
const docker = (args, options) =>
  process.env.FRAME_TEST_DOCKER_SUDO === "1"
    ? command("sudo", ["-n", "docker", ...args], options)
    : command("docker", args, options);

async function inspect(kind, name) {
  try {
    return JSON.parse(
      await docker([kind, "inspect", "--format", "{{json .}}", name], {
        timeout: 10000,
        max: 512 * 1024,
      }),
    );
  } catch (error) {
    if (/No such (?:object|container|image|network)/i.test(error.message))
      return null;
    throw error;
  }
}
async function until(read, reason, timeout = 120000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await sleep(50);
  } while (Date.now() < deadline);
  throw Error(reason);
}

/** A separate database and owner ledger keep this real-executor gate independent of the release suite. */
async function isolatedDocker(t) {
  assert(process.env.FRAME_EXECUTOR_IMAGE);
  assert(path.isAbsolute(process.env.FRAME_TEST_HOST_ROOT || ""));
  const owner = randomUUID(),
    relative = ".cache/export-workspace-docker-" + owner;
  const directory = path.resolve(relative),
    hostDirectory = path.posix.join(process.env.FRAME_TEST_HOST_ROOT, relative);
  const network = "frame-export-test-" + owner,
    pg = network + "-pg",
    runner = network + "-runner";
  const image = await inspect("image", process.env.FRAME_EXECUTOR_IMAGE);
  assert.match(image?.Id || "", /^sha256:[a-f0-9]{64}$/);
  const postgres = await inspect("image", "postgres:18-alpine");
  assert(
    postgres,
    "The real release gate requires its locally available PostgreSQL image",
  );
  await fs.mkdir(path.resolve(".cache"), { recursive: true });
  assert.equal(
    (await fs.lstat(path.resolve(".cache"))).isSymbolicLink(),
    false,
  );
  assert.equal(
    await fs.realpath(path.resolve(".cache")),
    path.resolve(".cache"),
  );
  await fs.mkdir(directory, { recursive: false, mode: 0o750 });
  await fs.writeFile(
    path.join(directory, "owned.json"),
    JSON.stringify({ owner, tasks: [] }),
  );
  let networkCreated = false;
  const cleanupErrors = [];
  t.after(async () => {
    const clean = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    };
    const stopOwned = async (name) => {
      const value = await inspect("container", name);
      if (!value) return;
      assert.equal(value.Name, "/" + name);
      assert.equal(value.Config.Labels?.[label], owner);
      await docker(["rm", "-f", value.Id], { timeout: 20000 });
    };
    // Stop the owner first, so a timed-out test cannot launch another executor during cleanup.
    await clean(() => stopOwned(runner));
    await clean(async () => {
      const ledger = JSON.parse(
        await fs.readFile(path.join(directory, "owned.json"), "utf8"),
      );
      assert.equal(ledger.owner, owner);
      for (const id of ledger.tasks) {
        assert.match(id, /^[a-f0-9-]{36}$/);
        const value = await inspect("container", "frame-task-" + id);
        if (!value) continue;
        assert.equal(value.Name, "/frame-task-" + id);
        assert.equal(value.Config.Labels?.["frame.task"], id);
        assert(
          value.Mounts.some(
            (m) =>
              m.Destination === "/workspace" &&
              m.Source === hostDirectory + "/runs/" + id,
          ),
        );
        assert(
          value.Mounts.every(
            (m) =>
              !m.RW ||
              (m.Type === "bind" && m.Source.startsWith(hostDirectory + "/")),
          ),
        );
        await docker(["rm", "-f", value.Id], { timeout: 20000 });
      }
    });
    await clean(() => stopOwned(pg));
    if (networkCreated)
      await clean(async () => {
        const value = await inspect("network", network);
        assert.equal(value.Labels?.[label], owner);
        assert.deepEqual(Object.keys(value.Containers || {}), []);
        await docker(["network", "rm", network], { timeout: 10000 });
      });
    if (!cleanupErrors.length)
      await fs.rm(directory, { recursive: true, force: true });
    t.diagnostic(
      JSON.stringify({
        owner,
        resourcesRemoved: !cleanupErrors.length,
        cleanupErrors,
      }),
    );
    assert.deepEqual(
      cleanupErrors,
      [],
      "Owned export gate resources could not be cleaned",
    );
  });
  if ((await fs.stat(directory)).uid !== 1000)
    await docker(
      [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--mount",
        "type=bind,source=" + hostDirectory + ",target=/fixture",
        image.Id,
        "chown",
        "-R",
        "1000:1000",
        "/fixture",
      ],
      { timeout: 30000 },
    );
  await docker(
    [
      "network",
      "create",
      "--internal",
      "--label",
      label + "=" + owner,
      network,
    ],
    { timeout: 10000 },
  );
  networkCreated = true;
  const password = "owned-" + randomUUID();
  await docker(
    [
      "run",
      "--rm",
      "-d",
      "--name",
      pg,
      "--label",
      label + "=" + owner,
      "--network",
      network,
      "--network-alias",
      "owned-postgres",
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "-e",
      "POSTGRES_PASSWORD=" + password,
      "-e",
      "POSTGRES_DB=frame_test_export_workspace",
      postgres.Id,
    ],
    { timeout: 30000 },
  );
  await until(
    () =>
      docker(
        [
          "exec",
          pg,
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "frame_test_export_workspace",
        ],
        { timeout: 5000 },
      )
        .then(() => true)
        .catch(() => false),
    "Owned export PostgreSQL did not become ready",
    30000,
  );
  const socket = await fs.stat("/var/run/docker.sock");
  assert(socket.isSocket());
  const output = await docker(
    [
      "run",
      "--rm",
      "--init",
      "--entrypoint",
      "node",
      "--name",
      runner,
      "--label",
      label + "=" + owner,
      "--network",
      network,
      "--user",
      "1000:1000",
      "--group-add",
      String(socket.gid),
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m,mode=1777",
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "--mount",
      "type=bind,source=" + hostDirectory + ",target=/data",
      "--mount",
      "type=bind,source=" +
        path.posix.join(
          process.env.FRAME_TEST_HOST_ROOT,
          "tests/server/export-workspace-docker.test.mjs",
        ) +
        ",target=/opt/frame/tests/server/export-workspace-docker.test.mjs,readonly",
      "-e",
      "HOME=/tmp/export-gate-home",
      "-e",
      "FRAME_ROLE=verification",
      "-e",
      "FRAME_DATA=/data",
      "-e",
      "FRAME_HOST_DATA=" + hostDirectory,
      "-e",
      "FRAME_TEST_EXECUTOR=1",
      "-e",
      "FRAME_EXPORT_DOCKER_DRIVER=1",
      "-e",
      "FRAME_EXPORT_TEST_OWNER=" + owner,
      "-e",
      "FRAME_TEST_DATABASE_URL=postgresql://postgres:" +
        password +
        "@owned-postgres:5432/frame_test_export_workspace",
      "-e",
      "FRAME_EXECUTOR_IMAGE=" + image.Id,
      image.Id,
      "--test",
      "--test-concurrency=1",
      "tests/server/export-workspace-docker.test.mjs",
    ],
    { timeout: 480000, max: 2 * 1024 * 1024, combined: true },
  );
  const report = JSON.parse(
    await fs.readFile(path.join(directory, "report.json"), "utf8"),
  );
  assert.equal(report.passed, true, output.slice(-6000));
  assert.equal(report.runtimeImage, image.Id);
  assert.deepEqual(
    report.scenarios.map((item) => item.mutationPhase),
    ["queued", "encoding"],
  );
  assert.equal(report.validationCacheCheckpoint.passed, true);
  assert.equal(report.validationCacheCheckpoint.headUnchanged, true);
  assert.equal(report.validationCacheCheckpoint.indexUnchanged, true);
  assert.equal(report.validationCacheCheckpoint.validationState, "passed");
  assert.equal(report.validationCacheCheckpoint.workspaceCleaned, true);
  t.diagnostic(JSON.stringify(report));
}

const scene = (
  project,
  epoch,
) => `import {assetUrl,type Scene,type SceneOptions} from '../../src/engine/types';
export async function createScene({width,height}:SceneOptions):Promise<Scene>{
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const context=canvas.getContext('2d')!;const image=new Image();
 image.src=assetUrl('films/${project}/swatch.svg');await image.decode();
 return {canvas,render(){context.fillStyle='${epoch === "A" ? "#dc1414" : "#1420dc"}';context.fillRect(0,0,width,height);
 context.drawImage(image,width/2,0,width/2,height)},dispose(){canvas.width=1;canvas.height=1}};
}`;
const swatch = (epoch) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="${epoch === "A" ? "#e02020" : "#2030e0"}" d="M0 0h64v64H0z"/></svg>`;

async function validationCacheExport(t, platform, cli, repo, data, remember) {
  const [
    { treeHash },
    { runtimeIdentity },
    { validateAiWorkspace, probeAiRuntime, createWorkspaceProbeSession },
    { probeMedia },
  ] = await Promise.all([
    import("../../server/project-files.mjs"),
    import("../../scripts/runtime-identity.mjs"),
    import("../../server/ai-validate.mjs"),
    import("../../scripts/production-media.mjs"),
  ]);
  let proof;
  await t.test(
    "legacy imported work without gitignore freezes a real export during actual Vite/audio validation without committing generated caches",
    async () => {
      const work = await cli.call("works_create", {
        repo: repo.id,
        title: "Legacy cache-only freeze",
        renderer: "canvas",
        duration: 2,
        fps: 12,
        composition: { width: 320, height: 180 },
      });
      const { dir: source, repo: checkout } = await platform.repos.project(
        repo.id,
        work.project,
      );
      const runtime = await runtimeIdentity(),
        core = path.resolve(".");
      // Prepare the same readonly shared runtime used by a canonical native workspace.
      await platform.ai.work.prepare(work.id);
      linkSharedRuntime(checkout.root, core);
      const git = (args) => platform.repos.git(checkout.root, args);
      await fs.writeFile(
        path.join(source, "scene.ts"),
        scene(work.project, "A"),
      );
      await fs.writeFile(
        path.join(source, "public", "swatch.svg"),
        swatch("A"),
      );
      for (const file of [
        path.join(checkout.root, ".gitignore"),
        path.join(source, ".gitignore"),
      ])
        await fs.rm(file, { force: true });
      // Imported repositories can lack both .gitignore and generated-path info/exclude entries.
      // Keep the independently required readonly runtime exclusions installed above.
      const excludes = path.resolve(
        checkout.root,
        (await git(["rev-parse", "--git-path", "info/exclude"])).trim(),
      );
      await fs.writeFile(
        excludes,
        (await fs.readFile(excludes, "utf8"))
          .split(/\r?\n/)
          .filter(
            (line) =>
              !/^projects\/\*\/(?:\.cache|\.history|exports)\/$/.test(line),
          )
          .join("\n"),
      );
      const head = await platform.repos.checkpoint(
        repo.id,
        work.project,
        "Legacy source baseline",
      );
      const index = await git(["ls-files", "--stage", "-z"]);
      const revision = await treeHash(source, { includeExecutableMode: true });
      const cache = path.join(source, ".cache", "validation"),
        marker = path.join(cache, "export-admission.json");
      await fs.mkdir(cache, { recursive: true });
      assert.equal(
        await git([
          "check-ignore",
          "--",
          `projects/${work.project}/.cache/validation/export-admission.json`,
        ]).then(
          () => true,
          () => false,
        ),
        false,
      );
      const previous = {
        root: process.env.FRAME_SHARED_RUNTIME_ROOT,
        fingerprint: process.env.FRAME_SHARED_RUNTIME_FINGERPRINT,
      };
      process.env.FRAME_SHARED_RUNTIME_ROOT = core;
      process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = runtime.fingerprint;
      let release,
        held,
        writes = 0,
        stop = false,
        accepted,
        validation;
      const released = new Promise((resolve) => {
          release = resolve;
        }),
        holding = new Promise((resolve) => {
          held = resolve;
        });
      const write = () =>
        fs.writeFile(
          marker,
          JSON.stringify({
            reportId: "owned-export-admission",
            pid: process.pid,
            generation: ++writes,
          }),
        );
      await write();
      const writer = (async () => {
        while (!stop) {
          await write();
          await sleep(1);
        }
      })();
      try {
        // The real validator runs scope, structure, project tests/types, browser frames and audio.
        // Hold its real Vite/browser cleanup so admission deterministically overlaps generated deps.
        validation = validateAiWorkspace({
          core,
          work: checkout.root,
          project: work.project,
          baselineCommit: head,
          modeFingerprint: revision,
          runtimeFingerprint: runtime.fingerprint,
          runtimeProbe: (options) =>
            probeAiRuntime({
              ...options,
              sessionFactory: async (settings) => {
                const session = await createWorkspaceProbeSession(settings);
                return {
                  ...session,
                  async close() {
                    held();
                    try {
                      await released;
                    } finally {
                      await session.close();
                    }
                  },
                };
              },
            }),
        }).then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
        const ready = await Promise.race([
          holding.then(() => ({ held: true })),
          validation,
        ]);
        assert.equal(ready.held, true, JSON.stringify(ready));
        const vite = path.join(cache, "vite-" + process.pid);
        const generated = await fs.readdir(vite, { recursive: true });
        assert.ok(
          generated.some((file) => /(?:^|\/)package\.json$/.test(file)),
          "Actual Vite dependency JSON exists during validation",
        );
        const before = writes;
        accepted = await cli.call("works_task", {
          id: work.id,
          kind: "render",
          requestKey: randomUUID(),
          input: { width: 320, fps: 12, start: 0, end: 0.25, subtitles: false },
        });
        await remember(accepted);
        assert.ok(
          writes > before,
          "Generated validation JSON writes overlap HTTP export admission",
        );
        assert.equal(accepted.frozen.sourceRevision, revision);
        assert.equal(
          accepted.frozen.sourceCommit,
          head,
          "No cache-only export checkpoint commit",
        );
        assert.equal((await git(["rev-parse", "HEAD"])).trim(), head);
        assert.equal(
          await git(["ls-files", "--stage", "-z"]),
          index,
          "Export leaves the logical Git index intact",
        );
        assert.equal(await git(["diff", "--cached", "--name-only"]), "");
        const tracked = (await git(["ls-files", "-z"])).split("\0");
        assert.ok(
          !tracked.some((file) => file.split("/").includes(".cache")),
          "No validation marker, dependency metadata or generated JS is tracked",
        );
        const snapshot = path.join(
          data,
          "runs",
          accepted.id,
          "projects",
          work.project,
        );
        await assert.rejects(fs.stat(path.join(snapshot, ".cache")), {
          code: "ENOENT",
        });
        release();
        const checked = await validation;
        if (checked.error) throw checked.error;
        assert.equal(
          checked.result.status,
          "passed",
          JSON.stringify(checked.result),
        );
        assert.deepEqual(
          checked.result.validation.map((check) => check.name),
          ["scope", "structure", "project-tests", "project-types", "runtime"],
        );
        assert.equal(checked.result.modeFingerprint, revision);
        assert.equal(checked.result.runtimeFingerprint, runtime.fingerprint);
        assert.equal(checked.result.stale, false);
        await platform.tasks.start(await platform.tasks.get(accepted.id));
        const finished = await until(
          async () => {
            await platform.tasks.tick();
            const row = await platform.tasks.get(accepted.id);
            if (["failed", "cancelled", "publish_failed"].includes(row.state))
              throw Error(row.error || row.state);
            return row.state === "succeeded" && row.workspace_cleaned
              ? row
              : null;
          },
          "Legacy cache-safe frozen MP4 failed or left its workspace",
          120000,
        );
        const artifact = finished.result.artifacts.find((file) =>
          file.path.endsWith(".mp4"),
        );
        assert.ok(artifact?.bytes > 0);
        const output = path.join(data, "cache-safe.mp4"),
          download = await cli.download(accepted.id, artifact.path, output);
        assert.equal(download.checksumVerified, true);
        const video = (await probeMedia(output)).streams.find(
          (item) => item.codec_type === "video",
        );
        assert.equal(video.width, 320);
        assert.equal(Number(video.nb_read_frames), 3);
        assert.equal(finished.result.sourceRevision, revision);
        assert.equal(
          await treeHash(source, { includeExecutableMode: true }),
          revision,
        );
        assert.equal((await git(["rev-parse", "HEAD"])).trim(), head);
        assert.equal(await git(["ls-files", "--stage", "-z"]), index);
        assert.equal(
          await inspect("container", "frame-task-" + accepted.id),
          null,
        );
        assert.deepEqual(await fs.readdir(snapshot), ["exports"]);
        proof = {
          passed: true,
          work: work.id,
          task: accepted.id,
          sourceRevision: revision,
          head,
          headUnchanged: true,
          indexUnchanged: true,
          validationState: checked.result.status,
          actualViteFiles: generated.length,
          overlappingCacheWrites: writes - before,
          bytes: download.bytes,
          checksumVerified: true,
          frames: Number(video.nb_read_frames),
          workspaceCleaned: true,
        };
        await fs.rm(output);
      } finally {
        release();
        stop = true;
        await writer;
        if (validation) await validation;
        await fs.rm(marker, { force: true });
        for (const [key, value] of Object.entries({
          FRAME_SHARED_RUNTIME_ROOT: previous.root,
          FRAME_SHARED_RUNTIME_FINGERPRINT: previous.fingerprint,
        }))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    },
  );
  assert.ok(proof);
  return proof;
}

async function realExport(t) {
  const [
    { database },
    { createApp },
    { PlatformClient },
    { treeHash },
    { probeMedia },
  ] = await Promise.all([
    import("../../server/db.mjs"),
    import("../../server/app.mjs"),
    import("../../scripts/platform/client.mjs"),
    import("../../server/project-files.mjs"),
    import("../../scripts/production-media.mjs"),
  ]);
  const db = await database(
    process.env.FRAME_TEST_DATABASE_URL,
    "owned-export-gate-password-2026",
  );
  const data = process.env.FRAME_DATA,
    owner = process.env.FRAME_EXPORT_TEST_OWNER;
  assert.equal(data, "/data");
  assert.match(owner, /^[a-f0-9-]{36}$/);
  const platform = await createApp({
    db,
    data,
    masterKey: "74".repeat(32),
    scheduler: false,
  });
  const taskIds = [],
    scenarios = [];
  const remember = async (task) => {
    taskIds.push(task.id);
    const file = path.join(data, "owned.json"),
      temp = file + ".tmp";
    await fs.writeFile(temp, JSON.stringify({ owner, tasks: taskIds }));
    await fs.rename(temp, file);
  };
  try {
    await platform.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${platform.app.server.address().port}`;
    const repo = await platform.actions.call("repositories_add", {
      name: "Frozen MP4 isolation gate",
    });
    const token = await platform.actions.call("tokens_create", {
      name: "export-isolation-gate",
    });
    const cli = new PlatformClient({
      url: base,
      token: token.token,
      timeoutMs: 30000,
    });
    const unrelated = await cli.call("works_create", {
      repo: repo.id,
      title: "Other work remains intact",
      renderer: "canvas",
      duration: 2,
    });
    const unrelatedSource = (
      await platform.repos.project(repo.id, unrelated.project)
    ).dir;
    const otherBefore = await treeHash(unrelatedSource, {
      includeExecutableMode: true,
    });
    const otherHeadBefore = await command("git", ["rev-parse", "HEAD"], {
      cwd: path.dirname(path.dirname(unrelatedSource)),
    });
    for (const mutationPhase of ["queued", "encoding"])
      await t.test(
        mutationPhase +
          " edits preserve real frozen MP4 A and immediately clean its executor",
        async () => {
          const work = await cli.call("works_create", {
            repo: repo.id,
            title: "Real freeze A / edit B " + mutationPhase,
            renderer: "canvas",
            duration: 12,
            fps: 30,
            composition: { width: 320, height: 180 },
          });
          const source = (await platform.repos.project(repo.id, work.project))
            .dir;
          const install = async (epoch) => {
            const previous = await cli.call("works_read_lines", {
              id: work.id,
              path: "scene.ts",
              lineCount: 1,
            });
            const edited = await cli.call("works_edit", {
              id: work.id,
              changes: [
                {
                  path: "scene.ts",
                  expectedSha256: previous.sha256,
                  content: scene(work.project, epoch),
                },
              ],
            });
            assert(
              edited.applied && edited.validation.passed,
              JSON.stringify(edited),
            );
            await db.lock(`${repo.id}:${work.project}`, () =>
              fs.writeFile(
                path.join(source, "public", "swatch.svg"),
                swatch(epoch),
              ),
            );
            return treeHash(source, { includeExecutableMode: true });
          };
          const revisionA = await install("A");
          const input = {
            width: 320,
            fps: 30,
            start: 0,
            end: mutationPhase === "encoding" ? 12 : 1,
            subtitles: false,
          };
          const accepted = await cli.call("works_task", {
            id: work.id,
            kind: "render",
            requestKey: randomUUID(),
            input,
          });
          await remember(accepted);
          const saved = await platform.tasks.get(accepted.id);
          assert.equal(saved.state, "queued");
          assert.equal(saved.frozen.sourceRevision, revisionA);
          assert.equal(saved.frozen.image, process.env.FRAME_EXECUTOR_IMAGE);
          assert.deepEqual(saved.frozen.input, input);
          const run = path.join(data, "runs", accepted.id),
            snapshot = path.join(run, "projects", work.project);
          assert.equal(
            await fs.readFile(
              path.join(snapshot, "public", "swatch.svg"),
              "utf8",
            ),
            swatch("A"),
          );
          let revisionB, encodingProof;
          if (mutationPhase === "queued") {
            revisionB = await install("B");
            assert.equal(
              (await platform.tasks.get(accepted.id)).state,
              "queued",
            );
            assert.equal(
              await treeHash(snapshot, { includeExecutableMode: true }),
              revisionA,
            );
            await platform.tasks.start(saved);
          } else {
            await platform.tasks.start(saved);
            const container = "frame-task-" + accepted.id;
            encodingProof = await until(
              async () => {
                const value = await inspect("container", container);
                assert(
                  value?.State.Running,
                  "Executor exited before the real encoding phase was observed",
                );
                const processes = await docker(
                  ["top", container, "-eo", "pid,args"],
                  { timeout: 10000, max: 512 * 1024 },
                );
                return processes
                  .split("\n")
                  .find(
                    (line) =>
                      /ffmpeg/.test(line) &&
                      /(?:libx264|image2pipe|rawvideo)/.test(line),
                  );
              },
              "No real ffmpeg frame encoder was observed",
              120000,
            );
            revisionB = await install("B");
            const current = await inspect("container", container);
            assert(
              current.State.Running,
              "Canonical edit must finish while the frozen executor is still running",
            );
            assert.equal(
              await treeHash(snapshot, { includeExecutableMode: true }),
              revisionA,
            );
          }
          assert.notEqual(revisionB, revisionA);
          assert.equal(
            await fs.readFile(
              path.join(snapshot, "public", "swatch.svg"),
              "utf8",
            ),
            swatch("A"),
          );
          const finished = await until(
            async () => {
              await platform.tasks.tick();
              const task = await platform.tasks.get(accepted.id);
              if (
                ["failed", "cancelled", "publish_failed"].includes(task.state)
              )
                throw Error(task.error || task.state);
              return task.state === "succeeded" && task.workspace_cleaned
                ? task
                : null;
            },
            "Real frozen MP4 did not complete and clean its workspace",
            180000,
          );
          const artifact = finished.result.artifacts.find((item) =>
            item.path.endsWith(".mp4"),
          );
          assert(artifact?.bytes > 0);
          assert.equal(finished.result.sourceRevision, revisionA);
          assert.equal(
            finished.result.runtime.image,
            process.env.FRAME_EXECUTOR_IMAGE,
          );
          assert.deepEqual(finished.result.exportParameters, input);
          const output = path.join(data, mutationPhase + ".mp4");
          const download = await cli.download(
            accepted.id,
            artifact.path,
            output,
          );
          assert.equal(download.bytes, artifact.bytes);
          assert.equal(download.checksumVerified, true);
          const probe = await probeMedia(output),
            video = probe.streams.find((item) => item.codec_type === "video");
          assert.equal(video.width, 320);
          assert.equal(video.height, 180);
          assert.equal(Number(video.nb_read_frames), input.end * input.fps);
          const raw = path.join(data, mutationPhase + ".rgb");
          await command("ffmpeg", [
            "-v",
            "error",
            "-ss",
            "0.25",
            "-i",
            output,
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-y",
            raw,
          ]);
          const pixels = await fs.readFile(raw);
          const samples = [80, 240].map((x) => [
            ...pixels.subarray((90 * 320 + x) * 3, (90 * 320 + x) * 3 + 3),
          ]);
          for (const [r, g, b] of samples)
            assert(
              r > 180 && g < 65 && b < 65,
              "Decoded source and original SVG must both show frozen red A: " +
                JSON.stringify(samples),
            );
          assert.equal(
            await treeHash(source, { includeExecutableMode: true }),
            revisionB,
            "Export must not write back to canonical B",
          );
          assert.match(
            await fs.readFile(path.join(source, "scene.ts"), "utf8"),
            /#1420dc/,
          );
          assert.equal(
            await fs.readFile(
              path.join(source, "public", "swatch.svg"),
              "utf8",
            ),
            swatch("B"),
          );
          assert.equal(
            await inspect("container", "frame-task-" + accepted.id),
            null,
          );
          assert.deepEqual(await fs.readdir(snapshot), ["exports"]);
          await assert.rejects(fs.stat(path.join(run, ".cache")), {
            code: "ENOENT",
          });
          assert(
            (await fs.readdir(run)).every((name) =>
              [
                "projects",
                "task.json",
                "result.json",
                "progress.json",
                "workspace.json",
                "exit.json",
              ].includes(name),
            ),
          );
          assert.equal(
            await treeHash(unrelatedSource, { includeExecutableMode: true }),
            otherBefore,
          );
          assert.equal(
            await command("git", ["rev-parse", "HEAD"], {
              cwd: path.dirname(path.dirname(unrelatedSource)),
            }),
            otherHeadBefore,
          );
          scenarios.push({
            mutationPhase,
            task: accepted.id,
            work: work.id,
            sourceRevisionA: revisionA,
            sourceRevisionB: revisionB,
            frozenCommit: finished.source_commit,
            bytes: download.bytes,
            sha256: download.sha256,
            checksumVerified: true,
            frames: Number(video.nb_read_frames),
            decodedSourceAndOriginalMedia: samples,
            actualEncoderObserved: !!encodingProof,
            workspaceCleaned: true,
            containerRemoved: true,
            otherWorkUnchanged: true,
          });
          await fs.rm(raw);
          await fs.rm(output);
        },
      );
    assert.equal(scenarios.length, 2);
    const validationCacheCheckpoint = await validationCacheExport(
      t,
      platform,
      cli,
      repo,
      data,
      remember,
    );
    await fs.writeFile(
      path.join(data, "report.json"),
      JSON.stringify(
        {
          passed: true,
          owner,
          source:
            "actual isolated PostgreSQL + HTTP CLI admission/edit/download + immutable Docker executor + decoded MP4",
          runtimeImage: process.env.FRAME_EXECUTOR_IMAGE,
          scenarios,
          validationCacheCheckpoint,
        },
        null,
        2,
      ),
    );
  } finally {
    await platform.app.close();
    // The outer owner checks exact task labels and mounts before any emergency cleanup.
  }
}

test(
  "real frozen export: A → editable B while queued/encoding → decoded downloadable MP4 A → owned workspace/container cleanup",
  {
    skip: !enabled,
    timeout: 540000,
  },
  async (t) => (driver ? realExport(t) : isolatedDocker(t)),
);
