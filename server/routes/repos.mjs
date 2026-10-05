import { readJson } from "../http.mjs";
import { problem } from "../util.mjs";

export function repoRoutes({ router, repos, github, works }) {
  router.get("/api/repos", () => repos.list());
  router.post("/api/repos", async ({ req }) => {
    const body = await readJson(req);
    if (body.create) return repos.createOnGitHub({ account: body.account, name: body.name, private: body.private !== false });
    if (!body.url) throw problem(400, "请填写仓库地址");
    return repos.clone({ url: body.url, account: body.account || "" });
  });
  router.post("/api/repos/:id/publish", async ({ req, params }) => {
    if (params.id !== "local") throw problem(400, "只有本地作品库需要发布");
    const body = await readJson(req);
    return repos.publishLocal({ account: body.account, name: body.name, private: body.private !== false });
  });
  router.post("/api/repos/:id/fetch", ({ params }) => repos.fetch(params.id));
  router.patch("/api/repos/:id", async ({ req, params }) => {
    const body = await readJson(req);
    if ("account" in body) await repos.setAccount(params.id, body.account);
    return repos.get(params.id);
  });
  router.delete("/api/repos/:id", ({ params }) => repos.remove(params.id));
  router.get("/api/repos/:id/trash", ({ params }) => works.list({ repo: params.id, trash: true }));

  router.get("/api/github/accounts", () => github.accounts());
  router.post("/api/github/accounts", async ({ req }) => {
    const { token } = await readJson(req);
    if (!token) throw problem(400, "请填写 GitHub 令牌");
    return github.addAccount(token.trim());
  });
  router.delete("/api/github/accounts/:id", ({ params }) => github.removeAccount(params.id));
  router.get("/api/github/accounts/:id/repos", ({ params, query }) => github.repositories(params.id, { page: Number(query.page || 1), query: query.q || "" }));
}
