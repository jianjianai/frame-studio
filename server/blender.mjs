import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { problem, notFound, sha256, confined, inside } from "./util.mjs";
import { readJson, sendFile } from "./http.mjs";
import { writeText, TEXT_LIMIT } from "./files.mjs";
import { studioOrigin } from "./browser-extension.mjs";
import { registerBlenderTools, shotPath } from "./tools/blender-tools.mjs";

/** What the AB to T add-on and this server speak; an add-on of another version is told to update. */
export const LINK_PROTOCOL = 1;
/** The first AB to T release that can link to FRAME (shown to the user). */
export const ADDON_VERSION = "0.6.0";
const PAIR_MS = 10 * 60 * 1000;
/** A poll waits this long for work; Cloudflare cuts requests at 100 s. */
const POLL_MS = 25 * 1000;
/** No poll for this long: that Blender is closed, or its link switched off (a live add-on polls again at once). */
const OFFLINE_MS = 15 * 1000;
/** A request no poll took in this long went to a Blender that is gone. */
const PICKUP_MS = 15 * 1000;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** The only files Blender writes back: AB to T shots. */
const SHOT = /^projects\/[^/]+\/abt\/[^/]+\.json$/;

/**
 * Blender on the user's computer, linked through the AB to T add-on. A pairing code made in a
 * repository's Blender tab links that Blender to the repository; the add-on then long-polls
 * `/api/blender-link/poll` with its own token (no session) and runs what the blender_* tools ask:
 * open a shot of a work (it keeps a copy of the shot and the files it uses on that computer),
 * run Python, draw a frame. What the user tweaks there comes back as the shot's JSON.
 */
export class Blenders {
  constructor(services) {
    this.services = services;
    /** code → { repo, expires } */
    this.codes = new Map();
    /** link id → Live: the Blender polling now (or a moment ago). */
    this.live = new Map();
    this.sweep = setInterval(() => this.expire(), 10000);
  }

  list() {
    return this.services.settings.get("blenderLinks") ?? [];
  }
  save(list) {
    this.services.settings.update("blenderLinks", list);
  }

  pairCode(repo) {
    this.services.repos.get(repo);
    const now = Date.now();
    for (const [code, item] of this.codes) if (item.expires < now) this.codes.delete(code);
    const code = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
    this.codes.set(code, { repo, expires: now + PAIR_MS });
    return { code, expires: new Date(now + PAIR_MS).toISOString() };
  }

  /** The Blenders linked to a repository, for its Blender tab. */
  links(repo) {
    return this.list()
      .filter((link) => link.repos.includes(repo))
      .map((link) => {
        const live = this.live.get(link.id);
        const online = Boolean(live?.online());
        return { id: link.id, name: link.name, online, lastSeen: link.lastSeen ?? null, repos: link.repos.length, state: online ? live.state : null };
      });
  }

  emit(repo) {
    this.services.events.emit({ type: "blender", repo, links: this.links(repo) });
  }
  emitLink(link) {
    for (const repo of link.repos) this.emit(repo);
  }

  unlink(linkId, repo) {
    const list = this.list();
    const link = list.find((item) => item.id === linkId && item.repos.includes(repo));
    if (!link) throw notFound("这个 Blender 没有连接这个作品库");
    link.repos = link.repos.filter((item) => item !== repo);
    this.save(link.repos.length ? list : list.filter((item) => item !== link));
    const live = this.live.get(linkId);
    if (live) {
      live.link = link;
      if (!link.repos.length) live.drop("UNPAIRED");
    }
    this.emit(repo);
    return { ok: true };
  }

  forget(repo) {
    for (const link of this.list()) if (link.repos.includes(repo)) this.unlink(link.id, repo);
  }

  /** The online Blender a repository's AI uses: of several, the one used last. */
  connection(repo) {
    const linked = new Set(
      this.list()
        .filter((link) => link.repos.includes(repo))
        .map((link) => link.id),
    );
    // One that is polling right now first, then the one used last.
    return (
      [...this.live.values()]
        .filter((live) => linked.has(live.link.id) && live.online())
        .sort((a, b) => Number(Boolean(b.waiter)) - Number(Boolean(a.waiter)) || b.active - a.active)[0] ?? null
    );
  }

  /** The connection, or why there is none (for the AI to tell the user). */
  require(repo) {
    const live = this.connection(repo);
    if (live) return live;
    const paired = this.list().some((link) => link.repos.includes(repo));
    throw problem(
      409,
      paired
        ? "用户电脑上的 Blender 没有连着 FRAME：请用户打开 Blender（装了 AB to T 插件），在 3D 视图侧边栏 AB to T →「FRAME」里打开连接"
        : `这个作品库还没有连接 Blender：请用户在 FRAME 的「Blender」选项卡（素材视图顶部的立方体按钮）里生成连接码，在 Blender 的 AB to T 插件（${ADDON_VERSION} 起）侧边栏里点「连接 FRAME」粘贴`,
      "OFFLINE",
    );
  }

