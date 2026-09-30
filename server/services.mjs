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
    async close() {
      await livePreview.close();
      await tasks.close();
      await retention.close();
      await assets.close();
      connections.close();
      await db.pool.end();
    },
  };
}
