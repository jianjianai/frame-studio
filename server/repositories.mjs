import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "./process.mjs";
import { allowedGitUrl, confined, problem } from "./security.mjs";
import { validProjectId, readProject } from "../scripts/project-metadata.mjs";
export class Repositories {
  constructor(db, data, secrets) {
    this.db = db;
    this.data = data;
    this.secrets = secrets;
    fs.mkdirSync(path.join(data, "repos"), { recursive: true });
  }
  async get(id) {
    const row = await this.db.one("SELECT * FROM repos WHERE id=$1", [id]);
    if (!row) throw problem(404, "Repository not found");
    return { ...row, root: path.join(this.data, "repos", row.id) };
  }
  async project(repo, id, { exists = true } = {}) {
    if (!validProjectId(id)) throw problem(400, "Invalid project id");
    const r = await this.get(repo),
      dir = confined(r.root, "projects/" + id);
    if (exists && !fs.existsSync(path.join(dir, "project.ts")))
      throw problem(404, "Project not found");
    return { repo: r, dir };
  }
  async writable(id) {
    if (
      await this.db.one(
        "SELECT id FROM tasks WHERE repo=$1 AND state IN ('queued','running','cancelling') LIMIT 1",
        [id],
      )
    )
      throw problem(409, "Repository has an active task");
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
      const stored = await this.db.setting("github");
      const secret = stored?.encrypted
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
  async add({ name, url = "", branch = "main" }) {
    if (
      !name?.trim() ||
      name.length > 120 ||
      !/^[-\w./]{1,100}$/.test(branch) ||
      branch.startsWith("-") ||
      branch.includes("..")
    )
      throw problem(400, "Invalid repository name or branch");
    if (url) allowedGitUrl(url);
    const id = randomUUID(),
      root = path.join(this.data, "repos", id);
    fs.mkdirSync(root);
    try {
      if (url)
        await this.git(
          root,
          ["clone", "--branch", branch, "--single-branch", "--", url, "."],
          true,
        );
      else {
        await this.git(root, ["init", "-b", branch]);
        fs.writeFileSync(
          path.join(root, "README.md"),
          `# ${name}\n\nFRAME animation projects.\n`,
        );
      }
      fs.mkdirSync(path.join(root, "projects"), { recursive: true });
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
        "INSERT INTO repos(id,name,url,branch) VALUES($1,$2,$3,$4)",
        [id, name, url, branch],
      );
      return this.get(id);
    } catch (e) {
      fs.rmSync(root, { recursive: true, force: true });
      throw e;
    }
  }
  async list() {
    const rows = await this.db.all("SELECT * FROM repos ORDER BY created");
    for (const row of rows) {
      row.projects = [];
      row.errors = [];
      const base = path.join(this.data, "repos", row.id, "projects");
      if (fs.existsSync(base))
        for (const id of fs.readdirSync(base)) {
          if (!validProjectId(id)) continue;
          try {
            const file = confined(base, id + "/project.ts");
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
  async status(id) {
    const r = await this.get(id);
    return {
      changes: await this.git(r.root, ["status", "--short"]),
      branch: await this.git(r.root, ["branch", "--show-current"]),
      history: await this.git(r.root, ["log", "-8", "--oneline"]).catch(
        () => "",
      ),
      diff: await this.git(r.root, ["diff", "--", "projects"]),
      remote: r.url,
    };
  }
  async sync(id, action, message) {
    return this.db.lock(id, async () => {
      await this.writable(id);
      const r = await this.get(id);
      if (action === "fetch")
        return { output: await this.git(r.root, ["fetch", "origin"], true) };
      if (action === "pull") {
        if (await this.git(r.root, ["status", "--porcelain"]))
          throw problem(409, "Commit local changes before pulling");
        await this.git(r.root, ["pull", "--ff-only", "origin", r.branch], true);
        await this.git(r.root, ["lfs", "pull"], true);
      } else if (action === "commit") {
        if (!message?.trim()) throw problem(400, "Commit message required");
        const files = [
          "projects",
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
      } else if (action === "push") {
        if (!r.url) throw problem(400, "No remote configured");
        await this.git(r.root, ["lfs", "push", "origin", r.branch], true);
        await this.git(r.root, ["push", "origin", r.branch], true);
      } else if (action !== "pull") throw problem(400, "Invalid Git action");
      return this.status(id);
    });
  }
}
