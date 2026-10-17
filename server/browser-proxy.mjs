import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { privateAddress } from "./tools/asset-tools.mjs";

export const GUARD_HEADER = "x-frame-guard";

/**
 * A proxy on loopback that the logged-in browser sends everything through on a studio reachable
 * from the network: pages, frames, workers, downloads and sockets may reach public addresses
 * only, never the server's own network (SSRF). It resolves each host itself and connects to the
 * address it checked, so a name cannot change its answer in between (DNS rebinding).
 */
export async function startGuardProxy({ lookup = (host) => dns.lookup(host, { all: true }), blocked = privateAddress } = {}) {
  const resolve = async (host) => {
    const bare = host.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(bare) ? [bare] : (await lookup(bare).catch(() => [])).map((item) => item.address);
    if (!addresses.length) return { error: 502, reason: "找不到这个网址的服务器" };
    if (addresses.some(blocked)) return { error: 403, reason: "不能访问内网地址" };
    return { address: addresses[0] };
  };
  const refuse = (socket, status, reason) => {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}`);
  };
  /** Open a raw connection to host:port once the host is known to be public. */
  const tunnel = async (host, port, socket, onOpen) => {
    const target = await resolve(host);
    if (target.error) return refuse(socket, target.error, target.reason);
    const upstream = net.connect(Number(port), target.address, () => onOpen(upstream));
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  };

  const server = http.createServer(async (req, res) => {
    // Plain http: the request line carries the absolute URL.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") return void res.writeHead(400).end();
    const target = await resolve(url.hostname);
    // Marked, so the browser's owner can tell this refusal from a site's own 403.
    if (target.error) return void res.writeHead(target.error, { "Content-Type": "text/plain; charset=utf-8", [GUARD_HEADER]: "refused" }).end(target.reason);
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      { host: target.address, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers, setHost: false },
      (response) => {
        res.writeHead(response.statusCode, response.rawHeaders);
        response.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });
  // https and wss: a tunnel.
  server.on("connect", (req, socket, head) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
    if (!match) return refuse(socket, 403, "地址无效");
    void tunnel(match[1], match[2], socket, (upstream) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  // ws over plain http: the upgrade request goes on as it came, to the checked address.
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return refuse(socket, 403, "地址无效");
    }
    void tunnel(url.hostname, url.port || 80, socket, (upstream) => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
      for (let index = 0; index < req.rawHeaders.length; index += 2)
        if (!/^proxy-/i.test(req.rawHeaders[index])) lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  // Tunnels leave the HTTP server's hands: closing ends them too.
  const open = new Set();
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        for (const socket of open) socket.destroy();
      }),
  };
}
