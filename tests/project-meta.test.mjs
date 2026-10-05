import { describe, expect, it } from "vitest";
import { readProjectSource, updateProjectSource, insertProjectProperty, setProjectFields } from "../server/project-meta.mjs";
import { createWorkFiles } from "../server/templates.mjs";

const source = createWorkFiles({ slug: "work-abc", title: "测试", width: 1080, height: 1920, duration: 12, fps: 30, description: "" })[
  "projects/work-abc/project.ts"
];

describe("project.ts static metadata", () => {
  it("reads literals and loaders without executing code", () => {
    const { meta, loads } = readProjectSource(source);
    expect(meta.title).toBe("测试");
    expect(meta.composition).toEqual({ width: 1080, height: 1920 });
    expect(loads).toEqual({ scene: "./scene", visual: "./visual.json" });
  });

  it("resolves local constants and rejects dynamic values", () => {
    const code = `const size = { width: 640, height: 360 };\nexport default { id: "a", composition: size, duration: 2 };`;
    expect(readProjectSource(code).meta.composition).toEqual({ width: 640, height: 360 });
    expect(() => readProjectSource(`export default { duration: Math.PI };`)).toThrow(/static|literal/i);
  });

  it("updates fields in place and keeps formatting", () => {
    const next = updateProjectSource(source, { title: "新标题", duration: 20 });
    expect(readProjectSource(next).meta).toMatchObject({ title: "新标题", duration: 20 });
    expect(next).toContain('load: () => import("./scene")');
  });

  it("inserts missing properties once", () => {
    const next = insertProjectProperty(source, "loadAudioDocument", '() => import("./audio.json")');
    expect(readProjectSource(next).loads.audioDocument).toBe("./audio.json");
    expect(insertProjectProperty(next, "loadAudioDocument", '() => import("./audio.json")')).toBe(next);
  });

  it("sets existing and new fields together", () => {
    const next = setProjectFields(source, { subtitles: [{ start: 0, end: 1, text: "hi" }], subtitle: "副标题", custom: 1 });
    const { meta } = readProjectSource(next);
    expect(meta.subtitles).toHaveLength(1);
    expect(meta.subtitle).toBe("副标题");
    expect(meta.custom).toBe(1);
  });
});
