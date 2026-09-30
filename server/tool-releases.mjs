import { problem } from "./security.mjs";

export const toolDefinitions = Object.freeze({
  codex: {
    name: "Codex",
    package: "@openai/codex",
    releasesUrl: "https://github.com/openai/codex/releases",
  },
  claude: {
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    releasesUrl:
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  },
});
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function normalizeToolVersion(value) {
  const version =
    typeof value === "string" ? value.trim().replace(/^v/, "") : "";
  const match = version.length <= 80 && versionPattern.exec(version);
  if (
    !match ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && /^0\d/.test(part))
  )
    throw problem(
      400,
      "请输入完整版本号，例如 1.2.3；不支持版本范围或安装地址。",
    );
  return version;
}
export function installedToolVersion(output) {
  const match = String(output).match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  try {
    return match ? normalizeToolVersion(match[0]) : null;
  } catch {
    return null;
  }
}
export function compareToolVersions(left, right) {
  const a = normalizeToolVersion(left).split("-"),
    b = normalizeToolVersion(right).split("-");
  const coreA = a[0].split(".").map(BigInt),
    coreB = b[0].split(".").map(BigInt);
  for (let i = 0; i < 3; i++)
    if (coreA[i] !== coreB[i]) return coreA[i] > coreB[i] ? 1 : -1;
  const preA = a.slice(1).join("-"),
    preB = b.slice(1).join("-");
  if (preA === preB) return 0;
  if (!preA || !preB) return preA ? -1 : 1;
  const partsA = preA.split("."),
    partsB = preB.split(".");
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i],
      y = partsB[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** Only official packages; successful checks last 15 minutes, failed checks retry after one minute. */
export class ToolReleases {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
  }
  definition(provider) {
    if (!Object.hasOwn(toolDefinitions, provider))
      throw problem(400, "不支持的创作工具");
    return toolDefinitions[provider];
  }
  async metadata(provider, version) {
    const definition = this.definition(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.fetch(
        "https://registry.npmjs.org/" +
          encodeURIComponent(definition.package) +
          "/" +
          encodeURIComponent(version),
        {
          signal: controller.signal,
          redirect: "error",
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 404)
        throw problem(404, "官方包中没有这个版本，请检查版本号。");
      if (!response.ok)
        throw problem(502, "官方版本服务暂时不可用，请稍后重试。");
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024)
          throw problem(502, "官方版本信息超过读取上限。");
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.name !== definition.package)
        throw problem(502, "官方包信息不匹配。");
      const resolved = normalizeToolVersion(value.version);
      if (version !== "latest" && resolved !== version)
        throw problem(502, "官方返回的版本与请求不一致。");
      return resolved;
    } catch (error) {
      if (error.statusCode) throw error;
      throw problem(
        502,
        controller.signal.aborted
          ? "检查版本超时，请重试；也可以输入明确版本号。"
          : "无法连接官方版本服务，请检查网络后重试。",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async check(provider, { force = false } = {}) {
    this.definition(provider);
    const cached = this.cache.get(provider);
    if (!force && cached && this.now() < cached.expiresAt) return cached.value;
    if (this.pending.has(provider)) return this.pending.get(provider);
    const request = (async () => {
      let value;
      try {
        value = {
          latestVersion: await this.metadata(provider, "latest"),
          checkedAt: new Date(this.now()).toISOString(),
          status: "ready",
          error: null,
        };
      } catch (error) {
        value = {
          latestVersion: cached?.value.latestVersion || null,
          checkedAt: cached?.value.checkedAt || null,
          status: "error",
          error: error.message,
        };
      }
      value.attemptedAt = new Date(this.now()).toISOString();
      this.cache.set(provider, {
        value,
        expiresAt:
          this.now() + (value.status === "ready" ? 15 * 60_000 : 60_000),
      });
      return value;
    })();
    this.pending.set(provider, request);
    try {
      return await request;
    } finally {
      this.pending.delete(provider);
    }
  }
  async resolve(provider, requested = "latest") {
    this.definition(provider);
    if (requested.trim() === "latest") {
      const release = await this.check(provider, { force: true });
      if (release.status !== "ready") throw problem(502, release.error);
      return release.latestVersion;
    }
    const version = normalizeToolVersion(requested);
    return this.metadata(provider, version);
  }
}
