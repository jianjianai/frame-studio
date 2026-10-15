import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { lastReceived, parseSockets } from "../server/ai/heartbeat.mjs";

const probes = process.platform === "linux" && spawnSync("ss", ["-V"]).status === 0;
/** An address of this machine other than loopback: connections to loopback don't count. */
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((item) => item?.family === "IPv4" && !item.internal)?.address;

/** A process with `id` on its command line that sends one line to `port` and keeps reading. */
function client(id, host, port) {
  const script = `const s=require("net").connect(${port},${JSON.stringify(host)},()=>s.write("ask\\n"));s.on("data",()=>{});s.on("error",()=>{});setTimeout(()=>{},60000);`;
  return spawn(process.execPath, ["-e", script, "--", `--session-id=${id}`], { stdio: "ignore" });
}

describe("heartbeat", () => {
  it("counts connections to other hosts that keep receiving after their last send", () => {
    const text = [
      '0      0      172.21.0.3:41932   160.79.104.10:443   users:(("claude",pid=11,fd=17))',
      "\t cubic wscale:8,10 rto:305 bytes_sent:81564 bytes_received:140591 lastsnd:1202728 lastrcv:1091 lastack:1091",
      // Telemetry: answered right after it was sent.
      '0      0      172.21.0.3:41940   160.79.104.10:443   users:(("claude",pid=11,fd=19))',
      "\t cubic bytes_sent:1200 bytes_received:300 lastsnd:5400 lastrcv:5200 lastack:5200",
      // FRAME's own MCP: loopback.
      '0      0       127.0.0.1:43514       127.0.0.1:3000  users:(("claude",pid=11,fd=68))',
      "\t cubic bytes_sent:1705 bytes_received:2729 lastsnd:1428181 lastrcv:20 lastack:20",
      '0      0       [::1]:43520       [::1]:3000  users:(("claude",pid=12,fd=9))',
      "\t cubic lastsnd:900000 lastrcv:10",
      // A socket two processes share; the older streaming socket of process 13 is not the latest.
      '0      0      10.0.0.2:50000   34.1.2.3:443   users:(("codex",pid=13,fd=3),("codex",pid=14,fd=3))',
      "\t cubic lastsnd:60000 lastrcv:400",
      '0      0      10.0.0.2:50002   34.1.2.3:443   users:(("codex",pid=13,fd=4))',
      "\t cubic lastsnd:90000 lastrcv:30000",
      "",
    ].join("\n");
    expect(Object.fromEntries(parseSockets(text))).toEqual({ 11: 1091, 13: 400, 14: 400 });
  });

  it.skipIf(!probes || !lan)(
    "tells when a session's process last received part of an answer",
    async () => {
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        // Asked once, then answers a little at a time, as a streaming reply with pings does.
        socket.once("data", () => {
          const timer = setInterval(() => socket.write("."), 200);
          socket.on("close", () => clearInterval(timer));
        });
        socket.on("error", () => {});
      });
      await new Promise((resolve) => server.listen(0, lan, resolve));
      const id = "heartbeat-" + Math.random().toString(36).slice(2);
      const child = client(id, lan, server.address().port);
      try {
        const turns = [
          { id: "a", sessionId: id, root: process.pid },
          { id: "b", sessionId: "not-running-anywhere", root: process.pid },
        ];
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Connected and answered at once so far: nothing streaming in yet.
        expect(await lastReceived(turns)).toEqual(new Map([["a", null]]));
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const at = (await lastReceived(turns)).get("a");
        expect(Date.now() - at).toBeLessThan(1500);
      } finally {
        child.kill();
        for (const socket of sockets) socket.destroy();
        server.close();
      }
    },
    15000,
  );

  describe("in the chat", () => {
    let app, ai, work, child;
    beforeAll(async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-heartbeat-"));
      app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
      ai = app.services.ai;
      work = await app.services.works.create({ title: "心跳" });
    });
    afterAll(() => {
      child?.kill();
      app.close();
    });

    it.skipIf(!probes)("sends the running Claude turns' heartbeats", async () => {
      const acp = "acp-" + Math.random().toString(36).slice(2);
      // A stand-in for the session's Claude CLI, under this process as the CLIs are under their adapter.
      child = client(acp, "127.0.0.1", 9);
      const meta = { id: "beat", work: work.id, repo: "local", agent: "claude", status: "running", queue: [], acpSessionId: acp };
      ai.sessions.set("beat", { meta, process: { agent: "claude", child: { pid: process.pid } }, attached: true });
      ai.sessions.set("codex", { meta: { ...meta, id: "codex", agent: "codex", acpSessionId: "x" }, process: { agent: "codex", child: { pid: process.pid } } });
      const events = [];
      const stop = app.services.events.subscribe((event) => event.type === "ai-heartbeat" && events.push(event));
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await ai.heartbeat();
        expect(events).toEqual([{ type: "ai-heartbeat", session: "beat", work: work.id, at: null }]);
        // What it heard once is kept while nothing streams in.
        ai.sessions.get("beat").heartbeat = 1000;
        await ai.heartbeat();
        expect(events.at(-1).at).toBe(1000);
      } finally {
        stop();
        ai.sessions.delete("beat");
        ai.sessions.delete("codex");
      }
    });
  });
});
