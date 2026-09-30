import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
const [readyFile, payloadFile] = process.argv.slice(2);
const payload = payloadFile ? fs.readFileSync(payloadFile) : Buffer.alloc(2 * 1024 * 1024, 37);
const digest = createHash("sha256").update(payload).digest("hex"), requests = [];
let interrupted = false;
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, range: request.headers.range || null });
  if (request.url === "/stats") return response.end(JSON.stringify(requests));
  if (request.url === "/release") return response.end(JSON.stringify({ tag_name: "v7.5.1", draft: false, prerelease: false, body: "Desktop update acceptance", assets: [{ name: "FrameStudio-v7.5.1-win-x64-Setup.exe", digest: "sha256:" + digest, size: payload.length, browser_download_url: `http://127.0.0.1:${server.address().port}/resume` }] }));
  let offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
  if (request.url === "/ignore") offset = 0;
  if (offset >= payload.length) { response.writeHead(416); return response.end(); }
  if (offset) response.writeHead(206, { "Content-Range": `bytes ${offset}-${payload.length - 1}/${payload.length}`, "Content-Length": payload.length - offset });
  else response.writeHead(200, { "Content-Length": payload.length });
  if (request.url === "/interrupted" && !interrupted) { interrupted = true; response.write(payload.subarray(0, 65536)); setTimeout(() => response.destroy(), 80); return; }
  response.end(request.url === "/corrupt" ? Buffer.alloc(payload.length, 88) : payload.subarray(offset));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(readyFile, JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, digest, bytes: payload.length })));
