import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";

const SHOT = { spec: "abt-scene/0.1", meta: { name: "s1", fps: 24, frames: [1, 48], resolution: [1920, 1080] }, objects: [] };
const hash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Stands in for the AB to T add-on in Blender: the same HTTP protocol (pair, long-poll, results,
 * files, saves), answering the jobs with `handle`.
 */
class FakeBlender {
  constructor(base) {
    this.base = base;
    this.token = null;
    this.state = {};
    this.jobs = [];
    this.handle = async () => ({});
  }
  async request(method, route, body) {
    const response = await fetch(this.base + route, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: response.status, data, headers: response.headers };
  }
  post(route, body = {}) {
    return this.request("POST", route, body);
  }
  /** Poll until stopped, answering each job. */
  serve() {
    this.running = true;
    let hello = true;
    const loop = async () => {
      while (this.running) {
        const { status, data } = await this.post("/api/blender-link/poll", { protocol: 1, name: "测试 Blender", state: this.state, hello });
        hello = false;
        if (status !== 200) {
          this.refused = data.error;
          this.running = false;
          return;
        }
        for (const job of data.jobs) {
          this.jobs.push(job);
          try {
            await this.post("/api/blender-link/result", { id: job.id, ok: true, data: await this.handle(job) });
          } catch (error) {
            await this.post("/api/blender-link/result", { id: job.id, ok: false, error: error.message, code: error.code });
          }
        }
      }
    };
    this.loop = loop();
  }
}

