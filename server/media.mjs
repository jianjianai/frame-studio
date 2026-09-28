import fs from "node:fs";
import { createGzip } from "node:zlib";

/** Private resources remain authorized on every request, including range/304 requests. */
export function sendMedia(
  req,
  reply,
  file,
  { cache = 3600, compress = false } = {},
) {
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (compress) reply.header("Vary", "Accept-Encoding");
  reply
    .header("Accept-Ranges", "bytes")
    .header("ETag", etag)
    .header("Last-Modified", stat.mtime.toUTCString())
    .header("Cache-Control", `private, max-age=${cache}, must-revalidate`);
  if (req.headers["if-none-match"] === etag && !req.headers.range)
    return reply.code(304).send();
  const range = req.headers.range;
  if (
    range &&
    (!req.headers["if-range"] ||
      req.headers["if-range"] === stat.mtime.toUTCString())
  ) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = match?.[1] ? Number(match[1]) : undefined;
    let end = match?.[2] ? Number(match[2]) : undefined;
    if (start === undefined && end !== undefined) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else end = Math.min(end ?? stat.size - 1, stat.size - 1);
    if (
      !match ||
      start === undefined ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= stat.size
    ) {
      return reply
        .code(416)
        .header("Content-Range", `bytes */${stat.size}`)
        .send();
    }
    reply
      .code(206)
      .header("Content-Range", `bytes ${start}-${end}/${stat.size}`)
      .header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  if (
    compress &&
    /\bgzip\b/.test(req.headers["accept-encoding"] || "") &&
    stat.size > 1024
  ) {
    reply.header("Content-Encoding", "gzip").header("Vary", "Accept-Encoding");
    return reply.send(fs.createReadStream(file).pipe(createGzip()));
  }
  reply.header("Content-Length", stat.size);
  return reply.send(fs.createReadStream(file));
}
