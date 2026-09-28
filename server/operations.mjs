import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  hash,
  token,
  confined,
  problem,
  passwordHash,
  passwordMatches,
} from "./security.mjs";
const uuid = z.string().uuid(),
  text = z.string().max(20000),
  project = z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64);
export function operations({ db, data, repos, assets, tasks, secrets }) {
  const registry = {};
  const add = (name, description, shape, fn) =>
    (registry[name] = { description, schema: z.strictObject(shape), fn });
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
    },
    (a) => repos.add(a),
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
    "Fetch, fast-forward pull, commit content files, or push including LFS",
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
      return {
        project: a.project,
        metadata: fs.readFileSync(confined(dir, "project.ts"), "utf8"),
        readme: fs.existsSync(confined(dir, "README.md"))
          ? fs.readFileSync(confined(dir, "README.md"), "utf8")
          : "",
        authoring: fs.readFileSync(
          new URL("../docs/AUTHORING.md", import.meta.url),
          "utf8",
        ),
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
      if (fs.statSync(file).size > 1024 * 1024)
        throw problem(413, "Text file exceeds 1 MiB");
      const content = fs.readFileSync(file, "utf8");
      return { path: a.path, content, sha256: hash(content) };
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
      db.lock(a.repo, async () => {
        await repos.writable(a.repo);
        const { dir } = await repos.project(a.repo, a.project),
          file = confined(dir, a.path);
        if (!/\.(ts|tsx|js|mjs|json|md|txt|svg|css|glsl|wgsl)$/.test(file))
          throw problem(400, "Unsupported text file");
        const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if ((previous ? hash(previous) : null) !== a.expectedSha256)
          throw problem(409, "File changed; read the current version first");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = file + ".frame-" + randomUUID();
        fs.writeFileSync(temp, a.content);
        fs.renameSync(temp, file);
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
          width: z.number().int().min(320).max(3840).multipleOf(32).optional(),
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
    { id: uuid, after: z.number().int().nonnegative().default(0) },
    async (a) => ({
      task: await tasks.get(a.id),
      events: await db.all(
        "SELECT * FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT 100",
        [a.id, a.after],
      ),
    }),
  );
  add("task_cancel", "Cancel a queued or running task", { id: uuid }, (a) =>
    tasks.cancel(a.id),
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
    { id: uuid, name: z.string().min(1).max(200), tags: z.string().max(1000) },
    async (a) => {
      await db.pool.query("UPDATE assets SET name=$2,tags=$3 WHERE id=$1", [
        a.id,
        a.name,
        a.tags,
      ]);
      return assets.get(a.id);
    },
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
    },
    async (a) => {
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
    "upload_chunk",
    "Append a base64 chunk at exact byte offset; repeated identical chunks are accepted",
    {
      id: uuid,
      offset: z.number().int().nonnegative(),
      base64: z.string().max(1024 * 1024),
    },
    async (a) =>
      db.lock("upload:" + a.id, async () => {
        const dir = path.join(data, "uploads", a.id),
          meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8")),
          file = dir + "/bytes",
          bytes = Buffer.from(a.base64, "base64"),
          size = fs.statSync(file).size;
        if (a.offset + bytes.length > meta.bytes)
          throw problem(400, "Upload exceeds declared size");
        if (a.offset < size) {
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
        const dir = path.join(data, "uploads", a.id),
          meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
        if (meta.result) return meta.result;
        const { fileSha256 } = await import("../scripts/production-input.mjs");
        if (
          fs.statSync(dir + "/bytes").size !== meta.bytes ||
          fileSha256(dir + "/bytes") !== meta.sha256
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
    "chats_create",
    "Create an AI conversation tied to one project",
    {
      repo: uuid,
      project,
      provider: z.enum(["codex", "claude"]),
      title: z.string().min(1).max(120),
    },
    async (a) => {
      await repos.project(a.repo, a.project);
      return db.one(
        "INSERT INTO chats(id,repo,project,provider,title) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [randomUUID(), a.repo, a.project, a.provider, a.title],
      );
    },
  );
  add(
    "chats_send",
    "Send a turn to an AI conversation; runs after browser disconnect",
    { id: uuid, prompt: z.string().min(1).max(40000) },
    async (a) => {
      const c = await db.one("SELECT * FROM chats WHERE id=$1", [a.id]);
      if (!c) throw problem(404, "Chat not found");
      return tasks.create({
        repo: c.repo,
        project: c.project,
        kind: "agent",
        chat: c.id,
        input: { provider: c.provider, prompt: a.prompt },
      });
    },
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
  add(
    "password_change",
    "Change the administrator password and invalidate all sessions",
    { current: z.string().max(1024), password: z.string().min(14).max(1024) },
    async (a) => {
      const admin = await db.setting("admin");
      if (!passwordMatches(a.current, admin.password))
        throw problem(403, "Current password incorrect");
      await db.setting("admin", { password: passwordHash(a.password) });
      await db.pool.query("DELETE FROM sessions");
      return { ok: true };
    },
  );
  add(
    "engines_list",
    "List built-in and external speech engines without API keys",
    {},
    async () => {
      const rows = await db.all("SELECT * FROM engines ORDER BY created");
      return rows.map((r) => {
        const c = secrets.decrypt(r.config);
        return {
          ...r,
          config: { ...c, apiKey: undefined, configured: !!c.apiKey },
        };
      });
    },
  );
  add(
    "engines_save",
    "Add or update OpenAI-compatible speech engine",
    {
      id: uuid.optional(),
      name: z.string().min(1).max(120),
      url: z.string().url(),
      model: z.string().min(1).max(150),
      voice: z.string().min(1).max(150),
      apiKey: z.string().max(8000).optional(),
      enabled: z.boolean().default(true),
    },
    async (a) => {
      const u = new URL(a.url);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw problem(400, "Invalid URL");
      const old = a.id
        ? await db.one("SELECT * FROM engines WHERE id=$1", [a.id])
        : null;
      const prior = old ? secrets.decrypt(old.config) : {};
      const config = {
        url: a.url,
        model: a.model,
        voice: a.voice,
        apiKey: a.apiKey || prior.apiKey || "",
      };
      const id = a.id || randomUUID();
      await db.pool.query(
        "INSERT INTO engines(id,name,config,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,config=$3,enabled=$4",
        [id, a.name, secrets.encrypt(config), a.enabled],
      );
      return { id };
    },
  );
  add(
    "speech_test",
    "Synthesize speech, register WAV/MP3 and optionally attach to project",
    {
      engine: uuid,
      text: z.string().min(1).max(4000),
      voice: z.string().max(150).optional(),
      repo: uuid.optional(),
      project: project.optional(),
    },
    async (a) => {
      const row = await db.one(
        "SELECT * FROM engines WHERE id=$1 AND enabled=true",
        [a.engine],
      );
      if (!row) throw problem(404, "Speech engine unavailable");
      const c = secrets.decrypt(row.config),
        start = Date.now();
      const response = await fetch(c.url.replace(/\/$/, "") + "/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.apiKey ? { Authorization: "Bearer " + c.apiKey } : {}),
        },
        body: JSON.stringify({
          model: c.model,
          voice: a.voice || c.voice,
          input: a.text,
          response_format: "wav",
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok)
        throw problem(502, "Speech engine returned HTTP " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 64 * 1024 * 1024)
        throw problem(413, "Speech output too large");
      const file = path.join(data, "uploads", randomUUID());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      try {
        const asset = await assets.register(file, {
          name: "speech-" + Date.now() + ".wav",
          mime: "audio/wav",
          license: "Generated with " + row.name,
        });
        if (a.repo && a.project)
          await assets.attach(asset.id, a.repo, a.project);
        return { asset, elapsedMs: Date.now() - start };
      } finally {
        fs.unlinkSync(file);
      }
    },
  );
  const local = async (route, options = {}) => {
    const r = await fetch(
      (process.env.FRAME_SPEECH_URL || "http://speech:8000") + route,
      { ...options, signal: AbortSignal.timeout(180000) },
    );
    if (!r.ok) throw problem(502, "Local speech: " + (await r.text()));
    return r.json();
  };
  add("models_list", "List installed local Kokoro models and voices", {}, () =>
    local("/models"),
  );
  add(
    "models_create",
    "Create a named Kokoro model slot for uploading config.json, model.pth and voice tensors",
    { id: project },
    (a) => local("/models/" + a.id, { method: "POST" }),
  );
  add(
    "models_delete",
    "Delete a custom model; built-in model is protected",
    { id: project },
    (a) => local("/models/" + a.id, { method: "DELETE" }),
  );
  return {
    registry,
    async call(name, args) {
      const op = registry[name];
      if (!op) throw problem(404, "Unknown operation");
      return op.fn(op.schema.parse(args || {}));
    },
  };
}
