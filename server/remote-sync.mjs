import { git, gitOk } from "./git.mjs";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";

/**
 * Works (and the library branches) of repositories connected to GitHub stay in step with it.
 * Every saved version is pushed in the background. A work is compared with GitHub when it
 * is opened, on a manual refresh and when a push is refused: newer versions there are
 * brought in at once when that is safe (fast-forward, no AI at work), otherwise the work is
 * marked "behind" or "diverged" (both sides have new versions) and everybody is told —
 * the studio shows it, the AI gets it with each message — so nobody keeps editing an
 * outdated copy. State changes go out as `remote-state` events.
 *
 * state: synced | pushing | behind | diverged | conflict | error | local (no GitHub)
 */
export class RemoteSync {
  constructor(services) {
    this.services = services;
    this.states = new Map(); // "repo/id" → state
    this.timers = new Map();
    this.running = new Map(); // "repo/id" → promise of the push or check in progress
  }

  key(scope) {
    return `${scope.repo}/${scope.id}`;
  }
  get(scope) {
    return this.states.get(this.key(scope)) ?? null;
  }
  set(scope, state) {
    const next = { ...state, at: new Date().toISOString() };
    this.states.set(this.key(scope), next);
    this.services.events.emit({ type: "remote-state", repo: scope.repo, work: scope.id, state: next });
    return next;
  }

