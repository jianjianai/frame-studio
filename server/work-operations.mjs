import { compactTask, TASK_SUMMARY_COLUMNS } from "./agent-toolkit.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { z } from "zod";
import {
  workIdRequestSchema,
  workTaskRequestSchema,
  workPreviewRequestSchema,
  workVersionsRequestSchema,
  workVersionRequestSchema,
  workRestoreRequestSchema,
} from "../src/contracts/platform.mjs";
import { Works } from "./works.mjs";
import { sourceControlOperations } from "./source-control.mjs";
import { compositionSchema } from "../src/engine/dimensions.mjs";
import { browserPreview } from "./browser-preview.mjs";
import { readWorkPreview } from "./preview-state.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
import { compareVersion, versionTree } from "./version-review.mjs";
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
      composition: compositionSchema.optional(),
      category: z.string().max(80).default(""),
    },
    (a) => works.create(a),
  );
  add(
    "works_update",
    "Update work title, category, description or production status",
    {
      id: uuid,
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      title: z.string().trim().min(1).max(150).optional(),
      category: z.string().max(80).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(["draft", "review", "finished"]).optional(),
    },
    ({ id, expectedRevision, ...a }) =>
      works.update(id, a, { expectedRevision }),
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
    "Read compact work context and recent task summaries. detail includes the full authoring reference, never repeated build manifests.",
    {
      id: uuid,
      detail: z.boolean().default(false),
      taskLimit: z.number().int().min(0).max(20).default(5),
    },
    async (a) => {
      const work = await works.get(a.id),
        args = { repo: work.repo, project: work.project };
      const context = await invoke("project_context", args);
      const taskRows = a.taskLimit
        ? await db.all(
            `SELECT ${TASK_SUMMARY_COLUMNS} FROM tasks WHERE repo=$1 AND project=$2 ORDER BY created DESC,id DESC LIMIT $3`,
            [work.repo, work.project, a.taskLimit],
          )
        : [];
      return {
        work,
        ...context,
        authoring: a.detail
          ? context.authoring
          : "createScene({width,height,quality}) returns {canvas,render(time),dispose()}; render uses absolute seconds, no independent clock. Keep all source/media under this work. Use detail:true for the complete scene/audio/export reference.",
        instructions:
          "Use frame_works_files_page, frame_works_search and frame_works_read. Paths are work-relative; id is the work UUID. A partial read is NOT a replacement file. Prefer frame_works_patch with the whole-file expectedSha256. Validate and render with frame_works_task; wait with frame_task_status, then inspect artifacts. Tasks survive MCP disconnection.",
        assets: await assets.list({ ...args, limit: 20 }),
        tasks: taskRows.map((task) => compactTask(task, { artifactLimit: 3 })),
        nextActions: [
          { tool: "frame_works_files_page", arguments: { id: a.id } },
          {
            tool: "frame_works_tasks_page",
            arguments: { id: a.id, offset: a.taskLimit },
          },
          { tool: "frame_works_assets", arguments: { id: a.id, offset: 20 } },
        ],
      };
    },
  );
  for (const name of [
    "files",
    "files_page",
    "read",
    "write",
    "patch",
    "search",
    "delete_file",
  ]) {
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
        if (
          name === "write" ||
          (["patch", "delete_file"].includes(name) && !a.dryRun)
        )
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
    workTaskRequestSchema,
    async ({ id, ...a }) => tasks.create({ ...(await resolve(id)), ...a }),
  );
  add(
    "works_tasks",
    "Read tasks belonging to one work",
    workIdRequestSchema,
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
      search: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(200).default(60),
      offset: z.number().int().min(0).default(0),
    },
    async (a) => {
      const w = await works.get(a.id);
      await assets.importProject(w.repo, w.project);
      return assets.list({
        repo: w.repo,
        project: w.project,
        search: a.search,
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
    "works_speech_adopt",
    "Adopt the exact temporary audition as a work resource",
    { id: uuid, task: uuid, name: z.string().trim().min(1).max(180) },
    async ({ id, ...a }) =>
      invoke("speech_adopt", { ...(await resolve(id)), ...a }),
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
    "works_versions",
    "List independent Git history and legacy local snapshots of this work",
    workVersionsRequestSchema,
    (a) => works.history(a.id, a.limit, a.offset),
  );
  add(
    "works_checkpoint",
    "Save a named snapshot of work source and all materials",
    { id: uuid, name: z.string().trim().min(1).max(150) },
    (a) => works.version(a.id, a.name),
  );
  add(
    "works_version_compare",
    "Compare a work version to the current work without modifying either",
    workVersionRequestSchema,
    async (a) => compareVersion(repos, await works.get(a.id), a.version),
  );
  add(
    "works_version_preview",
    "Build an immutable historical preview; does not restore or save the current work",
    workVersionRequestSchema,
    async (a) => {
      const work = await works.get(a.id, { active: true });
      await versionTree(repos, work, a.version);
      const runtime = await runtimeIdentity();
      return db.lock(
        "version-preview:" + work.id + ":" + a.version,
        async () => {
          const existing = await db.one(
            "SELECT * FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND input->>'version'=$3 AND cleaned IS NULL AND (state IN ('queued','running','publishing','publish_failed') OR (state='succeeded' AND result->>'previewVersion'=$4 AND result->>'runtimeFingerprint'=$5)) ORDER BY created DESC LIMIT 1",
            [
              work.repo,
              work.project,
              a.version,
              String(PREVIEW_VERSION),
              runtime.fingerprint,
            ],
          );
          return (
            existing ||
            tasks.create({
              repo: work.repo,
              project: work.project,
              kind: "build",
              input: { version: a.version },
            })
          );
        },
      );
    },
  );
  add(
    "works_restore",
    "Restore a work snapshot, saving the current version first",
    workRestoreRequestSchema,
    (a) => works.restore(a.id, a.version, a.expectedRevision),
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
    "works_preview_status",
    "Read indexed source and preview revisions; refresh explicitly scans external changes",
    workPreviewRequestSchema,
    async (a) => {
      let work = await works.get(a.id, { active: true });
      if (a.refresh) {
        await repos.revisions?.refresh(work.repo, work.project);
        work = await works.get(a.id, { active: true });
      }
      return readWorkPreview({ db, work });
    },
  );
  add(
    "works_browser",
    "Get a private AI browser URL with FRAME_AI console controls. Rendering, segment playback, screenshots and WebM exports execute in the client browser. If compilation is needed, returns a durable task; poll and call again.",
    { id: uuid, rebuild: z.boolean().default(false) },
    async (a) => {
      const w = await works.get(a.id, { active: true });
      const { latest, stale } = await readWorkPreview({ db, repos, work: w });
      if (latest && !a.rebuild && !stale) {
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
        "SELECT id,kind,state FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('queued','running','cancelling','publishing','publish_failed') ORDER BY created LIMIT 1",
        [w.repo, w.project],
      );
      if (pending)
        return {
          state: pending.state === "publish_failed" ? "attention" : "building",
          task: pending.id,
          kind: pending.kind,
          next:
            pending.state === "publish_failed"
              ? "Inspect frame_task_status and retry with frame_task_retry_publish after resolving the publication error."
              : "Poll frame_task_status, then call frame_works_browser again.",
        };
      const task = await tasks.create({
        repo: w.repo,
        project: w.project,
        kind: "build",
      });
      return {
        state: "building",
        task: task.id,
        next: "Poll frame_task_status, then call frame_works_browser again. Only compilation runs on the server.",
      };
    },
  );
  sourceControlOperations({ add, db, repos, works });
  return works;
}
