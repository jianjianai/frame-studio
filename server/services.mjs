import fs from "node:fs";
import path from "node:path";
import { database } from "./db.mjs";
import { vault } from "./security.mjs";
import { Repositories } from "./repositories.mjs";
import { Assets } from "./assets.mjs";
import { Tasks } from "./tasks.mjs";
import { operations } from "./operations.mjs";
import { Connections } from "./connections.mjs";
import { GitHub } from "./github.mjs";
import { Retention } from "./retention.mjs";
import { seedSpeech } from "./speech.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { LivePreviewSessions } from "./live-preview.mjs";
import { PaseoStore } from "./paseo-store.mjs";
import { PaseoWork } from "./paseo-work.mjs";
import { PaseoManager } from "./paseo-manager.mjs";
import { PaseoWorkspace } from "./paseo-workspace.mjs";
import { PaseoValidation } from "./paseo-validation.mjs";

/** Shared domain assembly, without HTTP listeners or a privileged scheduler. */
export async function createServices({
  db,
  data = process.env.FRAME_DATA || "/data",
  masterKey = process.env.FRAME_MASTER_KEY,
  initialize = true,
} = {}) {
  if (process.env.HOME?.startsWith("/tmp/"))
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(data, "tools"), { recursive: true });
  db ||= await database(
    process.env.DATABASE_URL,
    process.env.FRAME_ADMIN_PASSWORD,
  );
  await runtimeIdentity(); // Warm once, never hash platform code for each preview subscription.
  const secrets = vault(masterKey),
    repos = new Repositories(db, data, secrets),
    assets = new Assets(db, data, repos),
    tasks = new Tasks(db, data, repos, secrets);
  const connections = new Connections(db, data, secrets),
    github = new GitHub(db, secrets, repos, data),
    retention = new Retention(db, data);
  const livePreview = new LivePreviewSessions({ db, data, repos });
  connections.github = github;
  tasks.connections = connections;
  const actions = operations({
    db,
    data,
    repos,
    assets,
    tasks,
    secrets,
    connections,
    github,
    retention,
    livePreview,
  });
  const paseoStore = await new PaseoStore({ db }).initialize();
  const paseoWork = new PaseoWork({ db, data, repos, works: actions.works, connections, secrets, livePreview, store: paseoStore });
  const paseoManager = new PaseoManager({ db, data, tasks, connections, store: paseoStore, workService: paseoWork });
  paseoWork.manager = paseoManager;
  paseoWork.authorizeAgent = (work, agentId) => paseoManager.agent(work.id, agentId);
  const paseoValidation = new PaseoValidation({ db, data, repos, works: actions.works, tasks, manager: paseoManager, store: paseoStore });
  const paseoWorkspace = new PaseoWorkspace({ db, data, works: actions.works, repos, store: paseoStore, manager: paseoManager,
    validate: (report, options) => paseoValidation.validate(report, options),
    onChange: async workId => {
      const work = await actions.works.get(workId, { active: true });
      await repos.revisions?.refresh(work.repo, work.project);
      assets.invalidateReferences(work.repo, work.project);
    },
    onError: (_workId, error) => console.error("Paseo workspace:", error.message),
  });
  tasks.externalActivity = options => paseoManager.active(options);
  repos.nativeActivity = async (repo, project) => (await paseoManager.active({ repo, project })).length > 0;
  connections.nativeActivity = async (connection, options = {}) => (await paseoManager.active({ profileId: "frame-" + connection, ...options })).length > 0;
  actions.works.paseo = { manager: paseoManager, workspace: paseoWorkspace, store: paseoStore, work: paseoWork };
  tasks.validateWorkspace = async (task, options = {}) => {
    const work = await db.one("SELECT id FROM works WHERE repo=$1 AND project=$2 AND NOT deleted", [task.repo, task.project]);
    if (!work) throw Object.assign(Error("作品已不存在，请刷新作品列表"), { statusCode: 404 });
    const report = await paseoWorkspace.request(work.id, { ...options, wait: false });
    await options.onReport?.(report);
    return options.wait === false ? report : paseoWorkspace.request(work.id, { ...options, reportId: report.id, wait: true });
  };
  paseoManager.onReconcile = async workId => {
    if (!paseoWorkspace.entries.has(workId)) await paseoWorkspace.start(workId);
    else await paseoWorkspace.reconcile(workId);
  };
  paseoManager.onStopped = workId => paseoWorkspace.stop(workId);
  paseoManager.onNativeEvent = (workId, event) => {
    if (event.type === "agent.turn_ended") void paseoWorkspace.reconcile(workId, { force: true }).catch(() => {});
  };
  let paseoTimer;
  const startPaseoLoop = () => {
    if (paseoTimer) return;
    paseoTimer = setInterval(() => {
      if (tasks.lease?.held || process.env.FRAME_LOCAL_MODE === "1") void paseoManager.tick().catch(error => console.error("Paseo controller:", error.message));
    }, 5000);
    paseoTimer.unref();
  };
  repos.onChange = async (id, project = null) => {
    if (!project) await assets.indexRepository(id);
    await actions.works.discover(id, project);
    assets.invalidateReferences(id, project);
  };
  if (initialize) {
    await connections.migrate();
    await github.migrate();
    await assets.migrate();
    await actions.works.discover();
    await db.pool.query(
      "UPDATE tasks SET expires=finished+interval '7 days' WHERE finished IS NOT NULL AND expires IS NULL",
    );
    await seedSpeech(db, secrets);
  } else {
    actions.works.discovered = true;
  }
  return {
    db,
    data,
    secrets,
    repos,
    assets,
    tasks,
    connections,
    github,
    retention,
    actions,
    livePreview,
    paseoStore, paseoWork, paseoManager, paseoWorkspace, paseoValidation, startPaseoLoop,
    async close() {
      clearInterval(paseoTimer);
      await paseoWorkspace.close();
      await paseoManager.close();
      await livePreview.close();
      await tasks.close();
      await retention.close();
      await assets.close();
      connections.close();
      await db.pool.end();
    },
  };
}
