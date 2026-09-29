import { z } from "zod";
import { Works } from "./works.mjs";
import { browserPreview } from "./browser-preview.mjs";
import { treeHash } from "./security.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
export function workOperations({
  add,
  registry,
  db,
  data,
  repos,
  assets,
  tasks,
}) {
  const works = new Works(db, data, repos, assets, tasks),
    uuid = z.string().uuid();
  const invoke = (name, args) =>
    registry[name].fn(registry[name].schema.parse(args));
  const resolve = async (id) => {
    const w = await works.get(id, { active: true });
    return { repo: w.repo, project: w.project };
  };
  add(
    "works_list",
    "List works across all storage repositories, with covers and activity",
    {
      deleted: z.boolean().default(false),
      search: z.string().max(200).default(""),
      category: z.string().max(80).default(""),
      status: z.enum(["", "draft", "review", "finished"]).default(""),
      repo: uuid.optional(),
      recent: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(60),
      offset: z.number().int().min(0).default(0),
    },
    (a) => works.list(a),
  );
  add(
    "works_create",
    "Create a work in its own branch of the selected content repository",
    {
      title: z.string().trim().min(1).max(150),
      repo: uuid,
      renderer: z.enum(["canvas", "pixi", "three"]).default("canvas"),
      duration: z.number().positive().max(3600).default(12),
      category: z.string().max(80).default(""),
    },
    (a) => works.create(a),
  );
  add(
    "works_update",
    "Update work title, category, description or production status",
    {
      id: uuid,
      title: z.string().trim().min(1).max(150).optional(),
      category: z.string().max(80).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(["draft", "review", "finished"]).optional(),
    },
    ({ id, ...a }) => works.update(id, a),
  );
  add(
    "works_trash",
    "Move a work to the recoverable recycle bin, or restore it; files and assets are retained",
    { id: uuid, deleted: z.boolean(), confirm: z.string().optional() },
    async (a) => {
      const w = await works.get(a.id);
      if (a.deleted && a.confirm !== w.title) {
        const error = new Error("请输入完整作品名称确认删除");
        error.statusCode = 400;
        throw error;
      }
      return works.update(a.id, { deleted: a.deleted });
    },
  );
  add(
    "works_duplicate",
    "Duplicate work content and referenced materials into a new work",
    { id: uuid, title: z.string().trim().min(1).max(150) },
    (a) => works.duplicate(a.id, a.title),
  );
  add(
    "works_context",
    "Read one work, authoring instructions, material references and recent tasks",
    { id: uuid },
    async (a) => {
      const work = await works.get(a.id),
        args = { repo: work.repo, project: work.project };
      return {
        work,
        ...(await invoke("project_context", args)),
        assets: await assets.list({
          repo: work.repo,
          project: work.project,
          limit: 200,
        }),
        tasks: await db.all(
          "SELECT * FROM tasks WHERE repo=$1 AND project=$2 ORDER BY created DESC LIMIT 60",
          [work.repo, work.project],
        ),
      };
    },
  );
  for (const name of ["files", "read", "write"]) {
    const old = registry["project_" + name];
    add(
      "works_" + name,
      old.description,
      {
        id: uuid,
        ...Object.fromEntries(
          Object.entries(old.schema.shape).filter(
            ([k]) => !["repo", "project"].includes(k),
          ),
        ),
      },
      async ({ id, ...a }) => {
        const args = await resolve(id),
          result = await invoke("project_" + name, { ...args, ...a });
        if (name === "write")
          await db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [
            id,
          ]);
        return result;
      },
    );
  }
  add(
    "works_task",
    "Preview, validate, render a frame/storyboard or export a work in a durable task",
    {
      id: uuid,
      kind: z.enum(["validate", "frame", "storyboard", "render", "build"]),
      input: registry.task_create.schema.shape.input,
    },
    async ({ id, ...a }) => tasks.create({ ...(await resolve(id)), ...a }),
  );
  add(
    "works_tasks",
    "Read tasks belonging to one work",
    { id: uuid },
    async (a) => {
      const w = await works.get(a.id);
      return db.all(
        "SELECT * FROM tasks WHERE repo=$1 AND project=$2 ORDER BY created DESC LIMIT 100",
        [w.repo, w.project],
      );
    },
  );
  add(
    "works_assets",
    "List materials present in a work",
    {
      id: uuid,
      limit: z.number().int().min(1).max(200).default(60),
      offset: z.number().int().min(0).default(0),
    },
    async (a) => {
      const w = await works.get(a.id);
      await assets.importProject(w.repo, w.project);
      return assets.list({
        repo: w.repo,
        project: w.project,
        limit: a.limit,
        offset: a.offset,
      });
    },
  );
  add(
    "works_use_asset",
    "Copy a library asset into this work and its content repository",
    { id: uuid, asset: uuid },
    async (a) => {
      const w = await resolve(a.id);
      return assets.attach(a.asset, w.repo, w.project);
    },
  );
  add(
    "works_speech",
    "Synthesize a narration and save it in this work and the global material library",
    {
      id: uuid,
      engine: uuid,
      text: z.string().min(1).max(4000),
      voice: z.string().max(150).optional(),
      speed: z.number().min(0.5).max(2).default(1),
    },
    async ({ id, ...a }) =>
      invoke("speech_generate", { ...(await resolve(id)), ...a }),
  );
  add(
    "works_chats",
    "List this work’s persistent AI conversations",
    { id: uuid },
    async (a) => {
      const w = await resolve(a.id);
      return db.all(
        "SELECT * FROM chats WHERE repo=$1 AND project=$2 ORDER BY created DESC",
        [w.repo, w.project],
      );
    },
  );
  add(
    "works_chat_create",
    "Start a persistent AI conversation for a work",
    {
      id: uuid,
      provider: z.enum(["codex", "claude"]),
      title: z.string().min(1).max(120),
    },
    async ({ id, ...a }) =>
      invoke("chats_create", { ...(await resolve(id)), ...a }),
  );
  add(
    "works_versions",
    "List independent Git history and legacy local snapshots of this work",
    {
      id: uuid,
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    (a) => works.history(a.id, a.limit, a.offset),
  );
  add(
    "works_chat_send",
    "Send a persistent AI creation turn for this work; continues after disconnect",
    {
      id: uuid,
      chat: uuid,
      prompt: z.string().min(1).max(40000),
    },
    async ({ id, chat, prompt }) => {
      const w = await works.get(id, { active: true });
      const c = await db.one(
        "SELECT id FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
        [chat, w.repo, w.project],
      );
      if (!c) throw new Error("Conversation does not belong to this work");
      return invoke("chats_send", { id: chat, prompt });
    },
  );
  add(
    "works_checkpoint",
    "Save a named snapshot of work source and all materials",
    { id: uuid, name: z.string().trim().min(1).max(150) },
    (a) => works.version(a.id, a.name),
  );
  add(
    "works_restore",
    "Restore a work snapshot, saving the current version first",
    { id: uuid, version: z.union([uuid, z.string().regex(/^[a-f0-9]{40}$/)]) },
    (a) => works.restore(a.id, a.version),
  );
  add(
    "repositories_default",
    "Set automatic storage for new works",
    { repo: uuid },
    async (a) => {
      await repos.get(a.repo);
      await db.setting("default-repository", { id: a.repo });
      return { ok: true };
    },
  );
  add(
    "works_browser",
    "Get a private AI browser URL with FRAME_AI console controls. Rendering, segment playback, screenshots and WebM exports execute in the client browser. If compilation is needed, returns a durable task; poll and call again.",
    { id: uuid, rebuild: z.boolean().default(false) },
    async (a) => {
      const w = await works.get(a.id, { active: true });
      const { dir } = await repos.project(w.repo, w.project);
      const latest = await db.one(
        "SELECT * FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded' AND result->>'previewVersion'=$3 ORDER BY created DESC LIMIT 1",
        [w.repo, w.project, String(PREVIEW_VERSION)],
      );
      if (latest && !a.rebuild && latest.fingerprint === treeHash(dir)) {
        const link = await browserPreview(db, latest, { ai: true });
        return {
          state: "ready",
          ...link,
          url:
            (process.env.FRAME_PUBLIC_URL || "http://localhost:3000") +
            link.url,
          work: w.id,
          revision: latest.fingerprint,
          task: latest.id,
          console: "await FRAME_AI.ready(); FRAME_AI.help()",
          compute: "browser",
        };
      }
      const pending = await db.one(
        "SELECT id,kind,state FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('queued','running','cancelling') ORDER BY created LIMIT 1",
        [w.repo, w.project],
      );
      if (pending)
        return {
          state: "building",
          task: pending.id,
          kind: pending.kind,
          next: "Poll task_get, then call works_browser again.",
        };
      const task = await tasks.create({
        repo: w.repo,
        project: w.project,
        kind: "build",
      });
      return {
        state: "building",
        task: task.id,
        next: "Poll task_get, then call works_browser again. Only compilation runs on the server.",
      };
    },
  );
  return works;
}
