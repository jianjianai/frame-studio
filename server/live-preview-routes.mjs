import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { sendMedia } from "./media.mjs";
import { z } from "zod";

const types = {
  ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".flac": "audio/flac", ".aac": "audio/aac", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".bin": "application/octet-stream", ".sf2": "application/octet-stream", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};

export function livePreviewOperations({ add, works, livePreview }) {
  add("works_live_preview",
    "Open or renew an automatically updated source preview; optional task selects this work's isolated AI draft. No full build or audio pre-encoding.",
    { id: z.string().uuid(), task: z.string().uuid().optional(), ai: z.boolean().default(false) },
    async ({ id, task, ai }) => livePreview.start({ work: await works.get(id, { active: true }), task, ai }));
}

export function installLivePreview(app, livePreview) {
  app.get("/preview-live/:token/events", async (req, reply) => {
    const session = livePreview.getByCapability(req.params.token);
    let disposed = false, detach, heartbeat;
    const close = () => {
      if (disposed) return;
      disposed = true; clearInterval(heartbeat);
      session.emitter.off("revision", revision); session.emitter.off("error-state", failed); session.emitter.off("state", state);
      detach?.(); reply.raw.end();
    };
    let sentRevision = Number(req.headers["last-event-id"] || 0);
    const send = (event, value, id) => {
      if (disposed || reply.raw.destroyed) return;
      if (reply.raw.writableLength > 256 * 1024) { close(); return; }
      reply.raw.write((id ? "id: " + id + "\n" : "") + "event: " + event + "\ndata: " + JSON.stringify(value) + "\n\n");
    };
    const revision = value => {
      const gap = sentRevision > 0 && value.revision > sentRevision + 1;
      send("revision", gap ? { ...value, changes: { visual: true, audio: true, metadata: true } } : value, value.revision);
      sentRevision = value.revision;
    };
    const failed = value => send("error", value);
    const state = value => send("state", value);
    detach = livePreview.attach(session, close);
    reply.hijack();
    reply.raw.writeHead(200, {
      ...reply.getHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "X-Accel-Buffering": "no", "Connection": "keep-alive",
    });
    reply.raw.write("retry: 1500\n\n");
    session.emitter.on("revision", revision); session.emitter.on("error-state", failed); session.emitter.on("state", state);
    if (session.manifest) revision(session.manifest);
    if (session.error) failed(session.error);
    heartbeat = setInterval(async () => {
      if (disposed) return;
      try {
        livePreview.getByCapability(req.params.token);
        const work = await livePreview.db.one("SELECT deleted FROM works WHERE id=$1", [session.work]);
        if (!work || work.deleted) { send("expired", { message: "This work is unavailable" }); close(); return; }
        reply.raw.write(": heartbeat\n\n");
      } catch { send("expired", { message: "Live preview expired; reopen the work" }); close(); }
    }, 15000);
    heartbeat.unref();
    req.raw.once("close", close);
    return reply;
  });
  app.get("/preview-live/:token/manifest.json", async (req, reply) => {
    const session = livePreview.getByCapability(req.params.token);
    return reply.header("Access-Control-Allow-Origin", "*").header("Cache-Control", "no-store").send(livePreview.snapshot(session));
  });
  app.get("/preview-live/:token/*", async (req, reply) => {
    const session = livePreview.getByCapability(req.params.token),
      relative = req.params["*"] || "index.html";
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag")
      .header("Content-Security-Policy", "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'");
    if (relative === "index.html") {
      await livePreview.ready(session);
      const config = JSON.stringify({ sessionId: session.id, manifestUrl: "manifest.json", eventsUrl: "events" }).replaceAll("<", "\\u003c");
      const styles = session.shell.styles.map(file => '<link rel="stylesheet" href="' + file + '">').join("");
      const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Frame Studio · 实时预览</title>' + styles + '</head><body><div id="root"></div>' +
        '<script>window.__FRAME_LIVE_PREVIEW__=' + config + ';</script><script type="module" src="' + session.shell.playerUrl + '"></script></body></html>';
      return reply.type("text/html").header("Cache-Control", "no-store").send(html);
    }
    const audio = /^audio\/([a-f0-9]{64})\/(preview|economy)$/.exec(relative);
    if (audio) {
      const asset = session.assets.get(audio[1]);
      if (!asset || !/\.(?:wav|mp3|ogg|opus|flac|m4a|aac|aiff?|pcm)$/i.test(asset.src)) throw problem(404, "Audio source unavailable");
      const file = await livePreview.media.rendition(session, asset, audio[2]);
      reply.type("audio/mp4");
      return sendImmutable(req, reply, file, audio[1] + "-" + audio[2]);
    }
    const video = /^video\/([a-f0-9]{64})\/(preview|economy)$/.exec(relative);
    if (video) {
      const asset = session.assets.get(video[1]);
      if (!asset || !/\.(?:mp4|webm|mov|mkv|m4v)$/i.test(asset.src)) throw problem(404, "Video source unavailable");
      const file = await livePreview.media.rendition(session, asset, video[2], "video");
      reply.type("video/mp4");
      return sendImmutable(req, reply, file, video[1] + "-video-" + video[2]);
    }
    const image = /^image\/([a-f0-9]{64})\/(preview|economy)$/.exec(relative);
    if (image) {
      const asset = session.assets.get(image[1]);
      if (!asset || !/\.(?:png|jpe?g|webp|avif)$/i.test(asset.src)) throw problem(404, "Image source unavailable");
      const file = await livePreview.media.rendition(session, asset, image[2], "image");
      reply.type("image/webp");
      return sendImmutable(req, reply, file, image[1] + "-image-" + image[2]);
    }
    if (relative.startsWith("films/" + session.project + "/")) {
      const revision = req.query.v;
      let asset = typeof revision === "string" ? session.assetKeys.get(relative + ":" + revision) : null;
      if (!asset && !revision) {
        const latest = session.manifest?.assetRevisions[relative];
        asset = latest && session.assetKeys.get(relative + ":" + latest);
      }
      if (!asset) throw problem(404, "Project asset revision unavailable");
      const snapshot = session.mediaFiles.get(asset.revision);
      if (!snapshot) throw problem(404, "Project asset revision unavailable");
      reply.type(types[path.extname(relative).toLowerCase()] || "application/octet-stream");
      return sendImmutable(req, reply, snapshot.file, asset.revision, { cache: revision ? 31536000 : 0 });
    }
    // This list comes only from the bundler output. No project source, node_modules or arbitrary runtime path is served.
    if (session.files.has(relative)) {
      const file = confined(session.outDir, relative);
      reply.type(types[path.extname(file)] || "application/octet-stream");
      return sendImmutable(req, reply, file, path.basename(relative), { compress: true });
    }
    // Platform-owned decoder/font resources are read-only and stay under public; projects cannot add URLs here.
    if (/^(?:vendor|fonts)\//.test(relative)) {
      const file = confined(path.join(livePreview.root, "public"), relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw problem(404, "Runtime asset unavailable");
      reply.type(types[path.extname(file)] || "application/octet-stream");
      return sendMedia(req, reply, file, { cache: 31536000, compress: /\.(?:js|json|svg)$/.test(file) });
    }
    throw problem(404, "Live preview resource unavailable");
  });
}

function sendImmutable(req, reply, file, revision, { cache = 31536000, compress = false } = {}) {
  const etag = '"' + revision + '"';
  if (req.headers["if-none-match"] === etag && !req.headers.range)
    return reply.header("ETag", etag).header("Cache-Control", "private, max-age=" + cache + ", immutable").code(304).send();
  const encoding = req.headers["accept-encoding"] || "";
  let selected = file, compressed;
  if (compress && !req.headers.range) {
    reply.header("Vary", "Accept-Encoding");
    if (/\bbr\b/.test(encoding) && fs.existsSync(file + ".br")) { selected += ".br"; compressed = "br"; }
    else if (/\bgzip\b/.test(encoding) && fs.existsSync(file + ".gz")) { selected += ".gz"; compressed = "gzip"; }
  }
  if (compressed) reply.header("Content-Encoding", compressed);
  // sendMedia performs strict single-range validation and streams bounded chunks.
  return sendMedia(req, {
    header(name, value) {
      if (name.toLowerCase() === "etag") value = etag;
      if (name.toLowerCase() === "cache-control") value = "private, max-age=" + cache + (cache ? ", immutable" : ", must-revalidate");
      reply.header(name, value); return this;
    },
    code(status) { reply.code(status); return this; },
    send(body) { return reply.send(body); },
  }, selected, { cache, compress: false });
}