describe("Blender on the user's computer through the AB to T add-on", () => {
  let app, base, work, other, blender, shotFile;
  const call = (name, args, scope = {}) => app.services.tools.call(name, args, { session: "s1", work: work.id, repo: work.repo, agent: true, ...scope });
  const api = async (url, init = {}) => (await fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } })).json();

  beforeAll(async () => {
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-blender-")), FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.open((await app.services.works.create({ title: "三维镜头" })).id, "local");
    other = await app.services.works.create({ title: "另一个作品" });
    shotFile = path.join(work.dir, "abt", "s1.json");
    fs.mkdirSync(path.dirname(shotFile), { recursive: true });
    fs.writeFileSync(shotFile, JSON.stringify(SHOT));
    blender = new FakeBlender(base);
  });
  afterAll(async () => {
    blender.running = false;
    await app?.close();
  });

  it("tells the AI how to link one before there is any", async () => {
    const status = await call("blender_status", {});
    expect(status.data.online).toBe(false);
    expect(status.text).toMatch(/「Blender」选项卡/);
    await expect(call("blender_run", { code: "print(1)" })).rejects.toMatchObject({ code: "OFFLINE" });
  });

  it("pairs with a code made in the repository's Blender tab; the token is for the link only", async () => {
    expect((await blender.post("/api/blender-link/pair", { protocol: 1, code: "WRONGONE" })).data.error.code).toBe("BAD_CODE");
    const made = await api(`/api/blender/${work.repo}/pair`, { method: "POST" });
    expect(made.link).toBe(`${made.server}#${made.code}`);
    expect((await blender.post("/api/blender-link/pair", { protocol: 2, code: made.code })).data.error.code).toBe("VERSION");
    const paired = await blender.post("/api/blender-link/pair", { protocol: 1, code: made.code, name: "测试 Blender" });
    expect(paired.data).toMatchObject({ repos: [{ id: "local", title: "本地" }] });
    expect(paired.data.token).toMatch(/^fl_/);
    blender.token = paired.data.token;
    // Used up.
    expect((await new FakeBlender(base).post("/api/blender-link/pair", { protocol: 1, code: made.code })).data.error.code).toBe("BAD_CODE");
    // Not a key to anything else, and nothing without it.
    expect((await fetch(`${base}/api/tools`, { headers: { Authorization: "Bearer " + blender.token } })).status).toBe(401);
    expect((await new FakeBlender(base).post("/api/blender-link/poll", { protocol: 1 })).data.error.code).toBe("UNPAIRED");

    blender.state = { blender: "5.2.3", addon: "0.6.0", file: null, shot: null, live: false, activity: [] };
    blender.serve();
    await expect.poll(() => app.services.blenders.connection(work.repo)?.state?.addon).toBe("0.6.0");
    expect((await api(`/api/blender/${work.repo}?work=${work.id}`)).links).toMatchObject([{ name: "测试 Blender", online: true }]);
    expect((await api(`/api/blender/${work.repo}?work=${work.id}`)).shots).toEqual(["abt/s1.json"]);
    expect((await call("blender_status", {})).text).toMatch(/连着（测试 Blender，AB to T 0.6.0）/);
  });

  it("serves the shot's own files and nothing outside the work", async () => {
    const ref = `${work.repo}/${work.id}`;
    const file = await blender.request("GET", `/api/blender-link/file?work=${ref}&path=projects/${work.slug}/abt/s1.json`);
    expect(file.status).toBe(200);
    expect(file.data).toEqual(SHOT);
    expect((await blender.request("GET", `/api/blender-link/file?work=${ref}&path=projects/${work.slug}/../../.git/config`)).status).toBe(403);
    expect((await blender.request("GET", `/api/blender-link/file?work=${ref}&path=../../settings.json`)).status).toBe(400);
    expect((await blender.request("GET", `/api/blender-link/file?work=elsewhere/${work.id}&path=projects/${work.slug}/abt/s1.json`)).status).toBe(403);
  });

  it("opens a shot there, runs code and draws a frame for the AI", async () => {
    blender.handle = async (job) => {
      if (job.op === "open") {
        blender.state = { ...blender.state, shot: { work: job.args.work, path: job.args.path }, live: true };
        await blender.post("/api/blender-link/state", { state: blender.state });
        return { mode: "import", message: "已导入到 Blender，实时同步已开启。" };
      }
      if (job.op === "run") {
        if (job.args.code.includes("raise")) throw Object.assign(new Error("Traceback…\nValueError: boom"), { code: "PYTHON" });
        return { output: "radius 6.5\n" };
      }
      if (job.op === "view") {
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
        return { image: png, width: 1, height: 1, frame: job.args.frame ?? 1, engine: "BLENDER_EEVEE" };
      }
    };
    const opened = await call("blender_open", { shot: "s1" });
    expect(opened.text).toMatch(/已导入/);
    expect(blender.jobs.at(-1)).toMatchObject({
      op: "open",
      args: { work: `${work.repo}/${work.id}`, path: `projects/${work.slug}/abt/s1.json`, reimport: false },
    });
    await expect(call("blender_open", { shot: "abt/none.json" })).rejects.toMatchObject({ status: 404 });
    await expect.poll(() => app.services.blenders.connection(work.repo).state.shot?.path).toBe(`projects/${work.slug}/abt/s1.json`);

    expect((await call("blender_run", { code: "print(1)" })).text).toBe("radius 6.5\n");
    await expect(call("blender_run", { code: "raise ValueError('boom')" })).rejects.toThrow(/ValueError: boom/);
    const view = await call("blender_view", { what: "render", frame: 12 });
    expect(view.text).toMatch(/第 12 帧，渲染/);
    expect(view.images[0].mimeType).toBe("image/jpeg");

    // Code for another work of the repository waits until that work's shot is open there.
    await expect(call("blender_run", { code: "print(1)" }, { work: other.id })).rejects.toMatchObject({ code: "OTHER_WORK" });
    // A read-only grant never reaches the user's computer.
    await expect(call("blender_view", {}, { readOnly: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("takes the shot back from Blender unless it changed elsewhere since", async () => {
    const ref = `${work.repo}/${work.id}`;
    const relative = `projects/${work.slug}/abt/s1.json`;
    const base0 = hash(fs.readFileSync(shotFile, "utf8"));
    const tweaked = JSON.stringify({ ...SHOT, objects: [{ id: "cam", type: "camera" }] });
    const saved = await blender.post("/api/blender-link/save", { work: ref, path: relative, content: tweaked, base: base0 });
    expect(saved.data.hash).toBe(hash(tweaked));
    expect(fs.readFileSync(shotFile, "utf8")).toBe(tweaked);

    // Someone else changed it: Blender's write is refused, then taken when the user chooses Blender's.
    fs.writeFileSync(shotFile, JSON.stringify({ ...SHOT, objects: [] }));
    const late = await blender.post("/api/blender-link/save", { work: ref, path: relative, content: tweaked, base: saved.data.hash });
    expect(late.status).toBe(409);
    expect(late.data.error.code).toBe("CONFLICT");
    expect((await blender.post("/api/blender-link/save", { work: ref, path: relative, content: tweaked, force: true })).status).toBe(200);

    // Only shots, and valid JSON.
    expect((await blender.post("/api/blender-link/save", { work: ref, path: `projects/${work.slug}/project.ts`, content: "x", force: true })).status).toBe(403);
    expect((await blender.post("/api/blender-link/save", { work: ref, path: relative, content: "{", force: true })).status).toBe(400);
  });

  it("stops working once the user unlinks it", async () => {
    const [link] = (await api(`/api/blender/${work.repo}`)).links;
    await api(`/api/blender/${work.repo}/links/${link.id}`, { method: "DELETE" });
    await expect.poll(() => blender.refused?.code, { timeout: 30000 }).toBe("UNPAIRED");
    expect((await api(`/api/blender/${work.repo}`)).links).toEqual([]);
    await expect(call("blender_status", {})).resolves.toMatchObject({ data: { online: false } });
  });
});
