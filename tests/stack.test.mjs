import { describe, expect, it } from "vitest";
import { cleanBrowserError, decodeMappings, mergeTimedErrors } from "../server/stack.mjs";
import { engineImportHint } from "../server/checks.mjs";

describe("browser error cleanup", () => {
  const work = { dir: "/data/works/local/ab12/projects/work-ab12" };
  it("keeps work and one engine frame with readable paths", () => {
    const raw = [
      "page.evaluate: TypeError: Cannot read properties of null (reading 'boom')",
      `    at Object.render (http://127.0.0.1:4310/@fs${work.dir}/scenes/bg.ts?t=17911:26:20)`,
      `    at Object.frame (http://127.0.0.1:4310/src/engine/compositor.ts:89:17)`,
      `    at async Object.prepareFrame (http://127.0.0.1:4310/src/engine/compositor.ts:149:15)`,
      "    at async <anonymous>:337:30",
    ].join("\n");
    expect(cleanBrowserError(raw, { work })).toBe(
      [
        "TypeError: Cannot read properties of null (reading 'boom')",
        "    at Object.render scenes/bg.ts:26:20",
        "    at Object.frame engine/compositor.ts:89:17",
      ].join("\n"),
    );
  });
  it("maps positions through the module's source map", () => {
    const file = `${work.dir}/scene.ts`;
    // Generated line 2 col 0 → original line 5 col 2 (segment "AAIE" after a blank first line).
    const vite = { environments: { client: { moduleGraph: { getModulesByFile: (f) => (f === file ? [{ transformResult: { map: { mappings: ";AAIE" } } }] : []) } } } };
    const raw = `Error: x\n    at render (http://h/@fs${file}:2:7)`;
    expect(cleanBrowserError(raw, { work, vite })).toBe("Error: x\n    at render scene.ts:5:3");
  });
  it("decodes VLQ mappings", () => {
    expect(decodeMappings("AAAA,CAAC;AACA")).toEqual([
      [
        [0, 0, 0, 0],
        [1, 0, 0, 1],
      ],
      [[0, 0, 1, 1]],
    ]);
  });
  it("merges one error reported at several times", () => {
    expect(mergeTimedErrors(["0:07.50 渲染失败：X", "0:09.95 渲染失败：X", "HTTP 404 /a"])).toEqual(["0:07.50、0:09.95 渲染失败：X", "HTTP 404 /a"]);
  });
  it("suggests the engine alias when a relative engine path is wrong", () => {
    expect(engineImportHint("scenes/bg.ts", "TS2307", "Cannot find module '../../src/engine/types' or its corresponding type declarations.")).toBe(
      '。改成 "@frame/engine/types"（任何层级都一样）',
    );
    expect(engineImportHint("scene.ts", "TS2307", "Cannot find module '../../src/engine/types'")).toBe("");
  });
});
