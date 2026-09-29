import { registerToolHelp } from "./tool-catalog.mjs";
import { readUpload } from "./upload-state.mjs";
import { projectTextOperations, readSource } from "./project-text.mjs";
import { agentToolkitOperations } from "./agent-toolkit.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentInteractionOperations } from "./agent-interactions.mjs";
import { agentEventPage } from "./agent-event-page.mjs";
import { speechOperations } from "./speech.mjs";
import { workOperations } from "./work-operations.mjs";
import { workbenchOperations } from "./workbench.mjs";
import { chatOperations } from "./chat-operations.mjs";
import { createOperationRegistry } from "./operation-registry.mjs";
import { workResultOperations } from "./work-results.mjs";
import { taskGetRequestSchema } from "../src/contracts/platform.mjs";
import { workIdRequestSchema } from "../src/contracts/platform.mjs";
import { hash, token, confined, problem } from "./security.mjs";
const uuid = z.string().uuid(),
  text = z.string().max(20000),
  project = z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64);
export function operations({
  db,
  data,
  repos,
  assets,
  tasks,
  secrets,
  connections,
  github,
  retention,
}) {
  const { registry, add, call } = createOperationRegistry();
  add(
    "repositories_list",
    "List repositories and statically discovered animation projects",
    {},
    () => repos.list(),
  );
  add(
    "repositories_add",
    "Create a content repository or clone a GitHub repository",
    {
      name: z.string().min(1).max(120),
      url: z.string().default(""),
      branch: z.string().default("main"),
      account: uuid.optional(),
    },
    async (a) => {
      const repo = await repos.add(a);
      await repos.onChange?.(repo.id);
      return repo;
    },
  );
  add(
    "repositories_status",
    "Read Git status, diff and recent commits",
    { repo: uuid },
    (a) => repos.status(a.repo),
  );
  add(
    "repositories_remote",
    "Connect a local content repository to an existing GitHub repository",
    { repo: uuid, url: z.string().url() },
    async (a) =>
      db.lock(a.repo, async () => {
        await repos.writable(a.repo);
        const { allowedGitUrl } = await import("./security.mjs");
        allowedGitUrl(a.url);
        const r = await repos.get(a.repo);
        const remotes = await repos.git(r.root, ["remote"]);
        await repos.git(r.root, [
          "remote",
          remotes.split("\n").includes("origin") ? "set-url" : "add",
          "origin",
          a.url,
        ]);
        await db.pool.query("UPDATE repos SET url=$2 WHERE id=$1", [
          a.repo,
          a.url,
        ]);
        return repos.status(a.repo);
      }),
  );
  add(
    "repositories_sync",
    "Synchronize the repository material-library branch including LFS; use works_sync for a work",
    {
      repo: uuid,
      action: z.enum(["fetch", "pull", "commit", "push"]),
      message: z.string().max(1000).optional(),
    },
    (a) => repos.sync(a.repo, a.action, a.message),
  );
  add(
    "project_context",
    "Read project metadata, authoring rules and project README",
    { repo: uuid, project },
    async (a) => {
      const { dir } = await repos.project(a.repo, a.project);
      const optional = async (file) => {
        const source = await readSource(dir, file, { missing: true });
        return source
          ? {
              content: source.content.slice(0, 16000),
              truncated: source.content.length > 16000,
              sha256: source.sha256,
            }
          : null;
      };
      const metadata = await readSource(dir, "project.ts"),
        readme = await optional("README.md");
      return {
        project: a.project,
        metadata: metadata.content.slice(0, 16000),
        metadataTruncated: metadata.content.length > 16000,
        readme: readme?.content ?? "",
        readmeTruncated: readme?.truncated ?? false,
        projectInstructions: await optional("AGENTS.md"),
        brief: await optional("production/brief.md"),
        authoring: fs.readFileSync(
          new URL("../docs/AUTHORING.md", import.meta.url),
          "utf8",
        ),
        instructions:
          "Use project_files_page, project_search and project_read with repo/project, or use frame_works_context with the work UUID for public MCP tools. Read partial files in pages; edit with expectedSha256. Create tasks, then poll task_status.",
      };
    },
  );
  projectTextOperations({ add, db, repos, uuid, project });
  add(
    "task_create",
    "Create a durable project task. Rendering runs in a separate container",
    {
      repo: uuid,
      project,
      kind: z.enum([
        "new",
        "validate",
        "frame",
        "storyboard",
        "render",
        "build",
      ]),
      input: z
        .strictObject({
          title: z.string().max(150).optional(),
          renderer: z.enum(["canvas", "pixi", "three"]).optional(),
          duration: z.number().positive().max(3600).optional(),
          time: z.number().nonnegative().max(3600).optional(),
          width: z.number().int().min(2).max(3840).multipleOf(2).optional(),
          fps: z.number().int().min(1).max(120).optional(),
          subtitles: z.boolean().optional(),
          start: z.number().nonnegative().max(3600).optional(),
          end: z.number().positive().max(3600).optional(),
        })
        .default({}),
    },
    (a) => tasks.create(a),
  );
  add("tasks_list", "List recent durable tasks", {}, () =>
    db.all("SELECT * FROM tasks ORDER BY created DESC LIMIT 100"),
  );
  add(
    "task_get",
    "Read durable task state, artifacts and incremental events",
    taskGetRequestSchema,
    async (a) => ({
      task: await tasks.get(a.id),
      ...(await agentEventPage(db, a.id, a.after)),
    }),
  );
  add(
    "task_cancel",
    "Cancel a queued or running task",
    workIdRequestSchema,
    (a) => tasks.cancel(a.id),
  );
  add(
    "task_retry_publish",
    "Retry saving an already completed result without re-running AI",
    workIdRequestSchema,
    (a) => tasks.retryPublication(a.id),
  );
  add(
    "artifact_read",
    "Read a completed task PNG for visual inspection; JSON and subtitles return as text",
    { id: uuid, path: z.string().max(1024) },
    async (a) => {
      const task = await tasks.get(a.id);
      if (task.state !== "succeeded")
        throw Object.assign(
          problem(
            409,
            "Task is not complete; inspect task_status before reading artifacts.",
          ),
          { code: "TASK_NOT_COMPLETE", recovery: "task-status" },
        );
      if (task.cleaned)
        throw Object.assign(
          problem(
            410,
            "Artifact expired; create a new preview or render task.",
          ),
          { code: "ARTIFACT_EXPIRED", recovery: "create-new-task" },
        );
      if (!task.result?.artifacts?.some((f) => f.path === a.path))
        throw problem(
          404,
          "Artifact is not listed in this task; inspect task_status.",
        );
      const release = await retention?.lease?.(a.id);
      try {
        const file = confined(path.join(data, "runs", a.id), a.path),
          st = fs.statSync(file);
        if (!st.isFile()) throw problem(404, "Artifact is not a file.");
        if (st.size > 6 * 1024 * 1024)
          throw problem(
            413,
            "Use a smaller frame or platform download with this task id and artifact path.",
          );
        const metadata = {
          id: a.id,
          path: a.path,
          bytes: st.size,
          downloadPath:
            `/api/tasks/${a.id}/file/` +
            a.path.split("/").map(encodeURIComponent).join("/"),
        };
        if (/\.png$/i.test(file))
          return {
            ...metadata,
            mimeType: "image/png",
            dataBase64: fs.readFileSync(file).toString("base64"),
          };
        if (/\.(json|srt)$/i.test(file))
          return { ...metadata, text: fs.readFileSync(file, "utf8") };
        throw problem(
          400,
          "Use PNG/JSON/SRT for inline inspection; platform download supports video and audio.",
        );
      } catch (error) {
        if (error.code === "ENOENT")
          throw Object.assign(
            problem(404, "Artifact file is missing; create a new task."),
            { code: "ARTIFACT_MISSING", recovery: "create-new-task" },
          );
        throw error;
      } finally {
        await release?.();
      }
    },
  );
  add(
    "assets_list",
    "List material library, optionally only unassigned assets or recycle bin",
    {
      unused: z.boolean().default(false),
      deleted: z.boolean().default(false),
      search: z.string().max(200).default(""),
      repo: uuid.optional(),
      limit: z.number().int().min(1).max(200).default(60),
      offset: z.number().int().nonnegative().default(0),
    },
    (a) => assets.list(a),
  );
  add(
    "assets_attach",
    "Copy asset into a project repository and save its provenance",
    { id: uuid, repo: uuid, project },
    (a) => assets.attach(a.id, a.repo, a.project),
  );
  add(
    "assets_detach",
    "Remove library association; retain project bytes for dynamic references",
    { id: uuid, repo: uuid, project },
    (a) => assets.detach(a.id, a.repo, a.project),
  );
  add(
    "assets_trash",
    "Move unassigned asset to recycle bin or restore it",
    { id: uuid, deleted: z.boolean() },
    (a) => assets.trash(a.id, a.deleted),
  );
  add(
    "assets_update",
    "Edit asset display name and tags",
    {
      id: uuid,
      name: z.string().min(1).max(200),
      tags: z.string().max(1000),
      license: z.string().trim().min(1).max(4000).optional(),
    },
    (a) => assets.update(a.id, a.name, a.tags, a.license),
  );
  add(
    "assets_purge",
    "Permanently delete an unassigned recycled asset and release unshared blob storage",
    { id: uuid },
    (a) => assets.purge(a.id),
  );
  add(
    "upload_begin",
    "Begin resumable asset upload; provide exact total bytes and SHA-256",
    {
      name: z.string().min(1).max(200),
      bytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      license: z.string().min(1).max(2000),
      mime: z.string().max(120).default("application/octet-stream"),
      repo: uuid,
      requestKey: uuid.optional(),
    },
    async (a) =>
      db.lock("upload:" + (a.requestKey ?? randomUUID()), async () => {
        await repos.get(a.repo);
        const id = a.requestKey ?? randomUUID(),
          dir = path.join(data, "uploads", id);
        if (fs.existsSync(dir)) {
          const { meta } = readUpload(data, id);
          if (
            ["name", "bytes", "sha256", "license", "mime", "repo"].some(
              (key) => meta[key] !== a[key],
            )
          )
            throw problem(
              409,
              "requestKey already belongs to a different upload.",
            );
          return {
            id,
            offset: meta.result ? meta.bytes : fs.statSync(dir + "/bytes").size,
            chunkBytes: 768 * 1024,
            result: meta.result ?? null,
          };
        }
        fs.mkdirSync(dir);
        fs.writeFileSync(
          dir + "/meta.json",
          JSON.stringify({ ...a, created: Date.now() }),
          { flag: "wx", mode: 0o600 },
        );
        fs.writeFileSync(dir + "/bytes", Buffer.alloc(0), {
          flag: "wx",
          mode: 0o600,
        });
        return { id, offset: 0, chunkBytes: 768 * 1024 };
      }),
  );
  add(
    "upload_status",
    "Read a resumable upload's exact offset and metadata, or the already completed asset. Never starts or restarts an upload.",
    { id: uuid },
    (a) =>
      db.lock("upload:" + a.id, async () => {
        const { dir, meta } = readUpload(data, a.id);
        return {
          id: a.id,
          name: meta.name,
          repo: meta.repo,
          bytes: meta.bytes,
          sha256: meta.sha256,
          license: meta.license,
          mime: meta.mime,
          state: meta.result ? "complete" : "uploading",
          offset: meta.result ? meta.bytes : fs.statSync(dir + "/bytes").size,
          chunkBytes: 768 * 1024,
          result: meta.result ?? null,
        };
      }),
  );
  add(
    "upload_abort",
    "Discard only an unfinished upload session. Completed library assets are never deleted by this tool.",
    { id: uuid },
    (a) =>
      db.lock("upload:" + a.id, async () => {
        let upload;
        try {
          upload = readUpload(data, a.id);
        } catch (error) {
          if (error.code === "UPLOAD_NOT_FOUND")
            return { id: a.id, aborted: false };
          throw error;
        }
        const { dir, meta } = upload;
        if (meta.result)
          throw problem(
            409,
            "Upload already completed; use the asset recycle bin instead.",
          );
        fs.rmSync(dir, { recursive: true });
        return { id: a.id, aborted: true };
      }),
  );
  add(
    "upload_chunk",
    "Append a base64 chunk at exact byte offset; repeated identical chunks are accepted",
    {
      id: uuid,
      offset: z.number().int().nonnegative(),
      base64: z.string().max(1024 * 1024),
    },
    async (a) =>
      db.lock("upload:" + a.id, async () => {
        const { dir, meta } = readUpload(data, a.id);
        if (meta.result)
          throw problem(
            409,
            "Upload is already complete; use upload_status or upload_finish for its asset.",
          );
        const file = dir + "/bytes",
          bytes = Buffer.from(a.base64, "base64");
        if (!bytes.length || bytes.toString("base64") !== a.base64)
          throw problem(400, "Chunk must be nonempty canonical base64.");
        const size = fs.statSync(file).size;
        if (a.offset + bytes.length > meta.bytes)
          throw problem(400, "Upload exceeds declared size");
        if (a.offset < size) {
          if (a.offset + bytes.length > size)
            throw problem(
              409,
              "Chunk overlaps the current end; resume at the offset from upload_status.",
            );
          const fd = fs.openSync(file, "r"),
            old = Buffer.alloc(bytes.length);
          try {
            fs.readSync(fd, old, 0, old.length, a.offset);
          } finally {
            fs.closeSync(fd);
          }
          if (!old.equals(bytes)) throw problem(409, "Chunk conflicts");
          return { offset: size };
        }
        if (a.offset !== size) throw problem(409, "Incorrect upload offset");
        fs.appendFileSync(file, bytes);
        return { offset: size + bytes.length };
      }),
  );
  add(
    "upload_finish",
    "Verify upload checksum and register the asset",
    { id: uuid },
    async (a) =>
      db.lock("upload:" + a.id, async () => {
        const { dir, meta } = readUpload(data, a.id);
        if (meta.result) return meta.result;
        const { fileSha256 } = await import("./project-files.mjs");
        if (
          fs.statSync(dir + "/bytes").size !== meta.bytes ||
          (await fileSha256(dir + "/bytes")) !== meta.sha256
        )
          throw problem(409, "Upload size or checksum mismatch");
        const result = await assets.register(dir + "/bytes", meta);
        fs.writeFileSync(
          dir + "/meta.json",
          JSON.stringify({ ...meta, result }),
        );
        fs.unlinkSync(dir + "/bytes");
        return result;
      }),
  );
  add("chats_list", "List persistent AI conversations", {}, () =>
    db.all("SELECT * FROM chats ORDER BY created DESC LIMIT 100"),
  );
  add(
    "settings_get",
    "Read connection settings with secrets removed",
    {},
    async () => {
      const result = {};
      for (const name of ["github", "codex", "claude"]) {
        const s = await db.setting(name),
          v = s?.encrypted ? secrets.decrypt(s.encrypted) : {};
        result[name] = {
          configured: !!(v.apiKey || v.token),
          baseUrl: v.baseUrl || "",
          model: v.model || "",
        };
      }
      result.tools = await db.all(
        "SELECT input,result,state,error FROM tasks WHERE kind='tools-update' ORDER BY created DESC LIMIT 10",
      );
      return result;
    },
  );
  add(
    "settings_save",
    "Save encrypted provider credentials; blank secret preserves prior value",
    {
      provider: z.enum(["github", "codex", "claude"]),
      secret: z.string().max(8000).optional(),
      baseUrl: z.string().max(1000).default(""),
      model: z.string().max(200).default(""),
    },
    async (a) => {
      if (a.baseUrl) {
        const u = new URL(a.baseUrl);
        if (
          !["https:", "http:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw problem(400, "Invalid API URL");
      }
      const old = await db.setting(a.provider),
        v = old?.encrypted ? secrets.decrypt(old.encrypted) : {};
      v.baseUrl = a.baseUrl;
      v.model = a.model;
      // Legacy connections also pin credential identity for queued V5 turns.
      // A random generation avoids reusing an identity after concurrent key rotations.
      if (a.provider !== "github" && a.secret && a.secret !== v.apiKey)
        v.auth_generation = randomUUID();
      if (a.secret) v[a.provider === "github" ? "token" : "apiKey"] = a.secret;
      await db.setting(a.provider, { encrypted: secrets.encrypt(v) });
      return { ok: true };
    },
  );
  add(
    "tools_update",
    "Install a specific Codex or Claude CLI version independently",
    { provider: z.enum(["codex", "claude"]), version: z.string().max(80) },
    (a) => tasks.create({ kind: "tools-update", input: a }),
  );
  add(
    "tokens_list",
    "List API access tokens without revealing secrets",
    {},
    () => db.all("SELECT id,name,created FROM tokens ORDER BY created DESC"),
  );
  add(
    "tokens_create",
    "Create an API/MCP token; plaintext returned only once",
    { name: z.string().min(1).max(100) },
    async (a) => {
      const value = token(),
        id = randomUUID();
      await db.pool.query("INSERT INTO tokens(id,name,hash) VALUES($1,$2,$3)", [
        id,
        a.name,
        hash(value),
      ]);
      return { id, token: value };
    },
  );
  add(
    "tokens_revoke",
    "Revoke an API token immediately",
    { id: uuid },
    async (a) => {
      await db.pool.query("DELETE FROM tokens WHERE id=$1", [a.id]);
      return { ok: true };
    },
  );
  speechOperations({ add, db, data, secrets, assets });
  const works = workOperations({
    add,
    registry,
    db,
    data,
    repos,
    assets,
    tasks,
  });
  const interactions = agentInteractionOperations({ add, db, data });
  chatOperations({ add, db, works, repos, tasks, connections, secrets });
  workResultOperations({ add, db, data, works, repos, tasks });
  if (connections)
    workbenchOperations({
      add,
      db,
      data,
      works,
      repos,
      assets,
      tasks,
      connections,
      github,
      retention,
    });
  agentToolkitOperations({ add, registry, db, works, tasks });
  registerToolHelp(add, registry);
  return {
    works,
    interactions,
    registry,
    call,
  };
}
