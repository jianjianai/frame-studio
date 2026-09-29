import { z } from "zod";
import { randomUUID } from "node:crypto";
import { problem } from "./security.mjs";
import { toolBinary } from "./connections.mjs";
import { command } from "./process.mjs";
import { RuntimeStatus } from "./runtime-status.mjs";

export function workbenchOperations({
  add,
  db,
  works,
  repos,
  tasks,
  assets,
  connections,
  github,
  retention,
  data,
}) {
  const runtime = new RuntimeStatus({ db, data, tasks, speechUrl: process.env.FRAME_SPEECH_URL || "http://speech:8000" });
  add("system_status", "Read execution readiness, task backlog, disk capacity and migration versions", {}, () => runtime.read());
  const uuid = z.string().uuid(),
    limit = z.number().int().min(1).max(100).default(30),
    offset = z.number().int().min(0).default(0),
    search = z.string().max(200).default("");
  add(
    "repositories_get",
    "Read repository metadata",
    { repo: uuid },
    async (a) => {
      const { root, ...r } = await repos.get(a.repo);
      return r;
    },
  );
  add(
    "repositories_page",
    "Paginated repository catalog; no filesystem scan",
    { limit, offset, search, account: uuid.optional() },
    async (a) => {
      const where =
        "FROM repos r LEFT JOIN github_accounts g ON g.id=r.account WHERE (r.name ILIKE $1 OR r.url ILIKE $1) AND ($2::uuid IS NULL OR r.account=$2)";
      const params = ["%" + a.search + "%", a.account || null];
      return {
        items: await db.all(
          `SELECT r.*,g.login,(SELECT count(*)::int FROM works w WHERE w.repo=r.id AND NOT w.deleted) AS work_count ${where} ORDER BY r.created DESC,r.id LIMIT $3 OFFSET $4`,
          [...params, a.limit, a.offset],
        ),
        total: (await db.one(`SELECT count(*)::int AS n ${where}`, params)).n,
      };
    },
  );
  add(
    "works_page",
    "Paginated recent works or one repository",
    {
      repo: uuid.optional(),
      recent: z.boolean().default(false),
      deleted: z.boolean().default(false),
      status: z.enum(["", "draft", "review", "finished"]).default(""),
      search,
      limit,
      offset,
    },
    async (a) => {
      const items = await works.list(a);
      const total = await db.one(
        "SELECT count(*)::int AS n FROM works WHERE deleted=$1 AND ($2::uuid IS NULL OR repo=$2) AND (NOT $3 OR opened IS NOT NULL) AND (title ILIKE $4 OR description ILIKE $4) AND ($5='' OR status=$5)",
        [a.deleted, a.repo || null, a.recent, "%" + a.search + "%", a.status],
      );
      return { items, total: total.n };
    },
  );
  add(
    "works_open",
    "Open a work and remember its access time",
    { id: uuid },
    async (a) => {
      const w = await works.get(a.id, { active: true });
      await db.pool.query("UPDATE works SET opened=now() WHERE id=$1", [a.id]);
      return {
        ...w,
        repository: await repos.get(w.repo).then(({ root, ...r }) => r),
      };
    },
  );
  add("works_background", "Active projects, grouped by work", {}, () =>
    db.all(
      `SELECT w.*,r.name AS storage_name,jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,'created',t.created,'started',t.started) ORDER BY t.created) AS tasks FROM tasks t JOIN works w ON w.repo=t.repo AND w.project=t.project JOIN repos r ON r.id=w.repo WHERE t.state IN ('queued','running','cancelling','publishing','publish_failed') GROUP BY w.id,r.name ORDER BY min(t.created)`,
    ),
  );
  add(
    "works_stop",
    "Stop all queued and running tasks for this work",
    { id: uuid },
    async (a) => {
      const w = await works.get(a.id);
      const rows = await db.all(
        "SELECT id FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('queued','running','cancelling')",
        [w.repo, w.project],
      );
      for (const row of rows) await tasks.cancel(row.id);
      return { stopped: rows.length };
    },
  );
  add(
    "repositories_check",
    "Read material library branch sync status",
    { repo: uuid, fetch: z.boolean().default(false) },
    (a) => repos.status(a.repo, { fetch: a.fetch }),
  );
  add(
    "works_sync_status",
    "Read this work branch ahead/behind and local changes",
    { id: uuid, fetch: z.boolean().default(false) },
    async (a) => {
      const w = await works.get(a.id);
      return repos.status(w.repo, { work: w.id, fetch: a.fetch });
    },
  );
  add(
    "works_sync",
    "Pull or push only this work branch",
    {
      id: uuid,
      action: z.enum(["fetch", "pull", "push", "commit"]),
      message: z.string().max(1000).optional(),
    },
    async (a) => {
      const w = await works.get(a.id, { active: true });
      return repos.sync(w.repo, a.action, a.message, w.id);
    },
  );
  add(
    "repositories_refresh",
    "Discover work branches from GitHub",
    { repo: uuid },
    async (a) => {
      await repos.fetchBranches(a.repo);
      await works.discover(a.repo);
      return { ok: true };
    },
  );
  add(
    "repositories_account",
    "Associate a repository with an authenticated GitHub account",
    { repo: uuid, account: uuid },
    async (a) => {
      await repos.get(a.repo);
      if (
        !(await db.one("SELECT id FROM github_accounts WHERE id=$1", [
          a.account,
        ]))
      )
        throw problem(404, "Account not found");
      await db.pool.query("UPDATE repos SET account=$2 WHERE id=$1", [
        a.repo,
        a.account,
      ]);
      return { ok: true };
    },
  );
  add("github_accounts", "List linked GitHub accounts", {}, () =>
    github.list(),
  );
  add(
    "connections_test",
    "Test selected model API or official CLI login status",
    { id: uuid },
    (a) => connections.test(a.id),
  );
  add(
    "github_token",
    "Connect a GitHub account with a personal access token",
    { token: z.string().min(10).max(8000) },
    (a) => github.connect(a.token),
  );
  add(
    "github_repositories",
    "List repositories accessible to a GitHub account",
    { account: uuid, page: z.number().int().min(1).default(1) },
    (a) => github.remoteRepos(a.account, a.page),
  );
  add(
    "github_create_repository",
    "Create a GitHub content repository and add it to FRAME",
    {
      account: uuid,
      name: z.string().min(1).max(100),
      description: z.string().max(500).default(""),
      private: z.boolean().default(true),
    },
    async (a) => {
      const repo = await github.create(
        a.account,
        a.name,
        a.description,
        a.private,
      );
      await works.discover(repo.id);
      return repo;
    },
  );
  add("connections_list", "List model providers without credentials", {}, () =>
    connections.list(),
  );
  add(
    "connections_save",
    "Save a named Codex or Claude model connection",
    {
      id: uuid.optional(),
      name: z.string().trim().min(1).max(100),
      tool: z.enum(["codex", "claude"]),
      mode: z.enum(["api", "official"]),
      baseUrl: z.string().max(1000).default(""),
      model: z.string().max(200).default(""),
      apiKey: z.string().max(10000).optional(),
    },
    (a) => connections.save(a),
  );
  add(
    "auth_begin",
    "Start official GitHub, Codex or Claude browser login",
    { kind: z.enum(["github", "codex", "claude"]), target: uuid.optional() },
    (a) => connections.begin(a.kind, a.target),
  );
  add("auth_state", "Read a browser authorization flow", { id: uuid }, (a) =>
    connections.flow(a.id),
  );
  add(
    "auth_submit",
    "Submit the official Claude authorization code",
    { id: uuid, code: z.string().max(4000) },
    (a) => connections.submit(a.id, a.code),
  );
  add("tools_info", "Installed and selected CLI versions", {}, async () => {
    const rows = [];
    for (const tool of ["codex", "claude"])
      rows.push({
        tool,
        version: await command(toolBinary(data, tool), ["--version"], {
          timeout: 15000,
        }).catch(() => "不可用"),
        updates: await db.all(
          "SELECT id,state,input,result,error FROM tasks WHERE kind='tools-update' AND input->>'provider'=$1 ORDER BY created DESC LIMIT 3",
          [tool],
        ),
      });
    return rows;
  });
  add(
    "works_chat_create",
    "Create a conversation bound to a named model connection",
    {
      id: uuid,
      connection: uuid,
      title: z.string().max(120).default("创作对话"),
    },
    async (a) => {
      const w = await works.get(a.id, { active: true }),
        c = await connections.resolve(a.connection);
      return db.one(
        "INSERT INTO chats(id,repo,project,provider,title,connection) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [randomUUID(), w.repo, w.project, c.tool, a.title, a.connection],
      );
    },
  );
  add(
    "works_chat_send",
    "Persist an idempotent creation turn with review context; runs after disconnect",
    {
      id: uuid,
      chat: uuid,
      prompt: z.string().trim().min(1).max(40000),
      requestKey: uuid.optional(),
      context: z
        .strictObject({
          time: z.number().min(0).max(3600).optional(),
          start: z.number().min(0).max(3600).optional(),
          end: z.number().min(0).max(3600).optional(),
          assets: z.array(uuid).max(20).optional(),
        })
        .optional(),
    },
    async (a) => {
      const w = await works.get(a.id, { active: true }),
        chat = await db.one(
          "SELECT * FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
          [a.chat, w.repo, w.project],
        );
      if (!chat) throw problem(404, "Conversation not found");
      if (chat.connection) await connections.resolve(chat.connection);
      if (a.context?.assets)
        for (const asset of a.context.assets)
          if (
            !(await db.one(
              "SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2",
              [asset, w.repo],
            ))
          )
            throw problem(400, "素材不属于当前仓库");
      const assetNames = {};
      for (const id of a.context?.assets || []) {
        const asset = await db.one("SELECT name FROM assets WHERE id=$1", [id]);
        if (asset) assetNames[id] = asset.name;
      }
      return tasks.create({
        repo: w.repo,
        project: w.project,
        kind: "agent",
        chat: chat.id,
        requestKey: a.requestKey || null,
        input: {
          provider: chat.provider,
          connection: chat.connection,
          prompt: a.prompt,
          context: a.context ? { ...a.context, assetNames } : undefined,
        },
      });
    },
  );
  add(
    "works_chat_turns",
    "Paginate one conversation independently of other work activity",
    { id: uuid, chat: uuid, before: uuid.optional(), limit },
    async (a) => {
      const w = await works.get(a.id);
      const chat = await db.one(
        "SELECT id FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
        [a.chat, w.repo, w.project],
      );
      if (!chat) throw problem(404, "Conversation not found");
      return db.all(
        "SELECT * FROM tasks WHERE chat=$1 AND ($2::uuid IS NULL OR (created,id)<(SELECT created,id FROM tasks WHERE id=$2 AND chat=$1)) ORDER BY created DESC,id DESC LIMIT $3",
        [a.chat, a.before || null, a.limit],
      );
    },
  );
  add(
    "works_exports",
    "List temporary video exports and expiration dates",
    { id: uuid },
    async (a) => {
      const w = await works.get(a.id);
      return db.all(
        "SELECT id,state,error,result,input,progress,created,expires,cleaned FROM tasks WHERE repo=$1 AND project=$2 AND (kind='render' OR (kind='agent' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(result->'artifacts','[]'::jsonb)) artifact WHERE lower(right(artifact->>'path',4))='.mp4' OR lower(right(artifact->>'path',5))='.webm'))) ORDER BY created DESC LIMIT 50",
        [w.repo, w.project],
      );
    },
  );
  add(
    "exports_delete",
    "Remove completed temporary export files",
    { id: uuid },
    async (a) => ({
      removed: await retention.cleanTask(a.id, { manual: true }),
    }),
  );
  add(
    "exports_release",
    "Publish a video export to its content repository GitHub Releases",
    {
      task: uuid,
      artifact: z.string().max(1000),
      tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/),
      title: z.string().min(1).max(200),
      notes: z.string().max(10000).default(""),
    },
    (a) => github.release(a),
  );
}
