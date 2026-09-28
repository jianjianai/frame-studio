import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem, confined } from "./security.mjs";

export class GitHub {
  constructor(db, secrets, repos, data) {
    Object.assign(this, { db, secrets, repos, data });
  }
  async request(account, endpoint, options = {}) {
    const row =
      typeof account === "string"
        ? await this.db.one("SELECT * FROM github_accounts WHERE id=$1", [
            account,
          ])
        : account;
    if (!row) throw problem(404, "GitHub account not found");
    const { token } = this.secrets.decrypt(row.config);
    const response = await fetch("https://api.github.com" + endpoint, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(120000),
    });
    if (response.status === 404 && options.allow404) return null;
    if (!response.ok) {
      if (response.status === 401 && row.id)
        await this.db.pool.query(
          "UPDATE github_accounts SET state='expired',checked=now() WHERE id=$1",
          [row.id],
        );
      throw problem(
        response.status === 401 ? 409 : 502,
        response.status === 401
          ? "GitHub 登录已过期，请重新登录"
          : `GitHub 请求失败 (${response.status})：${(await response.json().catch(() => ({}))).message || "请检查仓库权限或稍后重试"}`,
      );
    }
    return response.status === 204 ? {} : response.json();
  }
  async connect(token, expected) {
    const account = { config: this.secrets.encrypt({ token }) };
    const user = await this.request(account, "/user");
    const old = expected
      ? await this.db.one("SELECT * FROM github_accounts WHERE id=$1", [
          expected,
        ])
      : null;
    if (old && old.login !== user.login)
      throw problem(
        409,
        `请登录原账号 ${old.login}；添加其他账号请使用新增账号入口`,
      );
    return this.db.one(
      `INSERT INTO github_accounts(id,login,config,state,checked) VALUES($1,$2,$3,'ready',now())
      ON CONFLICT(login) DO UPDATE SET config=$3,state='ready',checked=now() RETURNING id,login,state,checked`,
      [old?.id || randomUUID(), user.login, account.config],
    );
  }
  async list() {
    return this.db.all(
      "SELECT id,login,state,checked,created FROM github_accounts ORDER BY login",
    );
  }
  async migrate() {
    if (await this.db.one("SELECT id FROM github_accounts LIMIT 1")) return;
    const stored = await this.db.setting("github");
    if (!stored?.encrypted) return;
    const { token } = this.secrets.decrypt(stored.encrypted);
    if (!token) return;
    try {
      const account = await this.connect(token);
      await this.db.pool.query(
        "UPDATE repos SET account=$1 WHERE account IS NULL",
        [account.id],
      );
    } catch {
      /* Existing Git credentials remain available until the owner reconnects. */
    }
  }
  async remoteRepos(account, page = 1) {
    return (
      await this.request(
        account,
        `/user/repos?per_page=30&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      )
    ).map((r) => ({
      name: r.full_name,
      url: r.clone_url,
      branch: r.default_branch,
      private: r.private,
      description: r.description,
    }));
  }
  async create(account, name, description = "", privateRepo = true) {
    if (!/^[\w.-]{1,100}$/.test(name))
      throw problem(400, "Invalid repository name");
    const remote = await this.request(account, "/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        private: privateRepo,
        auto_init: true,
      }),
    });
    try {
      return await this.repos.add({
        name: remote.full_name,
        url: remote.clone_url,
        branch: remote.default_branch,
        account,
      });
    } catch (e) {
      throw problem(
        502,
        `GitHub 仓库已创建：${remote.html_url}。本地添加失败，请使用“添加现有仓库”重试。${e.message}`,
      );
    }
  }
  async release({ task, artifact, tag, title, notes = "" }) {
    const t = await this.db.one("SELECT * FROM tasks WHERE id=$1", [task]);
    if (
      !t ||
      t.state !== "succeeded" ||
      t.cleaned ||
      !t.result?.artifacts?.some((a) => a.path === artifact)
    )
      throw problem(404, "Export unavailable or expired");
    if (!/\.(mp4|webm)$/i.test(artifact))
      throw problem(400, "Choose a video export");
    const repo = await this.repos.get(t.repo);
    const work = await this.db.one(
      "SELECT * FROM works WHERE repo=$1 AND project=$2",
      [t.repo, t.project],
    );
    if (!work?.branch) throw problem(409, "作品分支尚未准备完成");
    if (!t.source_commit)
      throw problem(409, "此旧导出缺少版本标识，请重新导出后发布");
    if (
      tag.includes("..") ||
      tag.endsWith("/") ||
      tag.includes("//") ||
      tag.endsWith(".lock")
    )
      throw problem(400, "Invalid release tag");
    const match =
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
        repo.url,
      );
    if (!match || !repo.account)
      throw problem(409, "请为作品仓库连接 GitHub 账号");
    return this.db.lock(`artifact:${task}`, async () => {
      const file = confined(path.join(this.data, "runs", task), artifact);
      if (!fs.existsSync(file)) throw problem(410, "Export expired");
      const base = `/repos/${match[1]}/${match[2]}`;
      let release = await this.request(
        repo.account,
        base + "/releases/tags/" + encodeURIComponent(tag),
        { allow404: true },
      );
      if (!release) {
        const status = await this.repos.status(repo.id, {
          work: work.id,
          fetch: true,
        });
        if (
          status.error ||
          !status.remoteExists ||
          !(await this.repos
            .git((await this.repos.project(repo.id, work.project)).repo.root, [
              "merge-base",
              "--is-ancestor",
              t.source_commit,
              "origin/" + work.branch,
            ])
            .then(
              () => true,
              () => false,
            ))
        )
          throw problem(409, "请先同步当前作品分支，再发布视频");
        release = await this.request(repo.account, base + "/releases", {
          method: "POST",
          body: JSON.stringify({
            tag_name: tag,
            name: title,
            body: notes,
            target_commitish: t.source_commit,
          }),
        });
      }
      const account = await this.db.one(
        "SELECT * FROM github_accounts WHERE id=$1",
        [repo.account],
      );
      const token = this.secrets.decrypt(account.config).token;
      const upload = new URL(release.upload_url.replace(/\{.*$/, ""));
      if (
        upload.hostname !== "uploads.github.com" ||
        upload.protocol !== "https:"
      )
        throw problem(502, "Unexpected GitHub upload URL");
      const name = `${work.project}-${task.slice(0, 8)}-${path.basename(file)}`;
      upload.searchParams.set("name", name);
      if (
        !release.assets?.some(
          (a) =>
            a.name === name &&
            a.state === "uploaded" &&
            a.size === fs.statSync(file).size,
        )
      ) {
        const response = await fetch(upload, {
          method: "POST",
          body: fs.createReadStream(file),
          duplex: "half",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": artifact.endsWith(".webm")
              ? "video/webm"
              : "video/mp4",
            "Content-Length": String(fs.statSync(file).size),
          },
          signal: AbortSignal.timeout(20 * 60000),
        });
        if (!response.ok)
          throw problem(
            502,
            `Release 已创建 ${release.html_url}，文件上传失败 (${response.status})，可用相同标签重试`,
          );
      }
      const result = {
        ...t.result,
        releases: [
          ...(t.result.releases || []).filter(
            (r) => r.artifact !== artifact || r.tag !== tag,
          ),
          { url: release.html_url, artifact, tag },
        ],
      };
      await this.db.pool.query("UPDATE tasks SET result=$2 WHERE id=$1", [
        task,
        result,
      ]);
      return { url: release.html_url };
    });
  }
}
