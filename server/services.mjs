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
import { PaseoDrafts } from "./paseo-drafts.mjs";
import { PaseoPublication } from "./paseo-publication.mjs";

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
  const paseoPublication = new PaseoPublication({ db, data, repos, works: actions.works, tasks, manager: paseoManager, store: paseoStore });
  const paseoDrafts = new PaseoDrafts({ db, data, works: actions.works, repos, store: paseoStore, manager: paseoManager,
    validate: (candidate, options) => paseoPublication.validate(candidate, options),
    publish: candidate => paseoPublication.publish(candidate),
    recoverCandidate: async () => ({ active: false }),
    onError: (_workId, error) => console.error("Paseo draft:", error.message),
  });
  tasks.publication.beforeApply = task => paseoPublication.beforeApply(task);
  tasks.externalActivity = options => paseoManager.active(options);
  repos.nativeActivity = async (repo, project) => (await paseoManager.active({ repo, project })).length > 0;
  connections.nativeActivity = async connection => (await paseoManager.active({ profileId: "frame-" + connection })).length > 0;
  actions.works.paseo = { manager: paseoManager, drafts: paseoDrafts, store: paseoStore };
  livePreview.sourceResolver = async (work, { agentId } = {}) => {
    if (!agentId) return { projectDir: (await paseoWork.prepare(work.id)).draft.projectRoot, agentId: null };
    const agent = await paseoManager.agent(work.id, agentId);
    if (!agent) throw Object.assign(Error("Native agent does not belong to this work"), { statusCode: 404 });
    const workspace = await paseoManager.resolveAgentWorkspace(work.id, agent.cwd);
    return { projectDir: path.join(workspace.checkoutRoot, "projects", work.project), agentId };
  };
  paseoManager.onReconcile = async workId => {
    if (!paseoDrafts.entries.has(workId)) await paseoDrafts.start(workId);
    else await paseoDrafts.reconcile(workId);
  };
  paseoManager.onStopped = workId => paseoDrafts.stop(workId);
  paseoManager.onNativeEvent = (workId, event) => {
    if (event.type === "agent.turn_ended") void paseoDrafts.reconcile(workId, { force: true }).catch(() => {});
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
    paseoStore, paseoWork, paseoManager, paseoDrafts, paseoPublication, startPaseoLoop,
    async close() {
      clearInterval(paseoTimer);
      await paseoDrafts.close();
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
