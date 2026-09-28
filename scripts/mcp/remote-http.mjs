import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createFrameServer } from "./server.mjs";
import { ProjectService } from "../project-service.mjs";
import { Jobs } from "./jobs.mjs";
import { RemoteAuth, AuthError, json } from "./remote-auth.mjs";
import { FrameError } from "./workspace.mjs";
import { AssetTransfers, CHUNK_BYTES } from "../asset-transfer.mjs";
import { describeSpeech } from "../speech.mjs";

const types = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".srt": "text/plain",
  ".html": "text/html",
};
const MAX_BODY = 4 * 1024 * 1024;
const harden = (response, formOrigins = []) => {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  // Preserve the same-origin form POST Origin; no-referrer makes it null in Chromium.
  // Cross-origin OAuth callbacks still receive no Referer.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formOrigins.join(" ")}; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(response.body, { status: response.status, headers });
};

export async function startRemoteServer(config) {
  const auth = new RemoteAuth(config),
    principals = new Map(),
    rates = new Map();
  const workspace = new ProjectService(config.root, {
    projects: config.projects,
    readOnly: true,
  });
  const template = createFrameServer({ ...config, readOnly: true });
  const assetReader = new AssetTransfers(workspace);
  const writeTools = template.writeTools;
  let closing = false,
    inFlight = 0;
  const rate = (key, limit) => {
    const now = Date.now(),
      prior = rates.get(key);
    const value =
      prior && prior.until > now ? prior : { count: 0, until: now + 60000 };
    rates.set(key, value);
    return ++value.count <= limit;
  };
  const artifactFile = (project, relative) => {
    const speech =
      /^public\/narration\/([a-f0-9]{64})\/(voice\.wav|captions\.srt|timeline\.json)$/.exec(
        relative,
      );
    if (speech) {
      const item = describeSpeech(workspace, project, speech[1], speech[2]);
      return {
        file: item.path,
        stat: fs.statSync(item.path),
        mime: item.mimeType,
      };
    }
    if (
      !relative.startsWith("exports/") ||
      !types[path.extname(relative).toLowerCase()]
    )
      throw new Error("Not a supported generated artifact");
    const file = workspace.file(project, relative),
      stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink > 1)
      throw new Error("Artifact must be a regular file");
    return { file, stat, mime: types[path.extname(relative).toLowerCase()] };
  };
  const decorate = (result) => {
    if (result.isError || !result.structuredContent) return result;
    const transfer = result.structuredContent;
    if (transfer.uploadId && transfer.project) {
      const url = `${config.publicUrl}/uploads/${encodeURIComponent(transfer.project)}/${transfer.uploadId}`;
      result = {
        ...result,
        structuredContent: {
          ...transfer,
          transport: {
            url,
            completeUrl: url + "/complete",
            methods: {
              status: "GET",
              chunk: "PATCH",
              complete: "POST",
              abort: "DELETE",
            },
            chunkBytes: CHUNK_BYTES,
            authorization:
              "Use the same Authorization: Bearer header; PATCH uses application/octet-stream and Upload-Offset.",
          },
        },
      };
      result.content = result.content.map((item) =>
        item.type === "text"
          ? { ...item, text: JSON.stringify(result.structuredContent) }
          : item,
      );
    }
    const found = new Map();
    let visited = 0;
    const visit = (value) => {
      if (++visited > 1000 || found.size >= 16) return;
      if (
        typeof value === "string" &&
        value.length < 4096 &&
        path.isAbsolute(value)
      ) {
        const relative = path
          .relative(path.join(config.root, "projects"), value)
          .split(path.sep);
        const [project, ...parts] = relative;
        try {
          const relativePath = parts.join("/");
          const material = relativePath.startsWith("public/imports/");
          const asset = material
            ? assetReader.describe(project, relativePath)
            : null;
          const item = asset
            ? {
                file: asset.absolutePath,
                stat: { size: asset.bytes },
                mime: asset.mimeType,
              }
            : artifactFile(project, relativePath);
          const uri =
            config.publicUrl +
            (material ? "/assets/" : "/artifacts/") +
            relative.map(encodeURIComponent).join("/");
          found.set(uri, {
            type: "resource_link",
            uri,
            name: path.basename(item.file),
            mimeType: item.mime,
            size: item.stat.size,
            description:
              "Authenticated download; send the same Authorization: Bearer header.",
          });
        } catch {}
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object")
        Object.values(value).forEach(visit);
    };
    visit(result.structuredContent);
    if (!found.size) return result;
    return {
      ...result,
      structuredContent: {
        ...result.structuredContent,
        remoteArtifacts: [...found.values()],
      },
      content: [...result.content, ...found.values()],
    };
  };
  const manager = (principal) => {
    let entry = principals.get(principal);
    if (!entry) {
      if (principals.size >= config.maxPrincipals)
        throw new AuthError(
          "temporarily_unavailable",
          "Too many active authorizations",
          429,
        );
      entry = {
        jobs: new Jobs(
          new ProjectService(config.root, { projects: config.projects }),
          { timeoutMs: config.timeoutMs },
        ),
        lastSeen: Date.now(),
      };
      entry.assets = new AssetTransfers(
        new ProjectService(config.root, {
          projects: config.projects,
          readOnly: config.readOnly,
        }),
        { owner: principal },
      );
      principals.set(principal, entry);
    }
    entry.lastSeen = Date.now();
    return entry;
  };
  const handler = createMcpHandler(
    (ctx) => {
      const info = ctx.authInfo;
      const entry = manager(info.extra.principal);
      return createFrameServer({
        ...config,
        readOnly: !info.scopes.includes("frame:write"),
        jobManager: entry.jobs,
        assetManager: entry.assets,
        decorateResult: decorate,
      }).server;
    },
    {
      maxRequestBodySize: MAX_BODY,
      maxSubscriptions: 16,
      keepAliveMs: 15000,
      onerror: () => {},
    },
  );
  const dropRevoked = async () => {
    const pending = [];
    for (const [key, entry] of principals) {
      if (
        !auth.active(key) ||
        (!entry.jobs.running.size &&
          !entry.assets.running.size &&
          Date.now() - entry.lastSeen > 1800000)
      ) {
        principals.delete(key);
        pending.push(entry.jobs.close());
        pending.push(entry.assets.close());
      }
    }
    await Promise.allSettled(pending);
    for (const [key, value] of rates)
      if (value.until < Date.now()) rates.delete(key);
  };
  const timer = setInterval(() => void dropRevoked(), 10000);
  timer.unref();
  const route = async (request) => {
    const url = new URL(request.url),
      origin = request.headers.get("origin");
    if (origin && !config.origins.includes(origin))
      return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods":
            "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, Range, Upload-Offset, X-Chunk-SHA256",
          "Access-Control-Max-Age": "600",
        },
      });
    if (url.pathname === "/healthz" && request.method === "GET")
      return json({ status: closing ? "stopping" : "ready" });
    if (
      url.pathname === "/mcp" ||
      ["/artifacts/", "/uploads/", "/assets/"].some((prefix) =>
        url.pathname.startsWith(prefix),
      )
    ) {
      let identity;
      try {
        identity = auth.verify(request.headers.get("authorization"));
      } catch {
        return auth.challenge();
      }
      if (
        !rate(
          identity.principal +
            (url.pathname.startsWith("/uploads/") ? ":uploads" : ""),
          url.pathname.startsWith("/uploads/") ? 2400 : 240,
        )
      )
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      if (url.searchParams.has("access_token") || url.searchParams.has("token"))
        return json({ error: "Tokens must use Authorization header" }, 400);
      if (url.pathname.startsWith("/uploads/")) {
        const [, , project, uploadId, suffix, ...extra] = url.pathname
          .split("/")
          .map(decodeURIComponent);
        const assets = manager(identity.principal).assets;
        if (extra.length || (suffix && suffix !== "complete"))
          return json({ error: "not_found" }, 404);
        if (
          request.method !== "GET" &&
          !identity.scopes.includes("frame:write")
        )
          return auth.challenge("insufficient_scope", "frame:read frame:write");
        let value;
        if (!uploadId && request.method === "POST")
          value = assets.begin(project, await request.json());
        else if (uploadId && !suffix && request.method === "GET")
          value = assets.status(project, uploadId);
        else if (uploadId && !suffix && request.method === "PATCH") {
          if (
            request.headers.get("content-type") !== "application/octet-stream"
          )
            return json({ error: "Expected application/octet-stream" }, 415);
          const offset = request.headers.get("upload-offset");
          if (!/^\d+$/.test(offset ?? ""))
            return json({ error: "Upload-Offset is required" }, 400);
          value = assets.chunk(
            project,
            uploadId,
            Number(offset),
            Buffer.from(await request.arrayBuffer()),
            request.headers.get("x-chunk-sha256") ?? undefined,
          );
        } else if (
          uploadId &&
          suffix === "complete" &&
          request.method === "POST"
        )
          value = await assets.complete(project, uploadId);
        else if (uploadId && !suffix && request.method === "DELETE")
          value = await assets.abort(project, uploadId);
        else return json({ error: "method_not_allowed" }, 405);
        return json(
          decorate({ content: [], structuredContent: value }).structuredContent,
        );
      }
      if (
        url.pathname.startsWith("/artifacts/") ||
        url.pathname.startsWith("/assets/")
      ) {
        if (!["GET", "HEAD"].includes(request.method))
          return json({ error: "method_not_allowed" }, 405);
        try {
          const [, , project, ...parts] = url.pathname
            .split("/")
            .map(decodeURIComponent);
          const asset = url.pathname.startsWith("/assets/")
            ? assetReader.describe(project, parts.join("/"))
            : null;
          const item = asset
              ? {
                  file: asset.absolutePath,
                  stat: { size: asset.bytes },
                  mime: asset.mimeType,
                }
              : artifactFile(project, parts.join("/")),
            size = item.stat.size;
          let start = 0,
            end = size - 1,
            status = 200;
          const range = request.headers.get("range");
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2]))
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${size}` },
              });
            start = match[1]
              ? Number(match[1])
              : Math.max(0, size - Number(match[2]));
            end =
              match[1] && match[2]
                ? Math.min(size - 1, Number(match[2]))
                : size - 1;
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= size
            )
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${size}` },
              });
            status = 206;
          }
          return new Response(
            request.method === "HEAD" || size === 0
              ? null
              : Readable.toWeb(fs.createReadStream(item.file, { start, end })),
            {
              status,
              headers: {
                "Content-Type": item.mime,
                "Content-Length": String(Math.max(0, end - start + 1)),
                "Accept-Ranges": "bytes",
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(item.file))}`,
                ...(status === 206
                  ? { "Content-Range": `bytes ${start}-${end}/${size}` }
                  : {}),
              },
            },
          );
        } catch {
          return json({ error: "Artifact unavailable" }, 404);
        }
      }
      if (!["GET", "POST", "DELETE"].includes(request.method))
        return json({ error: "method_not_allowed" }, 405);
      let body;
      if (request.method === "POST") {
        try {
          body = await request.clone().json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (Array.isArray(body))
          return json({ error: "Batch requests are not supported" }, 400);
        if (
          body?.method === "tools/call" &&
          writeTools.has(body.params?.name) &&
          !identity.scopes.includes("frame:write")
        )
          return auth.challenge("insufficient_scope", "frame:read frame:write");
      }
      return handler.fetch(request, {
        parsedBody: body,
        authInfo: {
          token: identity.token,
          clientId: identity.clientId || "bearer",
          scopes: identity.scopes,
          expiresAt: identity.expiresAt,
          extra: { principal: identity.principal },
        },
      });
    }
    if (!rate("oauth-public", 120))
      return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    const response = await auth.handle(request);
    await dropRevoked();
    return response || json({ error: "not_found" }, 404);
  };
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const address = server.address();
      const allowedHosts = [
        new URL(config.publicUrl).host,
        `127.0.0.1:${address.port}`,
        `localhost:${address.port}`,
        `[::1]:${address.port}`,
      ];
      if (
        !allowedHosts.includes(req.headers.host) ||
        !req.url?.startsWith("/") ||
        req.url.startsWith("//")
      ) {
        res.writeHead(403);
        res.end("Invalid host");
        return;
      }
      if (closing || inFlight >= 64) {
        res.writeHead(503);
        res.end("Busy");
        return;
      }
      inFlight++;
      try {
        const chunks = [];
        let count = 0;
        const limit = req.url.startsWith("/oauth/")
          ? 65536
          : req.url.startsWith("/uploads/")
            ? req.method === "PATCH"
              ? CHUNK_BYTES
              : 16384
            : MAX_BODY;
        if (Number(req.headers["content-length"]) > limit) {
          res.writeHead(413);
          res.end("Body too large");
          return;
        }
        for await (const chunk of req) {
          count += chunk.length;
          if (count > limit) {
            res.writeHead(413);
            res.end("Body too large");
            return;
          }
          chunks.push(chunk);
        }
        const request = new Request(config.publicUrl + req.url, {
          method: req.method,
          headers: req.headers,
          signal: controller.signal,
          ...(count ? { body: Buffer.concat(chunks) } : {}),
        });
        let response;
        try {
          response = await route(request);
        } catch (error) {
          response =
            error instanceof FrameError
              ? json(
                  {
                    error: {
                      code: error.code,
                      message: error.message,
                      details: error.details,
                    },
                  },
                  ["UPLOAD_DENIED", "PROJECT_DENIED", "READ_ONLY"].includes(
                    error.code,
                  )
                    ? 403
                    : [
                          "UPLOAD_BUSY",
                          "PROJECT_BUSY",
                          "OFFSET_MISMATCH",
                          "CHUNK_CONFLICT",
                          "VERSION_CONFLICT",
                        ].includes(error.code)
                      ? 409
                      : 400,
                )
              : error instanceof AuthError
                ? json(
                    { error: error.code, error_description: error.message },
                    error.status,
                  )
                : json(
                    {
                      error:
                        error instanceof SyntaxError ||
                        error instanceof TypeError
                          ? "invalid_request"
                          : "server_error",
                    },
                    error instanceof SyntaxError || error instanceof TypeError
                      ? 400
                      : 500,
                  );
        }
        // Chromium also applies form-action to redirects after a form POST.
        response = harden(
          response,
          new URL(request.url).pathname === "/oauth/authorize"
            ? [
                ...new Set(
                  config.oauth.redirects.map((uri) => new URL(uri).origin),
                ),
              ]
            : [],
        );
        const origin = request.headers.get("origin");
        if (origin && config.origins.includes(origin)) {
          response.headers.set("Access-Control-Allow-Origin", origin);
          response.headers.set("Vary", "Origin");
          response.headers.set(
            "Access-Control-Expose-Headers",
            "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version, Content-Range",
          );
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      } finally {
        inFlight--;
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  let stopped;
  const close = () =>
    (stopped ??= (async () => {
      closing = true;
      clearInterval(timer);
      const ended = new Promise((resolve) => server.close(resolve));
      try {
        await Promise.allSettled([
          handler.close(),
          ...[...principals.values()].map((entry) => entry.jobs.close()),
          ...[...principals.values()].map((entry) => entry.assets.close()),
        ]);
      } finally {
        principals.clear();
        server.closeAllConnections();
        await ended;
        auth.close();
      }
    })());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    clearInterval(timer);
    try {
      await handler.close();
    } finally {
      auth.close();
    }
    throw error;
  }
  return {
    server,
    auth,
    principals,
    close,
    url: `http://${config.host === "::1" ? "[::1]" : config.host}:${server.address().port}`,
    config,
  };
}
