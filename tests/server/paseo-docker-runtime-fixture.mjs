import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { command } from "../../server/process.mjs";

const here = fileURLToPath(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownLabel = "frame.test.paseo-docker";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function inspect(kind, name) {
  return JSON.parse(
    await command("docker", [kind, "inspect", "--format", "{{json .}}", name], {
      timeout: 10000,
      max: 512 * 1024,
    }),
  );
}
async function optionalInspect(kind, name) {
  try {
    return await inspect(kind, name);
  } catch (error) {
    if (/No such (?:object|container|image|network)/i.test(error.message))
      return null;
    throw error;
  }
}
async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await sleep(100);
  } while (Date.now() < deadline);
  throw Error(message);
}
async function json(file, value) {
  const temp = file + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

/** Every bind is under this newly-created path; no production data or inherited credentials are used. */
export async function dockerRuntimeFixture(t) {
  assert.equal(process.env.FRAME_TEST_EXECUTOR, "1");
  assert(process.env.FRAME_EXECUTOR_IMAGE);
  assert(path.isAbsolute(process.env.FRAME_TEST_HOST_ROOT || ""));
  assert.match(
    new URL(process.env.FRAME_TEST_DATABASE_URL).pathname,
    /^\/frame_test/,
  );
  const owner = randomUUID(),
    relative = ".cache/paseo-docker-runtime-" + owner;
  const directory = path.resolve(relative),
    hostDirectory = path.posix.join(process.env.FRAME_TEST_HOST_ROOT, relative);
  assert.equal(path.dirname(directory), path.resolve(".cache"));
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
  const network = "frame-paseo-test-" + owner;
  const pg = network + "-pg",
    controller = network + "-controller";
  const names = new Set([pg, controller]);
  const artifacts = path.resolve(".cache/paseo-docker-runtime-reports", owner);
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const reportFile = path.join(directory, "report.json");
  const ledgerFile = path.join(directory, "owned.json");
  const cleanupErrors = [],
    cleanupActions = [];
  let networkCreated = false,
    report;
  const stop = async (name) => {
    const container = await optionalInspect("container", name);
    if (!container) return;
    const ordinary =
      names.has(name) && container.Config.Labels?.[ownLabel] === owner;
    const ledger = await fs
      .readFile(ledgerFile, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return { works: [] };
      });
    const id = name.startsWith("frame-paseo-")
      ? name.slice("frame-paseo-".length)
      : "";
    const native =
      uuid.test(id) &&
      ledger.owner === owner &&
      ledger.works?.includes(id) &&
      container.Name === "/" + name &&
      container.Config.Labels?.["frame.paseo.work"] === id &&
      container.Mounts.some(
        (mount) =>
          mount.Destination === "/workspace" &&
          mount.Type === "bind" && mount.RW === true &&
          mount.Source === hostDirectory + "/works/" + id,
      ) && container.Mounts.every(mount => !mount.RW ||
        mount.Type === "bind" && mount.Source.startsWith(hostDirectory + "/"));
    assert(
      ordinary || native,
      "Refusing to remove a container without this fixture's exact identity",
    );
    if (container.State.Running)
      await command("docker", ["stop", "--time", "10", container.Id], {
        timeout: 25000,
      });
    const stopped = await inspect("container", container.Id);
    assert.equal(stopped.Id, container.Id);
    assert.equal(stopped.State.Running, false);
    await command("docker", ["rm", container.Id], { timeout: 10000 });
    assert.equal(await optionalInspect("container", name), null);
    cleanupActions.push(name);
  };
  t.after(async () => {
    const tryCleanup = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    };
    // Stop the sole owner before cleaning a failed startup, so it cannot create a new daemon during cleanup.
    await tryCleanup(() => stop(controller));
    const ledger = await fs
      .readFile(ledgerFile, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (ledger?.owner === owner && Array.isArray(ledger.works)) {
      for (const id of ledger.works) {
        if (!uuid.test(id)) {
          cleanupErrors.push("Invalid owned work identity");
          continue;
        }
        await tryCleanup(() => stop("frame-paseo-" + id));
      }
    }
    await tryCleanup(() => stop(pg));
    if (networkCreated)
      await tryCleanup(async () => {
        const value = await inspect("network", network);
        assert.equal(value.Labels?.[ownLabel], owner);
        assert.deepEqual(Object.keys(value.Containers || {}), []);
        await command("docker", ["network", "rm", network], { timeout: 10000 });
      });
    await json(path.join(artifacts, "cleanup.json"), {
      owner,
      removedContainers: cleanupActions,
      networkRemoved: networkCreated && !cleanupErrors.length,
      errors: cleanupErrors,
    });
    if (!cleanupErrors.length) await fs.rm(directory, { recursive: true });
    t.diagnostic(
      JSON.stringify({
        owner,
        cleanup: {
          removedContainers: cleanupActions,
          networkRemoved: networkCreated && !cleanupErrors.length,
          errors: cleanupErrors,
        },
      }),
    );
    assert.deepEqual(
      cleanupErrors,
      [],
      "Owned Docker fixture cleanup failed; private diagnostics were retained",
    );
  });
  const image = await inspect("image", process.env.FRAME_EXECUTOR_IMAGE);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  const postgres = await inspect("image", "postgres:18-alpine");
  const socket = await fs.stat("/var/run/docker.sock");
  assert(
    socket.isSocket(),
    "The isolated release runner must have the real Docker socket",
  );
  await command("chown", ["1000:1000", directory], { timeout: 10000 });
  await command(
    "docker",
    [
      "network",
      "create",
      "--internal",
      "--label",
      ownLabel + "=" + owner,
      network,
    ],
    { timeout: 10000 },
  );
  networkCreated = true;
  const password = "owned-" + randomUUID();
  await command(
    "docker",
    [
      "run",
      "-d",
      "--name",
      pg,
      "--label",
      ownLabel + "=" + owner,
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
      "POSTGRES_DB=frame_test_paseo_docker",
      postgres.Id,
    ],
    { timeout: 30000 },
  );
  await until(async () => {
    const result = await command(
      "docker",
      [
        "exec",
        pg,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "frame_test_paseo_docker",
      ],
      { timeout: 5000 },
    )
      .then(() => true)
      .catch(() => false);
    if (!result) {
      const current = await inspect("container", pg);
      assert(current.State.Running, "Owned PostgreSQL exited before readiness");
    }
    return result;
  }, "Owned PostgreSQL did not become ready");
  await command(
    "docker",
    [
      "run",
      "-d",
      "--init",
      "--name",
      controller,
      "--label",
      ownLabel + "=" + owner,
      "--network",
      network,
      "--network-alias",
      "studio",
      "--user",
      "1000:1000",
      "--group-add",
      String(socket.gid),
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "1024",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m",
      // Standalone verification may update only this test driver against an existing candidate.
      // Release verification uses the driver's copy already included in the rebuilt image.
      ...(process.env.FRAME_TEST_RUNTIME_FIXTURE === "1" ? ["--mount",
        "type=bind,source=" + path.posix.join(process.env.FRAME_TEST_HOST_ROOT,
          "tests/server/paseo-docker-runtime-fixture.mjs") +
        ",target=/opt/frame/tests/server/paseo-docker-runtime-fixture.mjs,readonly"] : []),
      "--mount",
      "type=bind,source=" + hostDirectory + ",target=/data",
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "-e",
      "FRAME_ROLE=api",
      "-e",
      "FRAME_DATA=/data",
      "-e",
      "FRAME_HOST_DATA=" + hostDirectory,
      "-e",
      "FRAME_EXECUTOR_IMAGE=" + image.Id,
      "-e",
      "FRAME_DOCKER_FIXTURE_OWNER=" + owner,
      "-e",
      "DATABASE_URL=postgres://postgres:" +
        password +
        "@owned-postgres:5432/frame_test_paseo_docker",
      "-e",
      "FRAME_MASTER_KEY=" + "a7".repeat(32),
      "-e",
      "FRAME_ADMIN_PASSWORD=owned-docker-runtime-password",
      "--entrypoint",
      "node",
      image.Id,
      "/opt/frame/tests/server/paseo-docker-runtime-fixture.mjs",
      "--worker",
    ],
    { timeout: 30000, max: 256 * 1024 },
  );
  let exit;
  try {
    exit = (
      await command("docker", ["wait", controller], {
        timeout: 240000,
        max: 1024,
      })
    ).trim();
  } finally {
    const logs = await command("docker", ["logs", controller], {
      timeout: 10000,
      max: 2 * 1024 * 1024,
      combined: true,
    });
    await fs.writeFile(path.join(artifacts, "controller.log"), logs, {
      mode: 0o600,
    });
    t.diagnostic(logs.slice(-12000));
  }
  report = await fs
    .readFile(reportFile, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return {
        status: "failed",
        error:
          "Owned worker exited before its report; see the retained controller log",
      };
    });
  await json(path.join(artifacts, "report.json"), report);
  t.diagnostic(
    "Owned Docker runtime proof: " + path.relative(process.cwd(), artifacts),
  );
  assert.equal(exit, "0", report.error || "Owned Docker controller failed");
  assert.equal(report.status, "passed", report.error);
  assert.equal(report.imageId, image.Id);
  assert.equal(report.testDriverHash, hash(await fs.readFile(here)));
  assert.equal(
    report.sourceRevision,
    image.Config.Labels["org.opencontainers.image.revision"],
  );
  return report;
}

