import fs from "node:fs";
import path from "node:path";
import { createInflateRaw } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Node uses Windows wide/extended filesystem paths, including deeply nested dependencies.
if (process.argv[2] === "--cleanup-stage") {
  const stage = path.resolve(process.argv[3]);
  if (path.basename(stage) !== "files" || !/^(?:\.i-[a-f0-9]{16}|[a-z0-9-]+\.install-[a-f0-9]{32})$/.test(path.basename(path.dirname(stage)))) {
    throw Error("Unexpected installer cleanup path");
  }
  await fs.promises.rm(stage, { recursive: true, force: true });
  process.exit(0);
}
const archive = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
const file = await fs.promises.open(archive, "r");
try {
  const size = (await file.stat()).size;
  const tail = Buffer.alloc(Math.min(size, 65557));
  await file.read(tail, 0, tail.length, size - tail.length);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw Error("Invalid or multipart ZIP");
  const count = tail.readUInt16LE(end + 10);
  const centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
  if (count === 65535 || centralOffset + centralSize > size || centralSize > 64 * 1024 * 1024) throw Error("Unsupported ZIP directory");
  const central = Buffer.alloc(centralSize);
  await file.read(central, 0, central.length, centralOffset);
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (central.readUInt32LE(offset) !== 0x02014b50) throw Error("Invalid ZIP entry");
    const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10);
    const compressed = central.readUInt32LE(offset + 20), expanded = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28), extra = central.readUInt16LE(offset + 30), comment = central.readUInt16LE(offset + 32);
    const mode = (central.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    const localOffset = central.readUInt32LE(offset + 42);
    const name = central.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    offset += 46 + nameLength + extra + comment;
    if ((flags & 1) || ![0, 8].includes(method) || mode === 0xa000 || name.includes("\0") || name.includes(":")) throw Error("Unsupported or unsafe ZIP entry");
    const target = path.resolve(destination, name);
    if (!target.startsWith(destination + path.sep)) throw Error("ZIP entry escapes destination: " + name);
    if (name.endsWith("/")) { await fs.promises.mkdir(target, { recursive: true }); continue; }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const header = Buffer.alloc(30);
    await file.read(header, 0, 30, localOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw Error("Invalid ZIP file header");
    const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + compressed > centralOffset) throw Error("Invalid ZIP file range");
    if (!compressed) {
      if (expanded) throw Error("Invalid empty ZIP entry");
      await fs.promises.writeFile(target, "", { flag: "wx" });
      continue;
    }
    let received = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > expanded ? Error("ZIP entry exceeds declared size") : null, chunk);
    } });
    const input = fs.createReadStream(archive, { start, end: start + compressed - 1 });
    const output = fs.createWriteStream(target, { flags: "wx" });
    if (method === 8) await pipeline(input, createInflateRaw(), counter, output);
    else await pipeline(input, counter, output);
    if (received !== expanded) throw Error("ZIP entry size mismatch: " + name);
  }
  console.log(`Extracted ${count} entries`);
} finally { await file.close(); }
