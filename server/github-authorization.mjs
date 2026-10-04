import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { command } from "./process.mjs";
import { problem } from "./security.mjs";

/** Browser GitHub device flow remains independent of native model accounts. */
export class GitHubAuthorization {
  constructor({ db, data, github }) { Object.assign(this, { db, data, github }); this.children = new Map(); }
  async begin(kind, target) {
    if (kind !== "github") throw problem(400, "模型账号请在原生工作台设置中登录");
    return this.db.lock("github-login:" + (target || "new"), async () => {
      const pending = await this.db.one("SELECT * FROM auth_flows WHERE kind='github' AND target IS NOT DISTINCT FROM $1 AND state='pending' AND expires>now()", [target || null]);
      if (pending) return pending;
      const id = randomUUID(), root = path.join(this.data, "auth", id);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const env = { ...process.env, GH_CONFIG_DIR: root, GH_PROMPT_DISABLED: "1", GH_BROWSER: "/bin/true", BROWSER: "/bin/true", NO_COLOR: "1", FORCE_COLOR: "0" };
      delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
      await this.db.pool.query("INSERT INTO auth_flows(id,target,kind,expires) VALUES($1,$2,'github',now()+interval '15 minutes')", [id, target || null]);
      const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.children.set(id, child); let output = "", saving = Promise.resolve(), finished = false;
      const inspect = chunk => {
        output = (output + chunk.toString()).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").slice(-16000);
        const url = [...output.matchAll(/https:\/\/github\.com\/[^\s<>"\x1b]+/g)].map(match => match[0])[0];
        const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
        saving = saving.then(() => this.db.pool.query("UPDATE auth_flows SET info=$2 WHERE id=$1 AND state='pending'", [id,
          { url, code, needsCode: false, message: "打开 GitHub 页面完成授权；此页面会自动更新。" }])).catch(() => {});
      };
      child.stdout.on("data", inspect); child.stderr.on("data", inspect);
      const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000); timer.unref();
      const finish = async code => {
        if (finished) return; finished = true; clearTimeout(timer); this.children.delete(id); await saving;
        try {
          if (code !== 0) throw Error("授权未完成或已过期，请重新登录");
          const token = await command("gh", ["auth", "token", "--hostname", "github.com"], { env });
          const linked = await this.github.connect(token, target);
          await this.db.pool.query("UPDATE auth_flows SET state='succeeded',target=$2,info='{}' WHERE id=$1", [id, linked.id]);
        } catch (error) { await this.db.pool.query("UPDATE auth_flows SET state='failed',info=$2 WHERE id=$1", [id, { message: error.message }]); }
        finally { fs.rmSync(root, { recursive: true, force: true }); }
      };
      child.once("error", () => void finish(1).catch(() => {})); child.once("close", code => void finish(code).catch(() => {}));
      child.stdin.on("error", () => {}); child.stdin.write("\n"); return this.flow(id);
    });
  }
  async flow(id) {
    const row = await this.db.one("SELECT * FROM auth_flows WHERE id=$1 AND kind='github'", [id]);
    if (!row) throw problem(404, "GitHub 登录不存在");
    if (row.state === "pending" && new Date(row.expires).getTime() <= Date.now()) {
      this.children.get(id)?.kill("SIGTERM"); row.state = "expired";
      await this.db.pool.query("UPDATE auth_flows SET state='expired',info='{}' WHERE id=$1", [id]);
    }
    return row;
  }
  close() { for (const child of this.children.values()) child.kill("SIGTERM"); this.children.clear(); }
}