async function worker() {
  const owner = process.env.FRAME_DOCKER_FIXTURE_OWNER;
  assert.match(owner, uuid);
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  for (const name of [
    "FRAME_AGENT_URL",
    "FRAME_PUBLIC_URL",
    "FRAME_PASEO_NETWORK",
    "FRAME_LOCAL_MODE",
  ])
    assert.equal(
      process.env[name],
      undefined,
      name + " must not mask production defaults",
    );
  const { createApp } = await import("../../server/app.mjs");
  const { ControllerLease } = await import("../../server/controller-lease.mjs");
  const { runtimeIdentity } =
    await import("../../scripts/runtime-identity.mjs");
  const { default: WebSocket } = await import("ws");
  const { DaemonClient } = await import(
    path.join(
      process.env.FRAME_PASEO_ROOT,
      "node_modules/@getpaseo/client/dist/daemon-client.js",
    )
  );
  const data = "/data",
    ledger = { owner, works: [] },
    report = { owner, status: "failed", checks: [] };
  let services, manager, gatewayClient, ticking, speechModels;
  try {
    services = await createApp({ data, scheduler: false, localMode: false });
    manager = services.paseo.manager;
    assert.equal(manager.localMode, false);
    const start = manager.start.bind(manager);
    manager.start = async (...args) => {
      try { return await start(...args); }
      catch (error) {
        const binding = await services.paseo.store.getWork(args[0]);
        (report.startFailures ||= []).push({ work: args[0], state: binding?.state,
          generation: binding?.daemonGeneration, error: error.message, stack: error.stack });
        throw error;
      }
    };
    manager.startTimeoutMs = 20000;
    services.tasks.lease = new ControllerLease(services.db.pool);
    assert.equal(await services.tasks.lease.acquire(), true);
    const { holdSharedSpeechPreparation } =
      await import("./paseo-speech-model-fixture.mjs");
    speechModels = await holdSharedSpeechPreparation(manager);
    const call = (name, args = {}) => services.actions.call(name, args);
    const repo = await call("repositories_add", {
      name: "Owned Docker runtime",
    });
    const works = [];
    for (let i = 0; i < 6; i++) {
      const work = await call("works_create", {
        repo: repo.id,
        title: "Owned Docker work " + i,
        renderer: "canvas",
        duration: 2,
        fps: 12,
        audio: "silent",
      });
      works.push(work);
      ledger.works.push(work.id);
      await json("/data/owned.json", ledger);
    }
    const ownKey = "owned-selected-" + randomUUID(),
      otherKey = "owned-other-" + randomUUID();
    const save = (name, key) =>
      call("connections_save", {
        name,
        tool: "codex",
        mode: "api",
        apiKey: key,
        baseUrl: "http://owned-fake-provider.invalid/v1",
        model: "owned-model",
        models: [{ id: "owned-model", name: "Owned model", enabled: true }],
      });
    const selected = await save("Selected fixture profile", ownKey);
    await save("Unselected fixture profile", otherKey);
    await services.app.listen({ host: "0.0.0.0", port: 3000 });
    for (const work of works) {
      await services.paseo.work.prepare(work.id);
      await services.paseo.store.requestWork(work.id);
    }
    const pending = [],
      tickErrors = [];
    const begin = Date.now();
    await manager.tick();
    assert(
      Date.now() - begin < 5000,
      "Controller tick must enqueue rather than wait through six readiness timeouts",
    );
    let maximumStarting = manager.starting.size;
    assert(
      maximumStarting <= 2,
      "The controller must bound simultaneous native startup",
    );
    ticking = setInterval(() => {
      const operation = manager.tick().catch((error) => {
        tickErrors.push(error.message);
      });
      pending.push(operation);
      maximumStarting = Math.max(maximumStarting, manager.starting.size);
    }, 250);
    ticking.unref();
    await until(
      async () => {
        assert.deepEqual(tickErrors, []);
        const rows = await Promise.all(
          works.map((work) => services.paseo.store.getWork(work.id)),
        );
        const failed = rows.find((row) => row.state === "failed");
        if (failed)
          throw Error("Actual Docker native startup failed: " + failed.error);
        maximumStarting = Math.max(maximumStarting, manager.starting.size);
        assert(maximumStarting <= 2);
        return rows.every(
          (row) => row.state === "ready" && row.serverId && row.workspaceId,
        );
      },
      "Six isolated native Docker daemons did not become ready",
      90000,
    );
    clearInterval(ticking);
    ticking = null;
    await Promise.all(pending);
    assert.deepEqual(tickErrors, []);
    assert.deepEqual(report.startFailures || [], []);
    // Bound this proof's checks to the primary work while retaining all six ready daemons.
    for (const work of works) await services.paseo.workspace.stop(work.id);
    const primary = works[0],
      ready = await manager.ensure(primary);
    const binding = await services.paseo.store.getWork(primary.id);
    const { capability } = await manager.control(primary.id);
    assert.equal(
      binding.endpoint,
      "http://frame-paseo-" + primary.id + ":6767",
    );
    assert.equal((await fetch(binding.endpoint + "/api/health")).status, 200);
    for (const credential of [null, "owned-invalid-capability"]) {
      const response = await fetch(binding.endpoint + "/api/status", {
        headers: credential ? { authorization: "Bearer " + credential } : {},
      });
      assert.equal(response.status, 401);
      await response.body?.cancel();
    }
    const status = await fetch(binding.endpoint + "/api/status", {
      headers: { authorization: "Bearer " + capability },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).serverId, ready.serverId);
    report.checks.push(
      "six Docker hostnames become ready without URL/network overrides; non-free native API stays authenticated",
    );
    const controller = await inspect("container", process.env.HOSTNAME);
    const network = Object.keys(controller.NetworkSettings.Networks);
    assert.equal(network.length, 1);
    assert.equal(controller.Config.User, "1000:1000");
    assert.deepEqual(controller.HostConfig.PortBindings || {}, {});
    const containers = [];
    for (const work of works) {
      const native = await inspect("container", "frame-paseo-" + work.id);
      assert.equal(native.Image, process.env.FRAME_EXECUTOR_IMAGE);
      assert.equal(native.Config.User, "1000:1000");
      assert.deepEqual(Object.keys(native.NetworkSettings.Networks), network);
      assert.equal(native.Config.Labels["frame.paseo.work"], work.id);
      assert.equal(native.Config.Labels["frame.paseo.generation"], "1");
      const canonicalRoot = path.join(data, "works", work.id);
      for (const destination of ["/workspace", canonicalRoot]) {
        const mount = native.Mounts.find(value => value.Destination === destination);
        assert.equal(mount.Type, "bind");
        assert.equal(mount.RW, true);
        assert.equal(mount.Source, process.env.FRAME_HOST_DATA + "/works/" + work.id);
      }
      const gitCommon = (await command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: canonicalRoot, timeout: 10000 })).trim();
      const commonMount = native.Mounts.find(mount => mount.Destination === gitCommon);
      assert.equal(commonMount.Type, "bind");
      assert.equal(commonMount.RW, true);
      assert.equal(commonMount.Source, path.join(process.env.FRAME_HOST_DATA, path.relative(data, gitCommon)));
      assert(
        native.Mounts.every((mount) => !mount.Source.includes("docker.sock")),
      );
      const control = native.Mounts.find(
        (mount) => mount.Destination === "/paseo-control/control.json",
      );
      assert.equal(control.RW, false);
      assert.equal(
        control.Source,
        process.env.FRAME_HOST_DATA + "/paseo/" + work.id + "/control.json",
      );
      const shared = native.Mounts.find(
        (mount) => mount.Destination === "/paseo-models",
      );
      assert(
        shared,
        "Native daemon must read the one controller-owned model cache",
      );
      assert.equal(shared.RW, false);
      assert.equal(
        shared.Source,
        process.env.FRAME_HOST_DATA + "/paseo-models",
      );
      assert(
        native.Config.Env.includes("FRAME_PASEO_SHARED_MODELS_READONLY=1"),
      );
      const frameUrl = native.Config.Env.find((value) =>
        value.startsWith("FRAME_PASEO_URL="),
      );
      assert.equal(
        frameUrl,
        "FRAME_PASEO_URL=http://studio:3000/api/paseo/internal/" + work.id,
      );
      for (const value of native.Config.Env)
        assert(
          !/^(DATABASE_URL|FRAME_MASTER_KEY|FRAME_TEST_DATABASE_URL|OPENAI_API_KEY|CODEX_API_KEY)=/.test(
            value,
          ),
        );
      const uid = await command(
        "docker",
        [
          "exec",
          native.Id,
          "node",
          "-e",
          "console.log(process.getuid()+':'+process.getgid())",
        ],
        { timeout: 10000 },
      );
      assert.equal(uid.trim(), "1000:1000");
      containers.push({
        workId: work.id,
        id: native.Id,
        imageId: native.Image,
        generation: "1",
      });
    }
    const speechState = await fs
      .readFile(
        path.join(data, "paseo-models/.frame-speech-state.json"),
        "utf8",
      )
      .then(JSON.parse);
    assert.equal(speechState.state, "preparing");
    assert.deepEqual(speechState.completedModelIds, []);
    assert.equal(speechModels.calls, 1);
    report.sharedSpeech = {
      state: speechState.state,
      modelIds: speechState.modelIds,
      oneControllerDownload: true,
      nativeReadOnlyWait: true,
      speechReadyClaimed: false,
    };
    report.checks.push(
      "one controlled pending speech preparation is shared read-only; actual chat/SDK is ready without downloaded models",
    );
    report.checks.push(
      "exact current image, discovered network, UID1000, read-only scoped control and no Frame vault/Docker socket in native daemons",
    );
    const client = await manager.client(primary.id),
      profileId = "frame-" + selected.id;
    const home = path.join(data, "paseo", primary.id, "home");
    const capture = path.join(home, "owned-capture.jsonl");
    await fs.writeFile(
      path.join(home, "owned-native-fixture.mjs"),
      [
        "import fs from 'node:fs';import {createHash} from 'node:crypto';",
        "fs.appendFileSync(process.env.FRAME_FAKE_CAPTURE,JSON.stringify({kind:'credential-proof',uid:process.getuid(),gid:process.getgid(),keyHash:createHash('sha256').update(process.env.OPENAI_API_KEY||'').digest('hex'),frameUrl:process.env.FRAME_AGENT_URL,hasOther:!!process.env.ANTHROPIC_API_KEY})+'\\n');",
        "await import('/opt/frame/tests/server/paseo-fake-codex-app-server.mjs');",
      ].join("\n"),
      { mode: 0o600 },
    );
    await client.patchDaemonConfig({
      providers: {
        [profileId]: {
          command: [process.execPath, "/paseo-home/owned-native-fixture.mjs"],
          env: { FRAME_FAKE_CAPTURE: "/paseo-home/owned-capture.jsonl" },
          models: [
            { id: "owned-model", label: "Owned model", isDefault: true },
          ],
        },
      },
    });
    const publicConfig = JSON.stringify(await client.getDaemonConfig());
    assert(!publicConfig.includes(ownKey) && !publicConfig.includes(otherKey));
    const agent = await client.createAgent({
      provider: profileId,
      model: "owned-model",
      cwd: "/workspace",
      workspaceId: ready.workspaceId,
      title: "Actual Docker FRAME plugin",
      modeId: "auto",
    });
    assert(agent.id);
    const token = (
      await call("tokens_create", { name: "Owned Docker gateway" })
    ).token;
    const session = await fetch(
      "http://studio:3000/api/paseo/works/" + primary.id + "/session",
      { headers: { authorization: "Bearer " + token } },
    );
    assert.equal(session.status, 200);
    const bootstrap = await session.json();
    assert.equal(bootstrap.bootstrap.serverId, ready.serverId);
    assert.equal(bootstrap.bootstrap.workspaceId, ready.workspaceId);
    const html = await fetch("http://studio:3000" + bootstrap.uiUrl, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(html.status, 200);
    const htmlText = await html.text();
    assert(htmlText.includes("globalThis.__PASEO_FRAME_EMBED__="));
    assert(
      !htmlText.includes(capability) &&
        !htmlText.includes(ownKey) &&
        !htmlText.includes(otherKey),
    );
    const unauthorized = await fetch(
      "http://studio:3000/api/paseo/works/" + primary.id + "/session",
    );
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    gatewayClient = new DaemonClient({
      url: "ws://studio:3000/paseo/" + primary.id + "/ws",
      clientId: "owned-docker-gateway-" + owner,
      clientType: "cli",
      connectTimeoutMs: 10000,
      reconnect: { enabled: false },
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, {
          headers: { ...options?.headers, authorization: "Bearer " + token },
        }),
    });
    await gatewayClient.connect();
    const actual = await gatewayClient.fetchAgent({
      agentId: agent.id,
      timeout: 10000,
    });
    assert.equal(actual.agent.id, agent.id);
    const canonical = (
      await services.repos.project(primary.repo, primary.project)
    ).dir;
    const sceneBefore = await fs.readFile(
      path.join(canonical, "scene.ts"),
      "utf8",
    );
    const otherScenes = await Promise.all(works.slice(1).map(async work => {
      const { dir } = await services.repos.project(work.repo, work.project);
      return { dir, scene: await fs.readFile(path.join(dir, "scene.ts"), "utf8") };
    }));
    assert.equal(ready.projectRoot, canonical);
    assert.equal(ready.workspaceRoot, path.dirname(path.dirname(canonical)));
    const git = args => command("git", args, { cwd: ready.workspaceRoot, timeout: 10000 });
    const nativeGit = args => command("docker", ["exec", "--workdir", "/workspace", binding.container,
      "git", ...args], { timeout: 10000 });
    const head = await git(["rev-parse", "HEAD"]);
    const index = await git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    assert.equal(await nativeGit(["rev-parse", "HEAD"]), head);
    assert.equal(await nativeGit(["rev-parse", "--path-format=absolute", "--git-path", "index"]), index);
    await gatewayClient.sendAgentMessage(
      agent.id,
      "Owned Docker native turn: inspect FRAME context/assets/preview and edit this work's canonical source.",
      { messageId: randomUUID() },
    );
    const captured = await until(
      async () => {
        const rows = await fs
          .readFile(capture, "utf8")
          .then((value) => value.trim().split("\n").map(JSON.parse))
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return [];
          });
        const failed = rows.find((row) =>
          ["owned-turn-error", "protocol-error"].includes(row.kind),
        );
        if (failed) throw Error(failed.message);
        return rows.find((row) => row.kind === "accepted-turn") ? rows : null;
      },
      "Actual native fake provider did not complete authenticated FRAME work-tools",
      60000,
    );
    const credential = captured.find((row) => row.kind === "credential-proof");
    assert.equal(credential.keyHash, hash(ownKey));
    assert.notEqual(credential.keyHash, hash(otherKey));
    assert.equal(credential.frameUrl, "http://studio:3000");
    assert.equal(credential.uid, 1000);
    assert.equal(credential.gid, 1000);
    assert.equal(credential.hasOther, false);
    const launch = captured.find((row) => row.kind === "launch");
    assert(launch.frameCredentialInjected && launch.apiCredentialInjected);
    assert(
      !launch.hasMasterKey &&
        !launch.hasDatabaseUrl &&
        !launch.hasTestDatabaseUrl,
    );
    const accepted = captured.find((row) => row.kind === "accepted-turn");
    assert.equal(accepted.project, primary.project);
    assert.equal(accepted.cwd, "/workspace");
    assert.equal(accepted.framePreview.source, "work");
    assert.equal(accepted.framePreview.paseoAgent, undefined);
    assert.equal(accepted.scenePath, "/workspace/projects/" + primary.project + "/scene.ts");
    assert.match(accepted.prompt, /Owned Docker native turn/);
    const sceneAfter = await fs.readFile(path.join(canonical, "scene.ts"), "utf8");
    assert.equal(sceneAfter, sceneBefore + "\n" + accepted.marker + "\n");
    const scenePath = "projects/" + primary.project + "/scene.ts";
    await nativeGit(["add", "--", scenePath]);
    assert.equal(await git(["diff", "--cached", "--name-only"]), scenePath);
    assert.equal(await git(["show", ":" + scenePath]), sceneAfter.trim());
    await git(["reset", "--", scenePath]);
    assert.equal(await nativeGit(["diff", "--cached", "--name-only"]), "");
    await until(async () => {
      const native = await manager.observe(primary.id, { refresh: true });
      return !native.incomplete && !native.activeAgents.length && !native.activeTerminals && !native.pendingPermissions;
    }, "The native turn did not reach idle before canonical validation", 30000);
    const validation = await services.paseo.workspace.request(primary.id,
      { wait: true, signal: AbortSignal.timeout(120000) });
    assert.equal(validation.state, "passed", JSON.stringify(validation));
    assert.deepEqual(validation.result.validation.map(check => check.name),
      ["scope", "structure", "project-tests", "project-types", "runtime"]);
    assert(validation.result.validation.every(check => check.status === "passed"));
    const { treeHash } = await import("../../server/project-files.mjs");
    const sourceRevision = await treeHash(canonical, { includeExecutableMode: true });
    assert.equal(validation.revision, sourceRevision);
    assert.equal(validation.runtimeFingerprint, ready.runtimeFingerprint);
    assert.equal(validation.result.modeFingerprint, sourceRevision);
    assert.equal(validation.result.stale, false);
    const manifestUrl = new URL(accepted.framePreview.url, "http://studio:3000");
    manifestUrl.pathname = manifestUrl.pathname.replace(/index\.html$/, "manifest.json");
    manifestUrl.search = "";
    const { livePreviewManifestSchema } = await import("../../src/contracts/live-preview.mjs");
    const manifest = await until(async () => {
      const response = await fetch(manifestUrl);
      assert.equal(response.status, 200);
      const value = await response.json();
      if (value.state === "error") throw Error(JSON.stringify(value));
      return value.sourceRevision === sourceRevision && livePreviewManifestSchema.parse(value);
    }, "The agent's live preview did not compile the canonical revision", 30000);
    assert.equal(manifest.workId, primary.id);
    assert.equal(manifest.projectId, primary.project);
    assert.equal(manifest.source, "work");
    assert.equal(manifest.sessionId, accepted.framePreview.sessionId);
    assert.equal(await git(["rev-parse", "HEAD"]), head);
    assert.equal(await fs.readFile(path.join(canonical, "scene.ts"), "utf8"), sceneAfter);
    for (const other of otherScenes)
      assert.equal(await fs.readFile(path.join(other.dir, "scene.ts"), "utf8"), other.scene);
    assert.equal((await services.paseo.store.getWork(primary.id)).daemonGeneration, "1");
    assert.equal((await inspect("container", binding.container)).Id, containers[0].id);
    assert.deepEqual(await services.db.all("SELECT id FROM tasks WHERE kind='paseo'"), []);
    report.sharedGitIndexVerified = true;
    report.canonicalValidation = { revision: validation.revision, state: validation.state,
      checks: validation.result.validation.map(check => check.name), runtimeFingerprint: validation.runtimeFingerprint };
    report.checks.push(
      "full official daemon/plugin and authenticated gateway reach the selected native CLI; HMAC tools, canonical source, native Git index and all five validation gates share one existing runtime",
    );
    report.status = "passed";
    report.imageId = process.env.FRAME_EXECUTOR_IMAGE;
    report.testDriverHash = hash(await fs.readFile(here));
    report.sourceRevision = process.env.FRAME_REVISION;
    report.runtimeFingerprint = (await runtimeIdentity()).fingerprint;
    report.readyWorks = containers;
    report.maximumStarting = maximumStarting;
    report.startupMs = Date.now() - begin;
    report.nativeAgent = agent.id;
    report.nativeUid = "1000:1000";
    report.selectedCredentialHashVerified = true;
    report.noPaidProvider = true;
  } catch (error) {
    report.error = error.message;
    report.errorStack = error.stack;
    process.exitCode = 1;
  } finally {
    clearInterval(ticking);
    await gatewayClient?.close().catch(() => {});
    if (manager) {
      await Promise.allSettled([...manager.starting.values()]);
      for (const id of ledger.works) {
        const binding = await services.paseo.store.getWork(id);
        if (binding?.container)
          await manager.stop(id).catch((error) => {
            report.cleanupError = error.message;
            report.status = "failed";
            process.exitCode = 1;
          });
      }
    }
    await services?.app.close().catch((error) => {
      report.cleanupError = error.message;
      report.status = "failed";
      process.exitCode = 1;
    });
    await speechModels?.close().catch((error) => {
      report.cleanupError = error.message;
      report.status = "failed";
      process.exitCode = 1;
    });
    if (speechModels?.calls) {
      report.sharedSpeechDownloadAborted = speechModels.aborted;
      if (!speechModels.aborted) {
        report.cleanupError = "Owned pending downloader did not abort";
        report.status = "failed";
        process.exitCode = 1;
      }
    }
    await json("/data/report.json", report);
    console.log(JSON.stringify(report));
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === here &&
  process.argv[2] === "--worker"
) {
  await worker();
}