  /** One push or check at a time per branch. */
  serial(scope, task) {
    const key = this.key(scope);
    const run = (this.running.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.running.set(key, run);
    run.finally(() => this.running.get(key) === run && this.running.delete(key)).catch(() => {});
    return run;
  }

  /** After a version was saved: push soon (versions saved in a row go out together). */
  pushSoon(scope, delay = 1500) {
    const repo = this.services.repos.get(scope.repo);
    if (!repo.remote) return;
    clearTimeout(this.timers.get(this.key(scope)));
    this.timers.set(
      this.key(scope),
      setTimeout(() => {
        this.timers.delete(this.key(scope));
        this.push(scope).catch(() => {});
      }, delay),
    );
  }

  /** Push now, instead of a push waiting to happen. */
  pushNow(scope) {
    clearTimeout(this.timers.get(this.key(scope)));
    this.timers.delete(this.key(scope));
    return this.push(scope);
  }

  /** Fetch only this branch from GitHub; false when GitHub does not have it (yet). */
  async fetch(scope) {
    const repo = this.services.repos.get(scope.repo);
    try {
      await git(repo.dir, ["fetch", "--quiet", "origin", `+refs/heads/${scope.branch}:refs/remotes/origin/${scope.branch}`], {
        env: this.services.repos.env(repo),
      });
      return true;
    } catch (error) {
      if (/couldn't find remote ref|not our ref/i.test(error.stderr || error.message)) return false;
      throw error;
    }
  }
  /** Versions only here (ahead) and only on GitHub (behind). */
  async counts(scope) {
    const repo = this.services.repos.get(scope.repo);
    const remote = `refs/remotes/origin/${scope.branch}`;
    if (!(await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", remote]))) {
      const ahead = Number((await git(repo.dir, ["rev-list", "--count", `refs/heads/${scope.branch}`]).catch(() => "0")).trim());
      return { ahead, behind: 0, onGitHub: false };
    }
    const [ahead, behind] = (await git(repo.dir, ["rev-list", "--left-right", "--count", `refs/heads/${scope.branch}...${remote}`]))
      .trim()
      .split(/\s+/)
      .map(Number);
    return { ahead, behind, onGitHub: true };
  }

  /** Push the saved versions; a refusal means GitHub has newer ones: compare and say so. */
  push(scope) {
    return this.serial(scope, async () => {
      const repo = this.services.repos.get(scope.repo);
      if (!repo.remote) return this.set(scope, { state: "local" });
      this.set(scope, { ...(this.get(scope) ?? {}), state: "pushing" });
      try {
        await git(scope.root, ["push", "--quiet", "-u", "origin", scope.branch], { env: this.services.repos.env(repo) });
        this.services.events.emit({ type: "work-versions", work: scope.id });
        return this.set(scope, { state: "synced", ahead: 0, behind: 0 });
      } catch (error) {
        if (/rejected|non-fast-forward|fetch first/i.test(error.stderr || error.message)) return this.compare(scope, { bringIn: false });
        return this.set(scope, {
          state: "error",
          message: `自动推送到 GitHub 失败：${String(error.stderr || error.message)
            .trim()
            .split("\n")
            .pop()}`,
        });
      }
    });
  }

  /**
   * Compare with GitHub. Newer versions there are brought in when that is safe; local-only
   * versions are pushed; otherwise the state says what the user has to decide.
   */
  /** Compare now (`session`: an AI turn that does not count as "at work"). */
  check(scope, { session } = {}) {
    return this.serial(scope, () => this.compare(scope, { bringIn: true, session }));
  }

  async compare(scope, { bringIn, session }) {
    const repo = this.services.repos.get(scope.repo);
    if (!repo.remote) return this.set(scope, { state: "local" });
    try {
      await this.fetch(scope);
      const { ahead, behind, onGitHub } = await this.counts(scope);
      if (!behind) {
        if (!ahead) return this.set(scope, { state: "synced", ahead: 0, behind: 0 });
        // Saved here, not on GitHub yet (or GitHub never had the branch): push it.
        await git(scope.root, ["push", "--quiet", "-u", "origin", scope.branch], { env: this.services.repos.env(repo) });
        this.services.events.emit({ type: "work-versions", work: scope.id });
        return this.set(scope, { state: "synced", ahead: 0, behind: 0, firstPush: !onGitHub });
      }
      if (ahead) return this.set(scope, { state: "diverged", ahead, behind });
      if (bringIn) {
        const busy = this.aiBusy(scope, session);
        if (!busy) {
          const brought = await this.fastForward(scope);
          if (brought.ok) return this.set(scope, { state: "synced", ahead: 0, behind: 0, pulled: behind });
          return this.set(scope, { state: "behind", ahead, behind, blocked: brought.files });
        }
        return this.set(scope, { state: "behind", ahead, behind, waiting: "ai" });
      }
      return this.set(scope, { state: "behind", ahead, behind });
    } catch (error) {
      return this.set(scope, {
        state: "error",
        message: `无法连接 GitHub：${String(error.stderr || error.message)
          .trim()
          .split("\n")
          .pop()}`,
      });
    }
  }

  /**
   * Push every branch that is only ahead of GitHub (versions saved while offline, or before
   * automatic pushing existed): works, also those not opened, and the library branches.
   * Branches GitHub is ahead on, or both are, wait for their work to be opened.
   */
  async sweep() {
    const { repos } = this.services;
    for (const { id } of repos.list().filter((item) => item.ready && item.remote)) {
      const repo = repos.get(id);
      try {
        await repos.fetch(id);
        const heads = (await git(repo.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/works/", "refs/heads/frame/"]))
          .split("\n")
          .filter(Boolean);
        for (const branch of heads) {
          const scope = { repo: id, branch };
          const { ahead, behind } = await this.counts(scope);
          if (ahead && !behind) await git(repo.dir, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { env: repos.env(repo) });
        }
        this.services.events.emit({ type: "works", repo: id });
      } catch (error) {
        console.warn(`automatic push of ${id} failed:`, error.message);
      }
    }
  }

  /** An AI turn (other than `except`) is changing the work's files right now. */
  aiBusy(scope, except) {
    return Boolean(this.services.ai?.list({ work: scope.id, repo: scope.repo }).some((session) => session.id !== except && session.status !== "idle"));
  }

  /** Move to GitHub's newer versions without a merge; unsaved edits stay unless they touch the same files. */
  async fastForward(scope) {
    const { works } = this.services;
    return works.locks.run(`${scope.repo}/${scope.id}`, async () => {
      const unlock = scope.slug && works.published(scope);
      if (unlock) works.lockFiles(scope.root, false);
      try {
        await git(scope.root, ["merge", "--ff-only", "--quiet", `refs/remotes/origin/${scope.branch}`]);
        this.services.events.emit({ type: "work-versions", work: scope.id });
        if (scope.slug) this.services.preview?.invalidateWork?.(scope);
        return { ok: true };
      } catch (error) {
        // "Your local changes to the following files would be overwritten": name them.
        const files = [...String(error.stderr || "").matchAll(/^\s+(\S.*)$/gm)]
          .map((match) => match[1].trim())
          .filter((file) => !/^(Please|Aborting)/.test(file));
        return { ok: false, files };
      } finally {
        if (scope.slug && works.published(scope)) works.lockFiles(scope.root, true);
      }
    });
  }

  /**
   * The user's decision. update: bring GitHub's newer versions in (unsaved edits are kept;
   * when they touch the same files they are saved first and merged); merge: both sides'
   * versions; remote: GitHub's (this machine's kept as a backup ref); local: this machine's
   * (GitHub's stay in the history). Then push what is left.
   */
  settle(scope, strategy) {
    const { works } = this.services;
    if (!["update", "merge", "remote", "local"].includes(strategy)) throw problem(400, "未知的处理方式");
    return this.serial(scope, async () => {
      await this.fetch(scope);
      const { ahead, behind } = await this.counts(scope);
      if (behind) {
        const plain = strategy === "update" && !ahead && (await this.fastForward(scope)).ok;
        if (!plain)
          try {
            await works.resolve(scope, strategy === "update" ? "merge" : strategy);
          } catch (error) {
            // Local edits were saved as a version on the way: count again.
            const now = await this.counts(scope).catch(() => ({ ahead, behind }));
            this.set(scope, { state: "conflict", ahead: now.ahead, behind: now.behind, files: error.details?.files ?? [] });
            throw error;
          }
      }
      return this.compare(scope, { bringIn: true });
    });
  }
}

export function remoteSyncPlugin(services) {
  const { router, works } = services;
  const sync = (services.remoteSync = new RemoteSync(services));
  works.afterSave.push((scope) => sync.pushSoon(scope));
  // Shortly after start, then now and then: what was saved but never reached GitHub goes now.
  const first = setTimeout(() => void sync.sweep(), 20000);
  const later = setInterval(() => void sync.sweep(), 30 * 60 * 1000);
  first.unref?.();
  later.unref?.();
  services.closers.push(() => (clearTimeout(first), clearInterval(later)));

  // A work, and the repository's experience, material library and review branches (null: no reviews yet).
  const scopes = {
    work: (params) => services.openWork(params.id, params.repo),
    experience: (params) => services.experience.scope(params.repo),
    materials: (params) => services.materials.scope(params.repo),
    reviews: (params) => services.reviews.scopeIfAny(params.repo),
  };
  const bases = {
    work: "/api/works/:repo/:id/remote",
    experience: "/api/repos/:repo/experience/remote",
    materials: "/api/repos/:repo/materials/remote",
    reviews: "/api/repos/:repo/reviews/remote",
  };
  for (const [kind, base] of Object.entries(bases)) {
    router.get(base, async ({ params }) => {
      const scope = await scopes[kind](params);
      return (scope && sync.get(scope)) ?? { state: "unknown" };
    });
    router.post(`${base}/check`, async ({ params }) => {
      const scope = await scopes[kind](params);
      return scope ? sync.check(scope) : { state: "unknown" };
    });
    router.post(`${base}/settle`, async ({ params, req }) => {
      const scope = await scopes[kind](params);
      if (!scope) throw problem(404, "还没有这个分支", "NOT_FOUND");
      return sync.settle(scope, (await readJson(req)).strategy);
    });
  }
}
