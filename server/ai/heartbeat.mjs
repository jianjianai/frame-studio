import fs from "node:fs";
import { execFile } from "node:child_process";

/**
 * When a running turn's agent last heard from the model service. While the model thinks without
 * showing it (Claude sends its thinking back as a signature only) nothing reaches ACP, and the
 * API's keep-alive pings are dropped inside the agent; its own TCP connections are the only sign
 * that it still waits on a live answer. `ss` (iproute2) tells, per socket, how long ago it last
 * sent and last received data. Linux only: elsewhere, or without `ss`, there is no heartbeat.
 * Claude only, for now: the Anthropic API was seen to send its pings about every second while
 * the model thinks; whether Codex's service does the same hasn't been checked.
 */

/** A socket still receiving this long after its last send has an answer streaming in. */
const STREAMING_MS = 3000;
const LOOPBACK = /^\[?(?:127\.|::1\]|::ffff:127\.)/;

let available = process.platform === "linux";

/**
 * From `ss -tinpH state established`: for each process, how long ago (ms) one of its connections
 * to another host last received part of an answer. Connections to this machine (FRAME's own MCP)
 * and requests answered at once (telemetry) don't count.
 */
export function parseSockets(text) {
  const received = new Map();
  // A socket is a line with its addresses, then indented lines with its TCP figures.
  for (const record of text.split(/\n(?=\S)/)) {
    const [head, ...info] = record.split("\n");
    const peer = head.trim().split(/\s+/)[3];
    if (!peer || LOOPBACK.test(peer)) continue;
    const figures = info.join(" ");
    const sent = Number(/\blastsnd:(\d+)/.exec(figures)?.[1]);
    const ago = Number(/\blastrcv:(\d+)/.exec(figures)?.[1]);
    if (!(sent - ago >= STREAMING_MS)) continue;
    for (const [, pid] of head.matchAll(/pid=(\d+)/g)) received.set(Number(pid), Math.min(received.get(Number(pid)) ?? Infinity, ago));
  }
  return received;
}

function sockets() {
  return new Promise((resolve) => {
    execFile("ss", ["-tinpH", "state", "established"], { timeout: 5000, maxBuffer: 16 << 20 }, (error, stdout) => {
      if (error?.code === "ENOENT") available = false;
      resolve(error ? null : parseSockets(stdout));
    });
  });
}

/** Every process under each of `roots` (the roots included), with its command line. */
function processTrees(roots) {
  const children = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    // "pid (comm) state ppid …": comm may hold spaces and parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(name));
  }
  const trees = new Map();
  for (const root of roots) {
    const tree = [];
    for (const queue = [root]; queue.length;) {
      const pid = queue.pop();
      let command = "";
      try {
        command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {}
      tree.push({ pid, command });
      queue.push(...(children.get(pid) ?? []));
    }
    trees.set(root, tree);
  }
  return trees;
}

/**
 * For each of `turns` ({ id, sessionId, root }: the session, and the adapter process it runs in),
 * when its Claude CLI (the process under `root` with the session id on its command line) last
 * received part of an answer: a time, or null for no answer streaming in. A turn whose CLI isn't
 * found is left out, as are all when the sockets can't be read.
 */
export async function lastReceived(turns) {
  if (!available || !turns.length) return new Map();
  const received = await sockets();
  if (!received) return new Map();
  const now = Date.now();
  const trees = processTrees(new Set(turns.map((turn) => turn.root)));
  const result = new Map();
  for (const turn of turns) {
    const pids = (trees.get(turn.root) ?? []).filter((item) => item.command.includes(turn.sessionId)).map((item) => item.pid);
    if (!pids.length) continue;
    const ago = Math.min(...pids.map((pid) => received.get(pid) ?? Infinity));
    result.set(turn.id, Number.isFinite(ago) ? now - ago : null);
  }
  return result;
}
