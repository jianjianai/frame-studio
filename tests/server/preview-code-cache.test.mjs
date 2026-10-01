import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "es-module-lexer/minimal/js";
import { rewritePreviewCode } from "../../src/engine/preview-code-cache.mjs";
const original =
  "https://example.test/preview-live/test/assets/project.js?v=hash";
const mapped = (url) =>
  url.endsWith("/shared.js")
    ? url
    : url.endsWith("/picture.png")
      ? "blob:cached-picture"
      : undefined;
test("syntax rewrite handles empty templates, escaped static and template imports", () => {
  const code =
    "import './sh\\u0061red.js';export {singleton} from './shared.js';const empty=``;import(`./shared.js`);";
  const transformed = rewritePreviewCode(code, original, mapped),
    imports = parse(transformed)[0];
  assert.equal(imports.length, 3);
  for (const item of imports)
    assert.equal(
      item.n,
      "https://example.test/preview-live/test/assets/shared.js",
    );
  assert.ok(transformed.includes("const empty=``"));
});
test("ordinary strings, tagged templates, comments and regex remain unchanged", () => {
  const inert =
    'const string="import.meta.url";const regex=/[\'"`]/;' +
    "const tag=String.raw`import('./shared.js') import.meta.url`;/* import('./shared.js') */";
  const transformed = rewritePreviewCode(
    inert + ";import('./shared.js');",
    original,
    mapped,
  );
  assert.ok(transformed.startsWith(inert + ";"));
  assert.equal(parse(transformed)[0].length, 1);
});
test("resource constructors and real import.meta use original module base", () => {
  const transformed = rewritePreviewCode(
    "export const picture=new URL('../picture.png',import.meta.url);export const base=import.meta.url;const text='import.meta.url';",
    original,
    mapped,
  );
  assert.ok(
    transformed.includes(
      'new URL("blob:cached-picture",' + JSON.stringify(original) + ")",
    ),
  );
  assert.ok(transformed.includes("const text='import.meta.url'"));
  assert.equal(parse(transformed)[0].filter((item) => item.d === -2).length, 0);
});
test("computed paths, nested imports and import.meta.resolve retain evaluation semantics", () => {
  const code =
    "export const load=name=>import(`./${name}.js`);export const nested=()=>import(import.meta.resolve('./shared.js'));";
  const transformed = rewritePreviewCode(code, original, mapped),
    imports = parse(transformed)[0];
  assert.equal(imports.filter((item) => item.d >= 0).length, 2);
  assert.equal(imports.filter((item) => item.d === -2).length, 0);
  assert.ok(transformed.includes("`./${name}.js`"));
  assert.ok(transformed.includes(JSON.stringify(original)));
  assert.ok(
    !transformed.includes("__FRAME_PREVIEW_MODULE_URL__"),
    "works in isolated worklet/worker globals",
  );
});
test("unknown resources and dynamic URL constructor values stay intact", () => {
  const code =
    "import './not-in-manifest.js';export const url=name=>new URL(name,import.meta.url);";
  const transformed = rewritePreviewCode(code, original, mapped);
  assert.equal(parse(transformed)[0][0].n, "./not-in-manifest.js");
  assert.ok(
    transformed.includes("new URL(name," + JSON.stringify(original) + ")"),
  );
});
