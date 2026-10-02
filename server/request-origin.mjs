import { problem } from "./security.mjs";

/** Fastify's trusted-proxy getters preserve the external protocol and authority. */
export function requestExternalOrigin(request) {
  const protocol = request.protocol, authority = request.host;
  if (!["http", "https"].includes(protocol) || typeof authority !== "string" ||
      !authority || /[\s/\\?#@]/u.test(authority) || authority.endsWith(":")) {
    throw problem(400, "Invalid request origin");
  }
  try {
    const url = new URL(protocol + "://" + authority);
    if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw Error("Invalid authority");
    return url.origin;
  } catch {
    throw problem(400, "Invalid request origin");
  }
}
