import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "./process.mjs";
import { allowedGitUrl, confined, problem } from "./security.mjs";
import { copyTree } from "./project-files.mjs";
import { ProjectRevisions } from "./project-revisions.mjs";
import { validProjectId, readProject } from "../scripts/project-metadata.mjs";
import { purgedWorkKey } from "./work-purge.mjs";
export class Repositories {
  constructor(db, data, secrets) {
    this.db = db;
    this.data = data;
    this.secrets = secrets;
    this.revisions = new ProjectRevisions(db, this);
    fs.mkdirSync(path.join(data, "repos"), { recursive: true });
  }
  async get(id) {
    const row = await this.db.one("SELECT * FROM repos WHERE id=$1", [id]);
    if (!row) throw problem(404, "Repository not found");
    return { ...row, root: path.join(this.data, "repos", row.id) };
  }
  async project(repo, id, { exists = true } = {}) {
    if (!validProjectId(id)) throw problem(400, "Invalid project id");
    let r = await this.get(repo);
    const work = await this.db.one(
      "SELECT id,branch FROM works WHERE repo=$1 AND project=$2",
      [repo, id],
    );
    if (work?.branch)
      r = {
        ...r,
        root: path.join(this.data, "works", work.id),
        branch: work.branch,
      };
    const dir = confined(r.root, "projects/" + id);
    if (exists && !fs.existsSync(path.join(dir, "project.ts")))
      throw problem(404, "Project not found");
    return { repo: r, dir };
  }
  async checkout(repo, branch, target) {
    return this.db.lock("git-layout:" + repo.id, async () => {
      if (branch.startsWith("works/") && await this.db.setting(purgedWorkKey(repo.id, branch.slice(6))))
        throw problem(410, "作品已永久删除，不能重新检出旧分支");
      if (fs.existsSync(path.join(target, ".git"))) return target;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const hasHead = await this.git(repo.root, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]).then(
        () => true,
        () => false,
      );
      if (!hasHead) {
        await this.git(repo.root, ["add", "--", "README.md", ".gitattributes"]);
        await this.git(repo.root, [
          "-c",
          "user.name=FRAME",
          "-c",
          "user.email=frame@localhost",
          "commit",
          "-m",
          "Initialize content repository",
        ]);
      }
      const local = await this.git(repo.root, [
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/" + branch,
      ]).then(
        () => true,
        () => false,
      );
      const remote = await this.git(repo.root, [
        "show-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/" + branch,
      ]).then(
        () => true,
        () => false,
      );
      if (local)
        await this.git(repo.root, ["worktree", "add", "--", target, branch]);
      else if (remote)
        await this.git(repo.root, [
          "worktree",
          "add",
          "-b",
          branch,
          "--",
          target,
          "origin/" + branch,
        ]);
      else {
        await this.git(repo.root, [
          "worktree",
          "add",
          "--detach",
          "--no-checkout",
          "--",
          target,
          "HEAD",
        ]);
        await this.git(target, ["switch", "--orphan", branch]);
        fs.writeFileSync(
          path.join(target, ".gitattributes"),
          "*.wav filter=lfs diff=lfs merge=lfs -text\n*.mp4 filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
      }
      return target;
    });
  }
  async isolate(work) {
    const repo = await this.get(work.repo),
      branch = work.branch || "works/" + work.project;
    const target = await this.checkout(
      repo,
      branch,
      path.join(this.data, "works", work.id),
    );
    const source = confined(repo.root, "projects/" + work.project),
      destination = confined(target, "projects/" + work.project);
    if (!work.branch && fs.existsSync(source) && !fs.existsSync(destination))
      await copyTree(source, destination);
    if (!fs.existsSync(path.join(target, "README.md")))
      fs.writeFileSync(
        path.join(target, "README.md"),
        `# ${work.title}\n\nFRAME work branch: ${branch}\n`,
      );
    await this.db.pool.query("UPDATE works SET branch=$2 WHERE id=$1", [
      work.id,
      branch,
    ]);
    return { ...repo, root: target, branch };
  }
  async library(id) {
    const repo = await this.get(id),
      target = await this.checkout(
        repo,
        "frame/materials",
        path.join(this.data, "libraries", id),
      );
    const old = path.join(repo.root, "materials"),
      dest = path.join(target, "materials");
    if (fs.existsSync(old) && !fs.existsSync(dest)) await copyTree(old, dest);
    if (!fs.existsSync(path.join(target, "README.md")))
      fs.writeFileSync(
        path.join(target, "README.md"),
        "# FRAME material library\n",
      );
    return { ...repo, root: target, branch: "frame/materials" };
  }
  async fetchBranches(id) {
    const repo = await this.get(id);
    if (!repo.url) return;
    await this.git(
      repo.root,
      ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      true,
    );
    const refs = await this.git(repo.root, [
      "for-each-ref",
      "--format=%(refname:strip=3)",
      "refs/remotes/origin/works/",
    ]);
    for (const branch of refs.split("\n").filter(Boolean)) {
      const slug = branch.slice("works/".length);
      if (!validProjectId(slug)) continue;
      if (await this.db.setting(purgedWorkKey(id, slug))) continue;
      let work = await this.db.one(
        "SELECT * FROM works WHERE repo=$1 AND branch=$2",
        [id, branch],
      );
      if (work && await this.db.setting("work-purge:" + work.id)) continue;
      if (!work)
        work = await this.db.one(
          "INSERT INTO works(id,repo,project,title,branch) VALUES($1,$2,$3,$3,$4) ON CONFLICT(repo,project) DO UPDATE SET branch=EXCLUDED.branch RETURNING *",
          [randomUUID(), id, slug, branch],
        );
      await this.checkout(repo, branch, path.join(this.data, "works", work.id));
    }
  }
  async writable(id, project = null, { purging = false } = {}) {
    if (!purging && await this.db.one(
      "SELECT w.id FROM works w JOIN settings s ON s.key='work-purge:'||w.id::text WHERE w.repo=$1 AND ($2::text IS NULL OR w.project=$2) LIMIT 1",
      [id, project],
    )) throw problem(409, "作品正在永久清理，请在回收站重试完成清理");
    if (await this.nativeActivity?.(id, project))
      throw problem(409, "Paseo 正在创作或等待响应，请先完成或停止当前作品的创作。");
    const undo = await this.db.one(
      "SELECT u.id FROM work_undos u JOIN works w ON w.id=u.work WHERE w.repo=$1 AND ($2::text IS NULL OR w.project=$2) AND u.state IN ('applying','failed') LIMIT 1", [id, project],
    );
    if (undo) throw Object.assign(problem(409, "作品有尚未完成的撤销，请先在创作结果中重试完成撤销"), { code: "UNDO_RECOVERY_REQUIRED", recovery: "retry-undo" });
    if (
      await this.db.one(
        "SELECT id FROM tasks WHERE repo=$1 AND ($2::text IS NULL OR project=$2) AND state IN ('queued','running','cancelling','publishing','publish_failed') LIMIT 1",
        [id, project],
      )
    )
      throw problem(
        409,
        "作品存在运行中或待恢复的任务，请等待完成、停止执行或恢复发布后再修改",
      );
  }
  async checkpoint(id, project, message, { named = false } = {}) {
    const { repo } = await this.project(id, project, { exists: false });
    // Automatic saves must not overwrite a user's distinct index version.
    const staged = (await this.git(repo.root, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
    if (staged.length) {
      const working = new Set([
        ...(await this.git(repo.root, ["diff", "--name-only", "--no-renames", "-z"])).split("\0"),
        ...(await this.git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
      ]);
      if (staged.some((file) => working.has(file)))
        throw problem(409, "暂存区与工作区存在不同版本，请先在源代码管理中提交或取消暂存，再执行自动保存");
    }
    const tracked = (await this.git(repo.root, ["ls-files", "-z"])).split("\0");
    const files = [
      `projects/${project}`,
      "README.md",
      ".gitattributes",
      ".gitignore",
    ].filter(
      (file) =>
        fs.existsSync(path.join(repo.root, file)) ||
        tracked.some((name) => name === file || name.startsWith(file + "/")),
    );
    if (files.length) await this.git(repo.root, ["add", "--", ...files]);
    const changed = await this.git(repo.root, [
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (changed || named)
      await this.git(repo.root, [
        "-c",
        "user.name=FRAME",
        "-c",
        "user.email=frame@localhost",
        "commit",
        ...(named ? ["--allow-empty"] : []),
        "-m",
        message,
      ]);
    return (await this.git(repo.root, ["rev-parse", "HEAD"])).trim();
  }
  async git(root, args, auth = false) {
    const options = {
      cwd: root,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    };
    if (auth) {
      const repository = /^[0-9a-f-]{36}$/.test(path.basename(root))
        ? await this.db.one(
            "SELECT account FROM repos WHERE id=$1 UNION ALL SELECT r.account FROM repos r JOIN works w ON w.repo=r.id WHERE w.id=$1 LIMIT 1",
            [path.basename(root)],
          )
        : null;
      const account = typeof auth === "string" ? auth : repository?.account;
      const linked = account
        ? await this.db.one("SELECT config FROM github_accounts WHERE id=$1", [
            account,
          ])
        : null;
      const stored = !linked ? await this.db.setting("github") : null;
      const secret = linked
        ? this.secrets.decrypt(linked.config)
        : stored?.encrypted
          ? this.secrets.decrypt(stored.encrypted)
          : {};
      if (secret.token)
        Object.assign(options.env, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0:
            "AUTHORIZATION: basic " +
            Buffer.from("x-access-token:" + secret.token).toString("base64"),
        });
    }
    return command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.file.allow=never",
        ...args,
      ],
      options,
    );
  }
  async add({ name, url = "", branch = "main", account = null }) {
    if (
      !name?.trim() ||
      name.length > 120 ||
      !/^[-\w./]{1,100}$/.test(branch) ||
      branch.startsWith("-") ||
      branch.includes("..")
    )
      throw problem(400, "Invalid repository name or branch");
    if (url) allowedGitUrl(url);
    if (
      account &&
      !(await this.db.one("SELECT id FROM github_accounts WHERE id=$1", [
        account,
      ]))
    )
      throw problem(404, "GitHub account not found");
    if (
      url &&
      (await this.db.one("SELECT id FROM repos WHERE url=$1 AND branch=$2", [
        url,
        branch,
      ]))
    )
      throw problem(409, "这个仓库已经添加");
    const id = randomUUID(),
      root = path.join(this.data, "repos", id);
    fs.mkdirSync(root);
    try {
      const hasRemoteBranches = url
        ? await this.git(
            root,
            ["ls-remote", "--heads", "--", url],
            account || true,
          )
        : "";
      if (url && hasRemoteBranches)
        await this.git(
          root,
          ["clone", "--branch", branch, "--single-branch", "--", url, "."],
          account || true,
        );
      else {
        await this.git(root, ["init", "-b", branch]);
        if (url) await this.git(root, ["remote", "add", "origin", url]);
        fs.writeFileSync(
          path.join(root, "README.md"),
          `# ${name}\n\nFRAME animation projects.\n`,
        );
      }
      if (
        url &&
        (fs.existsSync(path.join(root, "server/app.mjs")) ||
          fs.existsSync(path.join(root, "studio/main.jsx")))
      )
        throw problem(
          400,
          "请选择只存放作品内容的 GitHub 仓库。平台源码仓库不能作为内容库。",
        );
      fs.mkdirSync(path.join(root, "projects"), { recursive: true });
      for (const [key, value] of Object.entries({
        "filter.lfs.clean": "git-lfs clean -- %f",
        "filter.lfs.smudge": "git-lfs smudge -- %f",
        "filter.lfs.process": "git-lfs filter-process",
        "filter.lfs.required": "true",
      }))
        await this.git(root, ["config", "--local", key, value]);
      if (url && hasRemoteBranches)
        await this.git(root, ["lfs", "pull"], account || true);
      const info = path.join(root, ".git/info/exclude");
      fs.appendFileSync(
        info,
        "\nprojects/*/exports/\nprojects/*/.cache/\nprojects/*/.history/\n.env\n.frame/\n",
      );
      if (!fs.existsSync(path.join(root, ".gitattributes")))
        fs.writeFileSync(
          path.join(root, ".gitattributes"),
          "*.wav filter=lfs diff=lfs merge=lfs -text\n*.mp4 filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
      await this.db.pool.query(
        "INSERT INTO repos(id,name,url,branch,account) VALUES($1,$2,$3,$4,$5)",
        [id, name, url, branch, account],
      );
      await this.fetchBranches(id);
      return this.get(id);
    } catch (e) {
      await this.db.pool
        .query(
          "DELETE FROM repos WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM works WHERE repo=$1)",
          [id],
        )
        .catch(() => {});
      if (!(await this.db.one("SELECT id FROM repos WHERE id=$1", [id])))
        fs.rmSync(root, { recursive: true, force: true });
      throw e;
    }
  }
  async list(id = null, projectId = null) {
    const rows = await this.db.all(
      "SELECT * FROM repos WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created",
      [id],
    );
    for (const row of rows) {
      row.projects = [];
      row.errors = [];
      const base = path.join(this.data, "repos", row.id, "projects");
      const indexed = await this.db.all(
        "SELECT id,project,branch FROM works WHERE repo=$1",
        [row.id],
      );
      const projects = new Set([
        ...(fs.existsSync(base) ? fs.readdirSync(base) : []),
        ...indexed.map((w) => w.project),
      ]);
      const purged = new Set((await this.db.all(
        "SELECT key FROM settings WHERE key LIKE $1", ["purged-work:" + row.id + ":%"],
      )).map(item => item.key));
      const purging = new Set((await this.db.all(
        "SELECT value FROM settings WHERE key LIKE 'work-purge:%' AND value->>'repo'=$1", [row.id],
      )).map(item => item.value.project));
      for (const id of projects) {
        if (projectId && id !== projectId) continue;
        if (!validProjectId(id)) continue;
        if (purged.has(purgedWorkKey(row.id, id)) || purging.has(id)) continue;
        try {
          const indexedWork = indexed.find((w) => w.project === id && w.branch);
          const file = indexedWork
            ? confined(
                path.join(this.data, "works", indexedWork.id),
                "projects/" + id + "/project.ts",
              )
            : confined(base, id + "/project.ts");
          if (!fs.existsSync(file)) continue;
          const { meta } = readProject(file);
          row.projects.push({
            id,
            title: meta.title,
            duration: meta.duration,
            fps: meta.fps,
            renderer: meta.renderer,
          });
        } catch (e) {
          row.errors.push({ id, error: e.message });
        }
      }
    }
    return rows;
  }
  async status(id, { fetch = false, work = null, prune = false } = {}) {
    const w = work
      ? await this.db.one("SELECT * FROM works WHERE id=$1 AND repo=$2", [
          work,
          id,
        ])
      : null;
    if (work && !w) throw problem(404, "Work not found");
    const r = w
      ? (await this.project(id, w.project, { exists: false })).repo
      : await this.library(id);
    let checked = (w || r).sync_state?.checked || null,
      error = fetch ? null : (w || r).sync_state?.error || null;
    if (fetch && r.url) {
      try {
        await this.git(
          r.root,
          [
            "fetch",
            ...(prune ? ["--prune"] : []),
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
          ],
          true,
        );
        checked = new Date().toISOString();
      } catch {
        error = "无法刷新远端，请检查网络或重新登录 GitHub；以下为上次已知状态";
      }
    }
    const changes = await this.git(r.root, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
    const paths = [];
    const entries = changes.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.startsWith("? ")) paths.push(entry.slice(2));
      else if (entry.startsWith("1 "))
        paths.push(entry.split(" ").slice(8).join(" "));
      else if (entry.startsWith("2 ")) {
        paths.push(entry.split(" ").slice(9).join(" "));
        paths.push(entries[++i]);
      } else if (entry.startsWith("u "))
        paths.push(entry.split(" ").slice(10).join(" "));
    }
    let ahead = 0,
      behind = 0,
      remoteExists = false;
    const works = {};
    const item = (slug) => (works[slug] ||= { dirty: 0, ahead: 0, behind: 0 });
    for (const file of paths) {
      const match = /^projects\/([^/]+)\//.exec(file);
      if (match) item(match[1]).dirty++;
    }
    if (r.url) {
      remoteExists = await this.git(r.root, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${r.branch}`,
      ]).then(
        () => true,
        () => false,
      );
      if (remoteExists) {
        const counts = await this.git(r.root, [
          "rev-list",
          "--left-right",
          "--count",
          `HEAD...origin/${r.branch}`,
        ]).catch(() => "0 0");
        [ahead, behind] = counts.split(/\s+/).map(Number);
        for (const [direction, revision] of [
          ["ahead", `origin/${r.branch}..HEAD`],
          ["behind", `HEAD..origin/${r.branch}`],
        ]) {
          if (!(direction === "ahead" ? ahead : behind)) continue;
          const commits = await this.git(r.root, [
            "log",
            "--format=__FRAME_COMMIT__%H",
            "--name-only",
            revision,
            "--",
            "projects",
          ]);
          for (const commit of commits.split("__FRAME_COMMIT__").slice(1)) {
            const slugs = new Set(
              commit
                .split("\n")
                .map((line) => /^projects\/([^/]+)\//.exec(line)?.[1])
                .filter(Boolean),
            );
            for (const slug of slugs) item(slug)[direction]++;
          }
        }
      } else
        ahead = Number(
          await this.git(r.root, ["rev-list", "--count", "HEAD"]).catch(
            () => "0",
          ),
        );
    }
    const state = {
      ahead,
      behind,
      dirty: paths.length,
      works,
      checked,
      error,
      remote: r.url,
      remoteExists,
      branch: r.branch,
      scope: w ? "work" : "materials",
    };
    await this.db.pool.query(
      w
        ? "UPDATE works SET sync_state=$2 WHERE id=$1 AND sync_state IS DISTINCT FROM $2::jsonb"
        : "UPDATE repos SET sync_state=$2 WHERE id=$1 AND sync_state IS DISTINCT FROM $2::jsonb",
      [w?.id || id, state],
    );
    return state;
  }
  async sync(id, action, message, work = null) {
    const w = work
      ? await this.db.one("SELECT * FROM works WHERE id=$1 AND repo=$2", [
          work,
          id,
        ])
      : null;
    if (work && !w) throw problem(404, "Work not found");
    const result = await this.db.lock(
      w ? `${id}:${w.project}` : `${id}:materials`,
      async () => {
        if (w) await this.writable(id, w.project);
        const r = w
          ? (await this.project(id, w.project, { exists: false })).repo
          : await this.library(id);
        if (action === "fetch") return this.status(id, { fetch: true, work });
        if (action === "pull") {
          if (await this.git(r.root, ["status", "--porcelain"]))
            throw problem(
              409,
              "当前分支有本地修改，请先保存并推送，再拉取远端修改",
            );
          if (w) await this.revisions.invalidate(id, w.project);
          await this.git(
            r.root,
            ["pull", "--ff-only", "origin", r.branch],
            true,
          );
          await this.git(r.root, ["lfs", "pull"], true);
        } else if (
          action === "commit" ||
          (action === "push" &&
            (await this.git(r.root, ["status", "--porcelain"])))
        ) {
          if (action === "push")
            message ||= w ? "Save work: " + w.title : "Update material library";
          if (!message?.trim()) throw problem(400, "Commit message required");
          const files = [
            "projects",
            "materials",
            "README.md",
            ".gitattributes",
            ".gitignore",
          ].filter((f) => fs.existsSync(path.join(r.root, f)));
          await this.git(r.root, ["add", "--", ...files]);
          await this.git(r.root, [
            "-c",
            "user.name=FRAME",
            "-c",
            "user.email=frame@localhost",
            "commit",
            "-m",
            message,
          ]);
        }
        if (action === "push") {
          if (!r.url) throw problem(400, "No remote configured");
          await this.git(r.root, ["lfs", "push", "origin", r.branch], true);
          await this.git(r.root, ["push", "origin", r.branch], true);
        } else if (!["pull", "commit"].includes(action))
          throw problem(400, "Invalid Git action");
        return this.status(id, { fetch: false, work });
      },
    );
    if (action === "pull") await this.onChange?.(id, w?.project);
    return result;
  }
}
