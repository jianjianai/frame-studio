import { problem } from "./util.mjs";

const API = "https://api.github.com";

async function request(token, method, route, body) {
  const response = await fetch(API + route, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "frame-studio",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw problem(response.status === 401 ? 401 : 502, `GitHub: ${data?.message || response.statusText}`, "GITHUB_ERROR");
  return data;
}

/** GitHub accounts are personal access tokens (classic or fine-grained with Contents read/write). */
export class GitHub {
  constructor(settings) {
    this.settings = settings;
  }
  accounts() {
    return this.settings.get("github").accounts;
  }
  token(accountId) {
    return accountId ? this.settings.secret("github:" + accountId) : "";
  }
  async addAccount(token) {
    const user = await request(token, "GET", "/user");
    const account = { id: String(user.id), login: user.login, name: user.name || user.login, avatar: user.avatar_url };
    this.settings.setSecret("github:" + account.id, token);
    this.settings.update("github", (github) => ({
      ...github,
      accounts: [...github.accounts.filter((item) => item.id !== account.id), account],
    }));
    return account;
  }
  removeAccount(id) {
    this.settings.setSecret("github:" + id, "");
    this.settings.update("github", (github) => ({ ...github, accounts: github.accounts.filter((item) => item.id !== id) }));
  }
  async repositories(accountId, { page = 1, query = "" } = {}) {
    const token = this.token(accountId);
    if (!token) throw problem(400, "未找到 GitHub 账号");
    if (query) {
      const account = this.accounts().find((item) => item.id === accountId);
      const result = await request(token, "GET", `/search/repositories?q=${encodeURIComponent(query + " user:" + account.login)}&per_page=30&page=${page}`);
      return result.items.map(repoSummary);
    }
    const repos = await request(token, "GET", `/user/repos?per_page=50&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    return repos.map(repoSummary);
  }
  async createRepository(accountId, { name, description = "FRAME 作品库", private: isPrivate = true }) {
    const token = this.token(accountId);
    if (!token) throw problem(400, "未找到 GitHub 账号");
    return repoSummary(await request(token, "POST", "/user/repos", { name, description, private: isPrivate, auto_init: false }));
  }
  async createRelease(accountId, fullName, { tag, name, body }) {
    return request(this.token(accountId), "POST", `/repos/${fullName}/releases`, { tag_name: tag, name, body });
  }
  async uploadReleaseAsset(accountId, uploadUrl, fileName, bytes, type) {
    const url = uploadUrl.replace(/\{.*$/, "") + "?name=" + encodeURIComponent(fileName);
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + this.token(accountId), "Content-Type": type, "User-Agent": "frame-studio" },
      body: bytes,
    });
    if (!response.ok) throw problem(502, "GitHub release upload failed: " + response.status);
    return response.json();
  }
}

const repoSummary = (repo) => ({
  fullName: repo.full_name,
  name: repo.name,
  private: repo.private,
  url: repo.clone_url,
  htmlUrl: repo.html_url,
  updatedAt: repo.updated_at,
  description: repo.description || "",
});
