import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PreviewSha256,
  previewBlobHash,
  loadPreviewResource,
  cachedBlobResponse,
} from "../../src/engine/preview-cache-storage.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("incremental preview SHA covers block boundaries and large banks", async () => {
  for (const length of [
    0,
    1,
    55,
    56,
    63,
    64,
    65,
    127,
    128,
    129,
    1024 * 1024 + 13,
  ]) {
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i++) data[i] = (i * 31 + (i % 7)) % 256;
    const h = new PreviewSha256();
    for (let at = 0; at < data.length; at += 17)
      h.update(data.subarray(at, at + 17));
    assert.equal(h.digest(), sha(data));
    assert.equal(await previewBlobHash(new Blob([data])), sha(data));
  }
});
test("cached blobs support closed, open, suffix and invalid byte ranges and HEAD", async () => {
  const blob = new Blob(["0123456789"], { type: "video/mp4" });
  for (const [range, text] of [
    ["bytes=2-4", "234"],
    ["bytes=7-", "789"],
    ["bytes=-3", "789"],
    ["bytes=0-99", "0123456789"],
  ]) {
    const response = cachedBlobResponse(blob, "https://frame.test/a", {
      headers: { Range: range },
    });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), text);
    assert.equal(Number(response.headers.get("Content-Length")), text.length);
  }
  for (const range of ["bytes=10-12", "bytes=4-2", "bytes=0-1,3-4", "bytes=-0"])
    assert.equal(
      cachedBlobResponse(blob, "https://frame.test/a", {
        headers: { Range: range },
      }).status,
      416,
    );
  assert.equal(
    await cachedBlobResponse(blob, "https://frame.test/a", {
      method: "HEAD",
    }).text(),
    "",
  );
});
test("persistent hits are verified, corruption repaired, and quota fallback is visible", async () => {
  const data = new Blob(["sample asset"]),
    hash = sha(Buffer.from(await data.arrayBuffer())),
    resource = {
      path: "films/demo/sample.wav",
      sha256: hash,
      bytes: data.size,
      url: "https://frame.test/sample",
      type: "audio/wav",
    };
  const entries = new Map();
  let downloads = 0;
  const cache = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => entries.set(key, response),
    delete: async (key) => entries.delete(key),
  };
  const options = {
    origin: "https://frame.test",
    cacheStorage: { open: async () => cache },
    fetcher: async () => {
      downloads++;
      return new Response(data);
    },
  };
  const first = await loadPreviewResource(resource, options);
  assert.equal(first.persistent, true);
  assert.equal(downloads, 1);
  await loadPreviewResource(resource, options);
  assert.equal(downloads, 1);
  entries.set([...entries.keys()][0], new Response("broken"));
  await loadPreviewResource(resource, options);
  assert.equal(downloads, 2);
  cache.put = async () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  entries.clear();
  const fallback = await loadPreviewResource(resource, options);
  assert.equal(fallback.persistent, false);
  assert.match(fallback.warning, /空间不足/);
  assert.equal(await fallback.blob.text(), "sample asset");
  await assert.rejects(
    loadPreviewResource({ ...resource, sha256: "0".repeat(64) }, options),
    /校验失败/,
  );
});
test("cancelled cache requests never publish partial bytes", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadPreviewResource(
      {
        path: "x",
        sha256: "0".repeat(64),
        bytes: 0,
        url: "https://frame.test/x",
      },
      {
        signal: controller.signal,
        origin: "https://frame.test",
        cacheStorage: null,
      },
    ),
    { name: "AbortError" },
  );
});
