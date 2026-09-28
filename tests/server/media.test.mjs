import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { sendMedia } from "../../server/media.mjs";
test("media streams byte ranges, validates cache and negotiates compressed variants", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-media-")),
    file = path.join(dir, "audio.bin"),
    data = Buffer.from("0123456789".repeat(500));
  fs.writeFileSync(file, data);
  const app = Fastify();
  app.get("/", (req, res) => sendMedia(req, res, file, { compress: true }));
  try {
    const full = await app.inject("/");
    assert.equal(full.statusCode, 200);
    assert.deepEqual(full.rawPayload, data);
    assert.equal(full.headers.vary, "Accept-Encoding");
    const middle = await app.inject({
      url: "/",
      headers: { range: "bytes=100-199" },
    });
    assert.equal(middle.statusCode, 206);
    assert.equal(middle.headers["content-range"], "bytes 100-199/5000");
    assert.deepEqual(middle.rawPayload, data.subarray(100, 200));
    const suffix = await app.inject({
      url: "/",
      headers: { range: "bytes=-40" },
    });
    assert.deepEqual(suffix.rawPayload, data.subarray(-40));
    for (const range of [
      "bytes=-0",
      "bytes=5000-",
      "bytes=20-10",
      "bytes=0-1,3-4",
      "bytes=-",
    ])
      assert.equal(
        (await app.inject({ url: "/", headers: { range } })).statusCode,
        416,
        range,
      );
    const cached = await app.inject({
      url: "/",
      headers: { "if-none-match": full.headers.etag },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.rawPayload.length, 0);
    const changed = await app.inject({
      url: "/",
      headers: {
        range: "bytes=0-2",
        "if-range": "Tue, 01 Jan 2000 00:00:00 GMT",
      },
    });
    assert.equal(changed.statusCode, 200);
    const gzip = await app.inject({
      url: "/",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(gzip.rawPayload), data);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
