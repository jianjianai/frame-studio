import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { speechOperations } from "./speech.mjs";
import { workOperations } from "./work-operations.mjs";
import { workbenchOperations } from "./workbench.mjs";
import { chatOperations } from "./chat-operations.mjs";
import { createOperationRegistry } from "./operation-registry.mjs";
import { registerToolHelp } from "./tool-catalog.mjs";
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
  registerToolHelp(add, registry);
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
    {
      repo: uuid,
      project,
      sections: z
        .array(z.enum(["metadata", "readme", "authoring"]))
        .max(3)
        .default(["metadata", "readme", "authoring"]),
    },
    async (a) => {
      const { dir } = await repos.project(a.repo, a.project);
      const read = (relative) => {
        const file = confined(dir, relative);
        if (!fs.existsSync(file)) return "";
        if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024)
          throw problem(
            413,
            "Context source exceeds 1 MiB; split large source files or use the asset workflow",
          );
        return fs.readFileSync(file, "utf8");
      };
      return {
        project: a.project,
        ...(a.sections.includes("metadata")
          ? { metadata: read("project.ts") }
          : {}),
        ...(a.sections.includes("readme") ? { readme: read("README.md") } : {}),
        ...(a.sections.includes("authoring")
          ? {
              authoring: fs.readFileSync(
                new URL("../docs/AUTHORING.md", import.meta.url),
                "utf8",
              ),
            }
          : {}),
        instructions:
          "Use project_files and project_read. Edits need expectedSha256. Create preview tasks; poll task_get. Tasks persist after MCP disconnect.",
      };
    },
  );
  add(
    "project_files",
    "List files inside one project",
    { repo: uuid, project },
    async (a) => {
      const { dir } = await repos.project(a.repo, a.project),
        files = [];
      function walk(folder, relative = "") {
        for (const name of fs.readdirSync(folder)) {
          if (
            name.startsWith(".") ||
            name === "exports" ||
            name === "node_modules"
          )
            continue;
          const rel = relative ? relative + "/" + name : name,
            file = confined(dir, rel),
            st = fs.statSync(file);
          if (st.isDirectory()) walk(file, rel);
          else files.push({ path: rel, bytes: st.size });
          if (files.length > 5000) throw problem(400, "Too many files");
        }
      }
      walk(dir);
      return files;
    },
  );
  add(
    "project_read",
    "Read a UTF-8 file with its SHA-256 for conflict-safe editing",
    { repo: uuid, project, path: z.string().max(512) },
    async (a) => {
      const { dir } = await repos.project(a.repo, a.project),
        file = confined(dir, a.path);
      if (!fs.existsSync(file))
        throw problem(404, "Source file not found; list the work files first");
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw problem(400, "Expected a regular text file");
      if (stat.size > 1024 * 1024)
        throw problem(
          413,
          "Text file exceeds 1 MiB; split large source files or use the asset workflow",
        );
      const bytes = fs.readFileSync(file);
      let content;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw problem(
          400,
          "File is not valid UTF-8; use the asset download endpoint for binary files",
        );
      }
      if (content.includes("\0"))
        throw problem(400, "Binary file is not editable text");
      return {
        path: a.path,
        content,
        bytes: bytes.length,
        sha256: hash(bytes),
      };
    },
  );
  add(
    "project_write",
    "Create or replace a project file; null hash means new file",
    {
      repo: uuid,
      project,
      path: z.string().max(512),
      expectedSha256: z.string().length(64).nullable(),
      content: z.string().max(1024 * 1024),
    },
    async (a) =>
      db.lock(`${a.repo}:${a.project}`, async () => {
        await repos.writable(a.repo, a.project);
        const { dir } = await repos.project(a.repo, a.project),
          file = confined(dir, a.path);
        if (Buffer.byteLength(a.content, "utf8") > 1024 * 1024)
          throw problem(413, "Text file exceeds 1 MiB in UTF-8 bytes");
        if (a.content.includes("\0"))
          throw problem(400, "NUL characters are not allowed in text files");
        if (
          !/\.(ts|tsx|js|jsx|mjs|json|md|txt|svg|css|glsl|wgsl|vert|frag|csv|srt|vtt)$/.test(
            file,
          )
        )
          throw problem(400, "Unsupported text file");
        if (fs.existsSync(file)) {
          const stat = fs.statSync(file);
          if (!stat.isFile())
            throw problem(400, "Expected a regular text file");
          if (stat.size > 1024 * 1024)
            throw problem(
              413,
              "Existing text file exceeds 1 MiB; use an asset workflow for large files",
            );
        }
        const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if ((previous ? hash(previous) : null) !== a.expectedSha256)
          throw problem(409, "File changed; read the current version first");
        await repos.revisions?.invalidate(a.repo, a.project);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = file + ".frame-" + randomUUID();
        try {
          fs.writeFileSync(temp, a.content, { flag: "wx" });
          fs.renameSync(temp, file);
        } finally {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
        await repos.revisions?.invalidate(a.repo, a.project);
        return { sha256: hash(a.content) };
      }),
  );
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
      events: await db.all(
        "SELECT * FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT 100",
        [a.id, a.after],
      ),
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
      if (
        task.state !== "succeeded" ||
        !task.result?.artifacts?.some((f) => f.path === a.path)
      )
        throw problem(404, "Artifact not available");
      const file = confined(path.join(data, "runs", a.id), a.path),
        st = fs.statSync(file);
      if (st.size > 6 * 1024 * 1024)
        throw problem(413, "Use a smaller frame or download the artifact");
      if (/\.png$/.test(file))
        return {
          mimeType: "image/png",
          dataBase64: fs.readFileSync(file).toString("base64"),
        };
      if (/\.(json|srt)$/.test(file))
        return { text: fs.readFileSync(file, "utf8") };
      throw problem(400, "Use PNG for AI visual inspection");
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
    },
    async (a) => {
      await repos.get(a.repo);
      const id = randomUUID(),
        dir = path.join(data, "uploads", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        dir + "/meta.json",
        JSON.stringify({ ...a, created: Date.now() }),
      );
      fs.writeFileSync(dir + "/bytes", Buffer.alloc(0));
      return { id, offset: 0, chunkBytes: 768 * 1024 };
    },
  );
  add(
    "upload_status",
    "Inspect resumable upload progress and expected checksum; finished uploads keep their asset result.",
    { id: uuid },
    async ({ id }) =>
      db.lock("upload:" + id, async () => {
        const dir = path.join(data, "uploads", id);
        if (!fs.existsSync(dir + "/meta.json"))
          throw problem(404, "Upload not found or expired");
        const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
        return {
          id,
          repo: meta.repo,
          name: meta.name,
          bytes: meta.bytes,
          sha256: meta.sha256,
          offset: meta.result ? meta.bytes : fs.statSync(dir + "/bytes").size,
          state: meta.result ? "finished" : "uploading",
          chunkBytes: 768 * 1024,
          ...(meta.result ? { result: meta.result } : {}),
        };
      }),
  );
  add(
    "upload_abort",
    "Remove only this unfinished upload's temporary bytes. Does not delete registered materials. Safe to repeat for a missing upload.",
    { id: uuid },
    async ({ id }) =>
      db.lock("upload:" + id, async () => {
        const dir = path.join(data, "uploads", id);
        if (!fs.existsSync(dir + "/meta.json"))
          return { id, aborted: false, state: "absent" };
        const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
        if (meta.result)
          throw problem(
            409,
            "Upload already registered an asset; use asset lifecycle operations instead",
          );
        fs.rmSync(dir, { recursive: true });
        return { id, aborted: true };
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
        const dir = path.join(data, "uploads", a.id);
        if (!fs.existsSync(dir + "/meta.json"))
          throw problem(404, "Upload not found or expired");
        const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
        if (meta.result)
          throw problem(409, "Upload already finished; inspect upload_status");
        if (
          !a.base64 ||
          a.base64.length % 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            a.base64,
          )
        )
          throw problem(400, "Chunk must be canonical nonempty base64");
        const file = dir + "/bytes",
          bytes = Buffer.from(a.base64, "base64"),
          size = fs.statSync(file).size;
        if (a.offset + bytes.length > meta.bytes)
          throw problem(400, "Upload exceeds declared size");
        if (bytes.toString("base64") !== a.base64)
          throw problem(400, "Chunk must be canonical base64");
        if (a.offset < size) {
          if (a.offset + bytes.length > size)
            throw problem(
              409,
              "Repeated chunk partially overlaps existing bytes",
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
        const dir = path.join(data, "uploads", a.id);
        if (!fs.existsSync(dir + "/meta.json"))
          throw problem(404, "Upload not found or expired");
        const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
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
  return {
    works,
    registry,
    call,
  };
}
