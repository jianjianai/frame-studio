import { readJson } from "./http.mjs";
import { notFound } from "./util.mjs";

/**
 * Versions of a branch outside the works that saves every change at once (a work's review, the
 * repository's skills): history and GitHub sync like a work's, under `base` (/api/repos/:repo/…).
 * Looking at them starts no branch: without one there are no versions yet. `branch` is its name
 * (or a function of the route's params), `scopeIfAny(repo, params)` its work-like handle or null;
 * `changed(repo, params)` tells the studio after the files moved; `commit` and `discard` handle
 * unsaved changes when there can be any.
 */
export function sharedBranchRoutes(services, base, { branch, scopeIfAny, changed, commit, discard }) {
  const { router, works } = services;
  const unborn = (params) => ({
    branch: typeof branch === "function" ? branch(params) : branch,
    upstream: "",
    ahead: 0,
    behind: 0,
    files: [],
    head: null,
    remote: Boolean(services.repos.get(params.repo).remote),
  });
  const scope = (params) => scopeIfAny(params.repo, params);
  const existing = async (params) => {
    const handle = await scope(params);
    if (!handle) throw notFound("还没有版本");
    return handle;
  };
  const after = async (params, result) => {
    changed(params.repo, params);
    return result;
  };
  router.get(`${base}/status`, async ({ params }) => {
    const handle = await scope(params);
    return handle ? works.status(handle) : unborn(params);
  });
  router.get(`${base}/history`, async ({ params, query }) => {
    const handle = await scope(params);
    return handle ? works.history(handle, { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }) : [];
  });
  router.get(`${base}/changes`, async ({ params, query }) => {
    const handle = await scope(params);
    return handle ? works.changes(handle, query.commit) : [];
  });
  router.get(`${base}/diff`, async ({ params, query }) => {
    const handle = await scope(params);
    return { diff: handle ? await works.diff(handle, { commit: query.commit, file: query.file }) : "" };
  });
  router.post(`${base}/revert`, async ({ params, req }) => after(params, { commit: await works.revert(await existing(params), (await readJson(req)).commit) }));
  router.post(`${base}/commit`, async ({ params, req }) => (commit ? commit(params.repo, (await readJson(req)).message) : { commit: null }));
  router.post(`${base}/discard`, async ({ params, req }) => (discard ? discard(params.repo, (await readJson(req)).files ?? []) : null));
  router.post(`${base}/sync`, async ({ params }) => {
    const handle = await scope(params);
    return handle ? works.sync(handle) : unborn(params);
  });
  router.post(`${base}/push`, async ({ params }) => works.push(await existing(params)));
  router.post(`${base}/pull`, async ({ params }) => after(params, await works.pull(await existing(params))));
  router.post(`${base}/resolve`, async ({ params, req }) => after(params, await works.resolve(await existing(params), (await readJson(req)).strategy)));
}
