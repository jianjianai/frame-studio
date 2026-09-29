import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { rasterCover } from "../../server/covers.mjs";

test("SVG and misleading image extensions only produce bounded WebP covers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cover-"));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>window.coverScriptExecuted=true;</script><rect width="200" height="100" fill="red"/></svg>';
  try {
    for (const name of ["poster.svg", "poster.png"]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, svg);
      const { buffer, etag } = await rasterCover(file);
      assert.equal((await sharp(buffer).metadata()).format, "webp");
      assert(!buffer.includes(Buffer.from("coverScriptExecuted")));
      assert.match(etag, /^"[a-f0-9]{64}"$/);
      assert.equal(fs.readFileSync(file, "utf8"), svg);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