  /** Links that stopped polling go offline (once). */
  expire() {
    for (const live of this.live.values()) {
      if (live.online() || live.reported === false) continue;
      live.reported = false;
      this.touch(live.link.id);
      this.emitLink(live.link);
    }
  }
  touch(linkId) {
    const list = this.list();
    const link = list.find((item) => item.id === linkId);
    if (!link) return;
    link.lastSeen = new Date().toISOString();
    this.save(list);
  }

  close() {
    clearInterval(this.sweep);
    for (const live of this.live.values()) live.drop("CLOSING");
  }

  // ---- the add-on's side ----------------------------------------------------------------------

  /** The link a request's bearer token belongs to. */
  identify(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const link = token ? this.list().find((item) => verify(token, item.hash)) : null;
    if (!link) throw problem(401, "这个 Blender 的配对已经失效：在 FRAME 的「Blender」选项卡里重新生成连接码", "UNPAIRED");
    return link;
  }

  checkProtocol(body) {
    if (body.protocol !== LINK_PROTOCOL) throw problem(400, `AB to T 插件的版本和 FRAME 不一致：请安装 AB to T ${ADDON_VERSION} 或更新的版本`, "VERSION");
  }

  pair(body) {
    this.checkProtocol(body);
    const code = String(body.code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const pairing = this.codes.get(code);
    if (!pairing || pairing.expires < Date.now()) throw problem(403, "连接码不对或已经过期：在 FRAME 的「Blender」选项卡里重新生成一个", "BAD_CODE");
    this.codes.delete(code);
    const list = this.list();
    const token = "fl_" + randomBytes(24).toString("base64url");
    const link = {
      id: "l" + randomBytes(4).toString("hex"),
      name: String(body.name || "Blender").slice(0, 60),
      hash: sha256(token),
      repos: [pairing.repo],
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    list.push(link);
    this.save(list);
    this.emit(pairing.repo);
    return { token, link: link.id, repos: this.repoTitles(link) };
  }

  /** A Blender that already has a token pairs with one more repository. */
  addRepo(link, body) {
    const code = String(body.code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const pairing = this.codes.get(code);
    if (!pairing || pairing.expires < Date.now()) throw problem(403, "连接码不对或已经过期：在 FRAME 的「Blender」选项卡里重新生成一个", "BAD_CODE");
    this.codes.delete(code);
    const list = this.list();
    const stored = list.find((item) => item.id === link.id);
    if (!stored.repos.includes(pairing.repo)) stored.repos.push(pairing.repo);
    this.save(list);
    const live = this.live.get(link.id);
    if (live) live.link = stored;
    this.emit(pairing.repo);
    return { link: stored.id, repos: this.repoTitles(stored) };
  }

  unpair(link) {
    this.save(this.list().filter((item) => item.id !== link.id));
    this.live.get(link.id)?.drop("UNPAIRED");
    this.live.delete(link.id);
    this.emitLink(link);
    return { ok: true };
  }

  repoTitles(link) {
    return link.repos.map((id) => {
      try {
        const repo = this.services.repos.get(id);
        return { id, title: id === "local" ? "本地" : repo.name || id };
      } catch {
        return { id, title: id };
      }
    });
  }

  /** Waits for work for this Blender: requests from the tools, at most POLL_MS. */
  async poll(link, body, res) {
    this.checkProtocol(body);
    let live = this.live.get(link.id);
    if (!live) this.live.set(link.id, (live = new Live(this, link)));
    live.link = link;
    const wasOnline = live.reported !== false && live.online();
    live.seen = Date.now();
    live.reported = true;
    if (body.name && body.name !== link.name) this.rename(link, body.name);
    if (body.state) live.update(body.state);
    if (!wasOnline) {
      this.touch(link.id);
      this.emitLink(link);
    }
    // The first poll after Blender (re)connects returns at once: the add-on learns that it is linked.
    const jobs = live.jobs.length || body.hello ? live.jobs.splice(0) : await live.wait(POLL_MS, res);
    live.seen = Date.now();
    // A reply that never reached Blender (the request was cut) gives its work to the next poll.
    if (jobs.length) res.on("close", () => !res.writableFinished && live.jobs.unshift(...jobs));
    return { jobs, repos: this.repoTitles(link) };
  }

  rename(link, name) {
    const list = this.list();
    const stored = list.find((item) => item.id === link.id);
    if (!stored) return;
    stored.name = String(name).slice(0, 60);
    this.save(list);
  }

  result(link, body) {
    this.live.get(link.id)?.settle(body);
    return { ok: true };
  }

  state(link, body) {
    const live = this.live.get(link.id);
    if (live && body.state) live.update(body.state);
    return { ok: true };
  }

  /** A work this Blender may use: one of its repositories. */
  async workFor(link, ref, { edit = false } = {}) {
    const [repo, id] = String(ref || "").split("/");
    if (!repo || !id || !link.repos.includes(repo)) throw problem(403, "这个 Blender 没有连接这个作品的作品库", "FORBIDDEN");
    return edit ? this.services.openEditable(id, repo) : this.services.openWork(id, repo);
  }

  /** A file a shot uses: the work's own (projects/<name>/…) or a library file at the version the work locked. */
  async file(link, query, req, res) {
    const work = await this.workFor(link, query.work);
    const relative = String(query.path || "");
    let file;
    if (relative.startsWith("materials/")) {
      const { materials } = this.services;
      if (!materials) throw notFound("没有素材库");
      file = await materials.file(work.repo, materials.readLocks(work.dir), relative.slice("materials/".length));
    } else {
      file = confined(work.root, relative);
      if (!inside(work.dir, file)) throw problem(403, "只能读作品自己的文件和素材库的文件", "FORBIDDEN");
    }
    sendFile(req, res, file, { type: "application/octet-stream" });
  }

  /** Blender wrote a shot back. `base` is the version it started from; a newer one on the server is a conflict. */
  async saveShot(link, body) {
    const work = await this.workFor(link, body.work, { edit: true });
    const relative = String(body.path || "");
    if (!SHOT.test(relative) || !relative.startsWith(`projects/${work.slug}/`))
      throw problem(403, "Blender 只能写回作品里的 AB to T 镜头（abt/<镜头>.json）", "FORBIDDEN");
    const content = String(body.content ?? "");
    if (Buffer.byteLength(content) > TEXT_LIMIT) throw problem(413, "镜头文件过大");
    try {
      JSON.parse(content);
    } catch {
      throw problem(400, "写回的镜头不是有效的 JSON");
    }
    const options = body.force ? {} : { expectedHash: String(body.base ?? "") };
    return writeText(work.root, relative, content, options);
  }

  // ---- for the tools and the studio -----------------------------------------------------------

  /** Open a shot (`projects/<name>/abt/<shot>.json`) of a work in the repository's Blender. */
  async open(work, relative, { reimport = false } = {}) {
    if (!SHOT.test(relative) || !relative.startsWith(`projects/${work.slug}/`) || !fs.existsSync(path.join(work.root, relative)))
      throw notFound(`作品里没有镜头 ${relative}`);
    const live = this.require(work.repo);
    return live.call("open", { work: `${work.repo}/${work.id}`, path: relative, reimport }, { timeout: 3 * 60 * 1000 });
  }
}

function verify(token, hash) {
  const a = Buffer.from(sha256(String(token)));
  const b = Buffer.from(String(hash || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One linked Blender while it polls: requests waiting for it, and what it last said about itself. */
class Live {
  constructor(blenders, link) {
    this.blenders = blenders;
    this.link = link;
    this.jobs = [];
    this.pending = new Map();
    this.waiter = null;
    this.seen = 0;
    this.active = Date.now();
    this.next = 1;
    this.state = {};
    /** false once it was reported offline (so it is reported once). */
    this.reported = undefined;
  }

  online() {
    return Boolean(this.waiter) || Date.now() - this.seen < OFFLINE_MS;
  }

  /** What the add-on reports: the open file and shot, live sync, a conflict, what the AI did last. */
  update(state) {
    if (!state || typeof state !== "object") return;
    const text = (value, max = 300) => (value == null ? null : String(value).slice(0, max));
    const shot = state.shot && typeof state.shot === "object" ? { work: text(state.shot.work, 120), path: text(state.shot.path) } : null;
    const conflict =
      state.conflict && typeof state.conflict === "object"
        ? { work: text(state.conflict.work, 120), path: text(state.conflict.path), message: text(state.conflict.message, 500) }
        : null;
    const next = {
      blender: text(state.blender, 40),
      addon: text(state.addon, 20),
      file: text(state.file),
      shot,
      live: Boolean(state.live),
      dirty: Boolean(state.dirty),
      uploading: Number(state.uploading) || 0,
      conflict,
      error: text(state.error, 500),
      activity: Array.isArray(state.activity) ? state.activity.slice(-5).map((item) => text(item, 200)) : [],
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.blenders.emitLink(this.link);
  }

  /** Until there is work, `ms` pass, or the poll's request is cut (`res` closes). */
  wait(ms, res) {
    // Another poll of the same Blender (it restarted its link) takes over.
    this.waiter?.resolve([]);
    return new Promise((resolve) => {
      const done = (jobs) => {
        clearTimeout(timer);
        res?.off("close", cut);
        if (this.waiter?.resolve === done) this.waiter = null;
        resolve(jobs);
      };
      const cut = () => done([]);
      const timer = setTimeout(cut, ms);
      res?.once("close", cut);
      this.waiter = { resolve: done };
    });
  }

  call(op, args, { timeout = 60000 } = {}) {
    const id = this.next++;
    this.active = Date.now();
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        clearTimeout(timer);
        clearTimeout(pickup);
        this.pending.delete(id);
        this.jobs = this.jobs.filter((job) => job.id !== id);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(problem(504, `Blender ${Math.round(timeout / 1000)} 秒内没有完成（${op}）：它可能正忙（渲染、导入大文件），或者已经关了`, "TIMEOUT")),
        timeout,
      );
      // Nobody took it: that Blender closed since its last poll.
      const pickup = setTimeout(
        () => this.jobs.some((job) => job.id === id) && fail(problem(409, "Blender 没有接这个请求：它可能刚刚关了，请用户打开 Blender 后再试", "OFFLINE")),
        PICKUP_MS,
      );
      this.pending.set(id, { resolve, reject, timer, pickup });
      this.jobs.push({ id, op, args, timeout: Math.round(timeout / 1000) });
      if (this.waiter) this.waiter.resolve(this.jobs.splice(0));
    });
  }

  settle({ id, ok, data, error, code }) {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    clearTimeout(call.pickup);
    if (ok) call.resolve(data ?? {});
    else call.reject(problem(422, String(error || "Blender 没能完成"), String(code || "BLENDER"), data ? { data } : undefined));
  }

  /** The link was removed: what waits for it fails, its poll ends. */
  drop(code) {
    this.waiter?.resolve([]);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      clearTimeout(call.pickup);
      call.reject(problem(409, "Blender 和 FRAME 断开了", code));
    }
    this.pending.clear();
    this.jobs = [];
  }
}

export function blenderPlugin(services) {
  const { router } = services;
  const blenders = (services.blenders = new Blenders(services));
  services.closers.push(() => blenders.close());
  services.repos.beforeRemove.push((repo) => blenders.forget(repo));

  // The studio's Blender tab.
  const base = "/api/blender/:repo";
  router.get(base, async ({ req, params, query }) => {
    services.repos.get(params.repo);
    let shots = [];
    if (query.work) {
      const work = await services.openWork(query.work, params.repo);
      const dir = path.join(work.dir, "abt");
      shots = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => `abt/${name}`)
        : [];
    }
    return { links: blenders.links(params.repo), shots, addon: ADDON_VERSION, server: studioOrigin(req, services.config) };
  });
  router.post(`${base}/pair`, ({ req, params }) => {
    const code = blenders.pairCode(params.repo);
    const server = studioOrigin(req, services.config);
    return { ...code, server, link: `${server}#${code.code}` };
  });
  router.delete(`${base}/links/:id`, ({ params }) => blenders.unlink(params.id, params.repo));
  router.post(`${base}/open`, async ({ req, params }) => {
    const { work: id, shot, reimport } = await readJson(req);
    const work = await services.openEditable(id, params.repo);
    return blenders.open(work, shotPath(work, String(shot || "")), { reimport: Boolean(reimport) });
  });

  // The add-on: its token instead of a session (public routes that check it themselves).
  const linked = (handler) => async (context) => handler(blenders.identify(context.req), context);
  const open = { public: true };
  router.post("/api/blender-link/pair", async ({ req }) => blenders.pair(await readJson(req)), open);
  router.post(
    "/api/blender-link/add",
    linked(async (link, { req }) => blenders.addRepo(link, await readJson(req))),
    open,
  );
  router.post(
    "/api/blender-link/poll",
    linked(async (link, { req, res }) => blenders.poll(link, await readJson(req), res)),
    open,
  );
  router.post(
    "/api/blender-link/result",
    linked(async (link, { req }) => blenders.result(link, await readJson(req))),
    open,
  );
  router.post(
    "/api/blender-link/state",
    linked(async (link, { req }) => blenders.state(link, await readJson(req))),
    open,
  );
  router.get(
    "/api/blender-link/file",
    linked((link, { req, res, query }) => blenders.file(link, query, req, res)),
    open,
  );
  router.post(
    "/api/blender-link/save",
    linked(async (link, { req }) => blenders.saveShot(link, await readJson(req))),
    open,
  );
  router.post(
    "/api/blender-link/unpair",
    linked((link) => blenders.unpair(link)),
    open,
  );

  registerBlenderTools(services.tools);
}
