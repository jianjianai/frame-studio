import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ProjectService } from "./project-service.mjs";
import {
  AssetTransfers,
  CHUNK_BYTES,
  MAX_ASSET_BYTES,
  hashFile,
} from "./asset-transfer.mjs";
import { loadRemoteConfig } from "./mcp/remote-config.mjs";

let assets, client;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      license: { type: "string" },
      source: { type: "string" },
      filename: { type: "string" },
      sha256: { type: "string" },
      resume: { type: "string" },
      id: { type: "string" },
      "max-bytes": { type: "string" },
      remote: { type: "boolean" },
      endpoint: { type: "string" },
      "token-env": { type: "string", default: "FRAME_MCP_BEARER_TOKEN" },
      json: { type: "boolean" },
    },
  });
  const [project, action, source] = positionals;
  if (
    positionals.length > 3 ||
    ![
      "upload",
      "fetch",
      "status",
      "complete",
      "abort",
      "prune",
      "capabilities",
    ].includes(action)
  )
    throw new Error(
      "Usage: pnpm film asset <project> upload <file> --license <text> [--resume <id>] [--remote | --endpoint <url>] [--json]; or fetch <https-url> --filename <name> --license <text>; or status|complete|abort --id <id>; or prune|capabilities.",
    );
  assets = new AssetTransfers(
    new ProjectService(process.cwd(), { projects: [project] }),
  );
  let endpoint, token;
  if (values.remote) {
    const config = loadRemoteConfig(process.cwd(), { envFile: ".env" });
    endpoint = config.publicUrl;
    token = config.bearerToken;
  }
  if (values.endpoint) {
    endpoint = values.endpoint;
    token = process.env[values["token-env"]];
  }
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/mcp"].includes(url.pathname)
    )
      throw new Error("Use an HTTP(S) server origin or /mcp endpoint.");
    endpoint = url.origin;
    if (!token)
      throw new Error(
        "No Bearer token available; set the selected environment variable or configure .env with --remote.",
      );
  }
  const http = async (suffix, method = "GET", body, headers = {}) => {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(
          `${endpoint}/uploads/${encodeURIComponent(project)}${suffix}`,
          {
            method,
            headers: { Authorization: "Bearer " + token, ...headers },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          },
        );
      } catch {
        if (attempt >= 3)
          throw new Error(
            "Upload connection interrupted; resume with the printed uploadId.",
          );
        await delay(500 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = {};
      }
      if (
        attempt < 3 &&
        ([429, 502, 503, 504].includes(response.status) ||
          ["UPLOAD_BUSY", "PROJECT_BUSY"].includes(result.error?.code))
      ) {
        await delay(
          Math.min(
            60,
            Math.max(
              1,
              Number(response.headers.get("retry-after")) || 2 ** attempt,
            ),
          ) * 1000,
        );
        continue;
      }
      if (!response.ok || !result.uploadId) {
        const error = new Error(
          result.error?.message ??
            "Remote transfer failed: HTTP " + response.status,
        );
        error.details = result.error;
        throw error;
      }
      return result;
    }
  };
  const tool = async (name, args) => {
    client ??= new Client({ name: "frame-asset-cli", version: "1.0.0" });
    if (!client.transport)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
    const result = await client.callTool({
      name,
      arguments: { project, ...args },
    });
    if (result.isError)
      throw new Error(
        result.structuredContent?.error?.message ?? "Remote asset tool failed.",
      );
    return result.structuredContent;
  };
  const status = (id) =>
    endpoint ? http("/" + id) : assets.status(project, id);
  const complete = (id) =>
    endpoint
      ? http("/" + id + "/complete", "POST")
      : assets.complete(project, id);
  let result;
  if (action === "upload") {
    if (!source) throw new Error("Provide a local source file.");
    const file = path.resolve(source),
      stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_ASSET_BYTES)
      throw new Error(
        "Source must be a regular material file of 12 bytes..512 MiB.",
      );
    const hash = await hashFile(file);
    if (values.sha256 && values.sha256 !== hash)
      throw new Error("Source SHA-256 does not match --sha256.");
    const options = {
      filename: values.filename ?? path.basename(file),
      bytes: stat.size,
      sha256: hash,
      license: values.license,
      source: values.source ?? "Local upload: " + path.basename(file),
      requestId: randomUUID(),
    };
    if (!values.resume)
      console.error(
        JSON.stringify({
          uploadId: options.requestId,
          phase: "starting",
          bytes: options.bytes,
        }),
      );
    let state = values.resume
      ? await status(values.resume)
      : endpoint
        ? await http("", "POST", JSON.stringify(options), {
            "Content-Type": "application/json",
          })
        : assets.begin(project, options);
    if (
      state.bytes !== stat.size ||
      state.expectedSha256 !== hash ||
      state.filename !== options.filename
    )
      throw new Error("Resume source does not match the upload receipt.");
    console.error(
      JSON.stringify({
        uploadId: state.uploadId,
        receivedBytes: state.receivedBytes,
        bytes: state.bytes,
      }),
    );
    if (state.status !== "completed") {
      const fd = fs.openSync(file, "r");
      try {
        while (state.receivedBytes < stat.size) {
          const offset = state.receivedBytes;
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - offset));
          if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length)
            throw new Error("Source changed during upload.");
          state = endpoint
            ? await http("/" + state.uploadId, "PATCH", bytes, {
                "Content-Type": "application/octet-stream",
                "Upload-Offset": String(offset),
              })
            : assets.chunk(project, state.uploadId, offset, bytes);
          if (state.receivedBytes % (16 * CHUNK_BYTES) === 0)
            console.error(
              JSON.stringify({
                uploadId: state.uploadId,
                receivedBytes: state.receivedBytes,
                bytes: state.bytes,
              }),
            );
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    result = await complete(state.uploadId);
  } else if (action === "fetch") {
    const options = {
      url: source,
      filename: values.filename,
      license: values.license,
      ...(values.sha256 ? { sha256: values.sha256 } : {}),
      maxBytes: Number(values["max-bytes"] ?? MAX_ASSET_BYTES),
    };
    result = endpoint
      ? await tool("frame_fetch_asset", options)
      : assets.fetch(project, options);
    console.error(
      JSON.stringify({ uploadId: result.uploadId, status: result.status }),
    );
    while (result.status === "fetching") {
      if (endpoint) {
        await delay(1000);
        result = await status(result.uploadId);
      } else result = await assets.wait(project, result.uploadId, 20000);
    }
    if (result.status !== "completed") {
      const error = new Error(
        "Download did not publish; inspect uploadId or retry complete when status is ready.",
      );
      error.details = result;
      throw error;
    }
  } else if (action === "status") result = await status(values.id);
  else if (action === "complete") result = await complete(values.id);
  else if (action === "abort")
    result = endpoint
      ? await http("/" + values.id, "DELETE")
      : await assets.abort(project, values.id);
  else if (action === "prune")
    result = endpoint
      ? await tool("frame_asset_upload", { action: "prune" })
      : await assets.prune(project);
  else result = assets.capabilities();
  console.log(JSON.stringify(result, null, values.json ? 0 : 2));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error.code,
      error: error.message,
      details: error.details,
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  await assets?.close();
}
