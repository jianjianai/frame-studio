import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../mcp/helpers.mjs";
import {
  createRenderSession,
  framePng,
} from "../../scripts/render-session.mjs";

test(
  "visual Remotion sessions reuse frozen bundles across widths and invalidate on authored changes",
  { timeout: 300000 },
  async () => {
    const f = fixture({ browser: true, renderer: "remotion" });
    let session, first, cacheKey;
    try {
      for (let pass = 0; pass < 2; pass++) {
        session = await createRenderSession({
          root: f.root,
          width: pass ? 480 : 320,
        });
        const page = await session.page("test-film", { purpose: "visual" });
        const diagnostics = page.frameDiagnostics();
        assert.equal(diagnostics.remotionCache.reused, Boolean(pass));
        if (!pass) cacheKey = diagnostics.remotionCache.key;
        else assert.equal(diagnostics.remotionCache.key, cacheKey);
        assert.equal(page.metadata.renderer, "remotion");
        await assert.rejects(
          page.evaluate(() => true),
          /Visual-only/,
        );
        const png = await framePng(page, 0.5, false);
        const { default: sharp } = await import("sharp");
        assert.equal((await sharp(png).metadata()).width, pass ? 480 : 320);
        if (!pass) first = png;
        const snapshots = fs.readdirSync(f.file(".cache/production"));
        assert.ok(snapshots.length);
        for (const snapshot of snapshots)
          assert.equal(
            fs.existsSync(f.file(".cache/production/" + snapshot + "/dist")),
            false,
            "a native still must not build a redundant Frame preview",
          );
        await page.close();
        await session.close();
        session = undefined;
      }
      fs.writeFileSync(
        f.file("composition.tsx"),
        'import {AbsoluteFill} from "remotion"; export default function Film(){return <AbsoluteFill style={{background:"#ab1234"}}/>;}',
      );
      session = await createRenderSession({ root: f.root, width: 320 });
      const changed = await session.page("test-film", { purpose: "visual" });
      assert.equal(changed.frameDiagnostics().remotionCache.reused, false);
      assert.notEqual(changed.frameDiagnostics().remotionCache.key, cacheKey);
      assert.notDeepEqual(await framePng(changed, 0.5, false), first);
      await changed.close();
      await session.close();
      session = undefined;
      const controller = new AbortController();
      controller.abort();
      session = await createRenderSession({
        root: f.root,
        signal: controller.signal,
      });
      await assert.rejects(session.page("test-film", { purpose: "visual" }), {
        name: "AbortError",
      });
    } finally {
      await session?.close();
      f.close();
    }
  },
);
