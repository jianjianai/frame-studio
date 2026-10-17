import { readJson } from "./http.mjs";
import { notFound } from "./util.mjs";

/**
 * Versions of a branch the works of a repository share and that saves every change at once
 * (the reviews, the skills): history and GitHub sync like a work's, under `base`
 * (/api/repos/:repo/…). Looking at them starts no branch: a repository without one has no
 * versions yet. `scopeIfAny(repo)` is the branch's work-like handle or null; `changed(repo)`
 * tells the studio after the files moved; `commit` and `discard` handle unsaved changes when
 * there can be any.
 */
export function sharedBranchRoutes(services, base, { branch, scopeIfAny, changed, commit, discard }) {
  const { router, works } = services;
  const unborn = (repo) => ({ branch, upstream: "", ahead: 0, behind: 0, files: [], head: null, remote: Boolean(services.repos.get(repo).remote) });
  const existing = async (params) => {
    const handle = await scopeIfAny(params.repo);
    if (!handle) throw notFound("还没有版本");
    return handle;
  };
  const after = async (params, result) => {
    changed(params.repo);
    return result;
  };
  router.get(`${base}/status`, async ({ params }) => {
    const handle = await scopeIfAny(params.repo);
    return handle ? works.status(handle) : unborn(params.repo);
  });
  router.get(`${base}/history`, async ({ params, query }) => {
    const handle = await scopeIfAny(params.repo);
    return handle ? works.history(handle, { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }) : [];
  });
  router.get(`${base}/changes`, async ({ params, query }) => {
    const handle = await scopeIfAny(params.repo);
    return handle ? works.changes(handle, query.commit) : [];
  });
  router.get(`${base}/diff`, async ({ params, query }) => {
    const handle = await scopeIfAny(params.repo);
    return { diff: handle ? await works.diff(handle, { commit: query.commit, file: query.file }) : "" };
  });
  router.post(`${base}/revert`, async ({ params, req }) => after(params, { commit: await works.revert(await existing(params), (await readJson(req)).commit) }));
  router.post(`${base}/commit`, async ({ params, req }) => (commit ? commit(params.repo, (await readJson(req)).message) : { commit: null }));
  router.post(`${base}/discard`, async ({ params, req }) => (discard ? discard(params.repo, (await readJson(req)).files ?? []) : null));
  router.post(`${base}/sync`, async ({ params }) => {
    const handle = await scopeIfAny(params.repo);
    return handle ? works.sync(handle) : unborn(params.repo);
  });
  router.post(`${base}/push`, async ({ params }) => works.push(await existing(params)));
  router.post(`${base}/pull`, async ({ params }) => after(params, await works.pull(await existing(params))));
  router.post(`${base}/resolve`, async ({ params, req }) => after(params, await works.resolve(await existing(params), (await readJson(req)).strategy)));
}
