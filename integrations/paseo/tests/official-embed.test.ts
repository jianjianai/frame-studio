// Maintainer harness: run with scripts/test-paseo-embed.mjs against the pinned patched official source.
import { test, expect } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Socket } from "node:net";
import { chromium, type Browser } from "playwright";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { buildHostWorkspaceOpenRoute } from "../../../app/src/utils/host-routes";
import { FrameBootstrapSchema } from "../../../../plugin-examples/frame/shared/bridge";

test("complete official Frame iframe loads, scopes transport, survives deep reload, and preserves native UI", async () => {
  const clone = path.resolve(import.meta.dirname, "../../../..");
  const cache = path.resolve(clone, "../prototype-browser");
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(path.join(cache, "owned-"));
  await writeFile(path.join(fixture, "scene.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", fixture]);
  const html = await readFile(
    path.join(clone, "packages/app/dist/index.html"),
    "utf8",
  );
  const sockets = new Set<Socket>();
  const frameSockets = new Set<Socket>();
  const observations: {
    connections: (string | undefined)[];
    requests: string[];
  } = { connections: [], requests: [] };
  let daemonPort = 0;
  let bootstrap: ReturnType<typeof FrameBootstrapSchema.parse> | null = null;
  const gateway = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${gateway.address() && typeof gateway.address() === "object" ? gateway.address().port : 0}`;
      const url = new URL(req.url ?? "/", origin);
      observations.requests.push(url.pathname);
      if (url.pathname === "/") {
        if (!bootstrap) throw new Error("bootstrap not initialized");
        res.setHeader("content-type", "text/html");
        const dto = JSON.stringify(bootstrap).replace(/</g, "\\u003c");
        const child =
          bootstrap.basePath +
          "?frameNonce=" +
          encodeURIComponent(bootstrap.nonce);
        res.end(`<!doctype html><html><head><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style></head><body>
          <iframe id="paseo" title="Official Paseo" src="${child}"></iframe>
          <script>
          const config=${dto}; window.bridgeObservations={messages:[],accepted:[],denied:0};
          addEventListener('message',event=>{
            const message=event.data;
            if(message?.type!=='frame-paseo-connect')return;
            const frame=document.querySelector('#paseo');
            if(event.source!==frame.contentWindow || event.origin!==location.origin ||
              message.nonce!==config.nonce || message.workId!==config.workId || message.version!==1){
              window.bridgeObservations.denied++; event.ports[0]?.close(); return;
            }
            const port=event.ports[0]; if(!port)return;
            port.onmessage=event=>{
              const request=event.data; if(request?.type!=='request')return;
              window.bridgeObservations.messages.push(request);
              let payload={};
              if(request.op==='context.read'||request.op==='context.subscribe')payload={time:2.5};
              if(request.op==='freeze.submit'){
                const input=request.payload; payload={version:1,workId:config.workId,agentId:input.agentId,
                  messageId:input.messageId,intentHash:'a'.repeat(64),context:input.context,
                  reviewReference:{status:'unversioned'},
                  attachment:{type:'text',mimeType:'text/plain',title:'Frame reference',text:'frozen frame at '+input.context.time}};
              }
              if(request.op==='message.accepted')window.bridgeObservations.accepted.push(request.payload.messageId);
              port.postMessage({type:'response',id:request.id,ok:true,payload});
            };
            port.postMessage({type:'connected',version:1,workId:config.workId,nonce:config.nonce});port.start();
          });
          </script></body></html>`);
        return;
      }
      if (bootstrap && url.pathname.startsWith(bootstrap.basePath + "api/")) {
        const proxy = httpRequest(
          {
            host: "127.0.0.1",
            port: daemonPort,
            method: req.method,
            path:
              "/" + url.pathname.slice(bootstrap.basePath.length) + url.search,
            headers: req.headers,
          },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(res);
          },
        );
        proxy.on("error", () => {
          res.statusCode = 502;
          res.end();
        });
        req.pipe(proxy);
        return;
      }
      if (
        url.pathname.startsWith("/paseo/_expo/") ||
        url.pathname.startsWith("/paseo/assets/") ||
        ["/paseo/favicon.ico", "/paseo/manifest.json"].includes(url.pathname)
      ) {
        const relative = decodeURIComponent(
          url.pathname.slice("/paseo/".length),
        );
        const file = path.resolve(clone, "packages/app/dist", relative);
        if (!file.startsWith(path.join(clone, "packages/app/dist") + path.sep))
          throw new Error("unsafe asset");
        const types: Record<string, string> = {
          ".js": "application/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".ttf": "font/ttf",
          ".woff2": "font/woff2",
          ".json": "application/json",
          ".wasm": "application/wasm",
        };
        res.setHeader(
          "content-type",
          types[path.extname(file)] ?? "application/octet-stream",
        );
        res.end(await readFile(file));
        return;
      }
      if (bootstrap && url.pathname.startsWith(bootstrap.basePath)) {
        if (url.searchParams.get("frameNonce") !== bootstrap.nonce) {
          res.statusCode = 403;
          res.end("Embed expired");
          return;
        }
        res.setHeader("content-type", "text/html");
        const config = JSON.stringify(bootstrap).replace(/</g, "\\u003c");
        res.end(
          html.replace(
            "<head>",
            `<head><script>globalThis.__PASEO_FRAME_EMBED__=${config};</script>`,
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "error");
    }
  });
  gateway.on("upgrade", (req, socket, head) => {
    if (!bootstrap || req.url?.split("?")[0] !== bootstrap.basePath + "ws") {
      socket.destroy();
      return;
    }
    observations.connections.push(req.url);
    const proxy = httpRequest({
      host: "127.0.0.1",
      port: daemonPort,
      path: "/ws",
      headers: req.headers,
    });
    proxy.on("upgrade", (response, upstream, buffered) => {
      frameSockets.add(socket);
      frameSockets.add(upstream);
      sockets.add(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`);
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined)
          socket.write(
            name +
              ": " +
              (Array.isArray(value) ? value.join(", ") : value) +
              "\r\n",
          );
      }
      socket.write("\r\n");
      if (buffered.length) socket.write(buffered);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    proxy.on("error", () => socket.destroy());
    proxy.end();
  });
  gateway.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string")
    throw new Error("gateway did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const providerPrompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    corsAllowedOrigins: [origin],
    mcpEnabled: false,
    daemonVersion: "0.10.2",
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => providerPrompts.push(prompt),
    }),
  });
  daemonPort = daemon.port;
  let client: DaemonClient | null = null;
  let browser: Browser | null = null;
  try {
    client = new DaemonClient({
      clientId: "frame-embed-prototype",
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.10.2",
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    const outside: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        new URL(request.url()).origin !== origin &&
        !request.url().startsWith("data:") &&
        !request.url().startsWith("blob:")
      )
        outside.push(request.url());
    });
    try {
      await client.connect();
      await client.fetchAgents({ scope: "active" });
      const created = await client.createWorkspace({
        source: { kind: "directory", path: fixture },
        title: "Frame embedded fixture",
      });
      if (!created.workspace)
        throw new Error(created.error ?? "workspace not created");
      const agent = await client.createAgent({
        provider: "claude",
        cwd: fixture,
        workspaceId: created.workspace.id,
        title: "Frame native chat",
        modeId: "bypassPermissions",
      });
      const info = client.getLastServerInfoMessage();
      if (!info) throw new Error("server info missing");
      const workId = randomUUID();
      bootstrap = FrameBootstrapSchema.parse({
        version: 1,
        workId,
        userScope: "fixture-user-scope-123",
        nonce: "fixture-embed-nonce-123456789",
        basePath: `/paseo/${workId}/`,
        parentOrigin: origin,
        serverId: info.serverId,
        workspaceId: created.workspace.id,
        label: "Frame fixture",
      });
      await page.goto(origin);
      const frame = page.frames().find((item) => item !== page.mainFrame());
      if (!frame) throw new Error("iframe not found");
      await frame.waitForFunction(
        () =>
          typeof Reflect.get(globalThis, "__PASEO_FRAME_BRIDGE__")?.request ===
          "function",
        { timeout: 45000 },
      );
      expect(
        await frame.evaluate(async () =>
          Reflect.get(globalThis, "__PASEO_FRAME_BRIDGE__").request(
            "context.read",
            {},
          ),
        ),
      ).toEqual({ time: 2.5 });
      await page.evaluate(
        (scope) => {
          const foreign = document.createElement("iframe");
          foreign.id = "foreign";
          foreign.style.display = "none";
          foreign.srcdoc =
            "<script>const pair=new MessageChannel();parent.postMessage(" +
            JSON.stringify({
              type: "frame-paseo-connect",
              version: 1,
              workId: scope.workId,
              nonce: scope.nonce,
            }) +
            "," +
            JSON.stringify(location.origin) +
            ",[pair.port2]);</script>";
          document.body.append(foreign);
        },
        { workId: bootstrap.workId, nonce: bootstrap.nonce },
      );
      await page.waitForFunction(
        () => Reflect.get(globalThis, "bridgeObservations").denied === 1,
      );
      await frame.evaluate(
        (scope) => {
          const pair = new MessageChannel();
          window.parent.postMessage(
            {
              type: "frame-paseo-connect",
              version: 1,
              workId: scope.workId,
              nonce: "wrong-nonce-authorization-123456",
            },
            location.origin,
            [pair.port2],
          );
        },
        { workId: bootstrap.workId },
      );
      await page.waitForFunction(
        () => Reflect.get(globalThis, "bridgeObservations").denied === 2,
      );
      expect(
        await frame.evaluate(async () =>
          Reflect.get(globalThis, "__PASEO_FRAME_BRIDGE__").request(
            "context.read",
            {},
          ),
        ),
      ).toEqual({ time: 2.5 });
      const deep =
        bootstrap.basePath.slice(0, -1) +
        buildHostWorkspaceOpenRoute(
          info.serverId,
          created.workspace.id,
          `agent:${agent.id}`,
        ) +
        "&frameNonce=" +
        bootstrap.nonce;
      await frame.goto(origin + deep);
      await frame
        .getByRole("textbox", { name: "Message agent..." })
        .first()
        .waitFor({ timeout: 60000 });
      expect(frame.url()).toContain(bootstrap.basePath);
      expect(new URL(frame.url()).searchParams.get("frameNonce")).toBe(
        bootstrap.nonce,
      );
      await page.screenshot({
        path: path.join(cache, "official-iframe-desktop.png"),
      });
      await frame
        .getByRole("textbox", { name: "Message agent..." })
        .first()
        .fill("Frame prototype message");
      await frame
        .getByRole("textbox", { name: "Message agent..." })
        .first()
        .press("Enter");
      await page.waitForFunction(
        () =>
          Reflect.get(globalThis, "bridgeObservations").accepted.length === 1,
        { timeout: 45000 },
      );
      const messages = await page.evaluate(
        () => Reflect.get(globalThis, "bridgeObservations").messages,
      );
      expect(
        messages.some((row: { op: string }) => row.op === "freeze.submit"),
      ).toBe(true);
      const timeline = await client.fetchAgentTimeline(agent.id);
      expect(JSON.stringify(timeline)).toContain("Frame prototype message");
      expect(JSON.stringify(providerPrompts)).toContain("frozen frame at 2.5");
      await frame.getByTestId("workspace-new-tab-button").first().click();
      await frame.getByTestId("workspace-new-tab-menu-agent").click();
      await frame.getByTestId("combined-model-selector").last().click();
      await frame.getByTestId("model-provider-claude").click();
      await frame.getByTestId("model-row-claude-haiku").click();
      const newComposer = frame
        .getByRole("textbox", { name: "Message agent..." })
        .first();
      await newComposer.fill("First message from official new-agent UI");
      await newComposer.press("Enter");
      await page.waitForFunction(
        () =>
          Reflect.get(globalThis, "bridgeObservations").accepted.length === 2,
        { timeout: 45000 },
      );
      const firstInputs = await page.evaluate(() =>
        Reflect.get(globalThis, "bridgeObservations").messages.filter(
          (item: { op: string }) => item.op === "freeze.submit",
        ),
      );
      expect(firstInputs[1].payload.agentId).not.toBe(agent.id);
      const firstTimeline = await client.fetchAgentTimeline(
        firstInputs[1].payload.agentId,
      );
      expect(JSON.stringify(firstTimeline)).toContain(
        "First message from official new-agent UI",
      );
      expect(JSON.stringify(providerPrompts[1])).toContain(
        "frozen frame at 2.5",
      );
      expect(providerPrompts).toHaveLength(2);
      await frame.goto(frame.url());
      await frame
        .getByRole("textbox", { name: "Message agent..." })
        .first()
        .waitFor({ timeout: 45000 });
      const previous = observations.connections.length;
      await page.context().setOffline(true);
      // CDP offline does not reliably close established WebSockets. Drop only this iframe tunnel.
      for (const socket of frameSockets) socket.destroy();
      frameSockets.clear();
      await page.waitForTimeout(800);
      await page.context().setOffline(false);
      await expect
        .poll(() => observations.connections.length, { timeout: 20000 })
        .toBeGreaterThan(previous);
      await page.setViewportSize({ width: 390, height: 844 });
      await frame
        .getByRole("textbox", { name: "Message agent..." })
        .first()
        .waitFor({ timeout: 10000 });
      await page.screenshot({
        path: path.join(cache, "official-iframe-mobile.png"),
      });
      const fits = await frame.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(fits).toBe(true);
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
      await writeFile(
        path.join(cache, "results.json"),
        JSON.stringify(
          {
            bootstrap,
            connections: observations.connections,
            errors,
            outside,
            assertions: [
              "real-official-full-ui",
              "same-work-ws",
              "foreign-frame-rejected",
              "wrong-nonce-rejected",
              "frozen-native-send",
              "frozen-first-new-agent-send",
              "deep-reload",
              "reconnect",
              "390px-no-overflow",
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await page
        .screenshot({ path: path.join(cache, "official-iframe-failed.png") })
        .catch(() => undefined);
      await writeFile(
        path.join(cache, "failure.json"),
        JSON.stringify(
          {
            error: String(error),
            errors,
            outside,
            observations,
            frames: page.frames().map((frame) => frame.url()),
            providerPrompts,
            bridge: await page.evaluate(() =>
              Reflect.get(globalThis, "bridgeObservations"),
            ),
            childBody: await page
              .frames()
              .find((item) =>
                item.url().startsWith(origin + bootstrap!.basePath),
              )
              ?.locator("body")
              .innerText(),
            body: await page.locator("body").innerText(),
          },
          null,
          2,
        ),
      );
      throw error;
    }
  } finally {
    await browser?.close();
    await client?.close();
    await daemon.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(fixture, { recursive: true, force: true });
  }
}, 180000);
