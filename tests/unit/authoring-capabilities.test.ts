import { describe, expect, it } from "vitest";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { adapters, rendererIds } from "../../src/engine/adapters.mjs";
import {
  audioEngines as registryEngines,
  audioProcessors as registryProcessors,
} from "../../src/engine/audio-capabilities.mjs";
import { visualSourceSchema } from "../../src/engine/visual-document.mjs";
import {
  audioEngines,
  audioProcessors,
  audioProcessorSchema,
  audioSourceSchema,
} from "../../src/engine/audio-document.mjs";
import { authoringReferences } from "../../src/contracts/authoring.mjs";
import {
  authoringCapabilitySummary,
  capabilityCategories,
  capabilityFilterShape,
  getAuthoringCapabilities,
  renderCapabilityOverview,
} from "../../src/contracts/capabilities.mjs";

describe("authoring capability catalog", () => {
  it("derives every registered visual adapter, audio engine and processor", () => {
    const catalog = getAuthoringCapabilities();
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.defaultRenderer).toBe("composition");
    expect(catalog.categories).toEqual([
      "visual",
      "media",
      "animation",
      "audio",
    ]);
    expect(new Set(catalog.items.map((item) => item.id)).size).toBe(
      catalog.items.length,
    );
    for (const adapter of adapters) {
      const item = catalog.items.find((item) => item.id === adapter.id)!;
      expect(item.name).toBe(adapter.name);
      expect(item.category).toBe(
        adapter.category === "media" ? "media" : "visual",
      );
      expect(item.supports).toMatchObject({
        template: adapter.template,
        seek: adapter.seek,
        alpha: adapter.alpha,
        offline: adapter.offline,
      });
      expect(item.sources).toContain("src/engine/adapters.mjs");
    }
    for (const engine of audioEngines) {
      const item = catalog.items.find((item) => item.id === engine.id)!;
      expect(item).toMatchObject({
        name: engine.name,
        kind: "generator-adapter",
        category: "audio",
      });
      expect(item.supports).toMatchObject({
        realtime: engine.realtime,
        offline: engine.offline,
      });
      expect(item.sources).toContain("src/engine/audio-document.mjs");
    }
    expect(
      catalog.items
        .filter((item) => item.kind === "processor")
        .map((item) => item.integration.processorType),
    ).toEqual(audioProcessors.map((processor) => processor.id));
  });

  it("keeps pure audio registries identical to public exports and exactly equal to schemas", () => {
    expect(audioEngines).toBe(registryEngines);
    expect(audioProcessors).toBe(registryProcessors);
    const processors = z.toJSONSchema(audioProcessorSchema).oneOf!;
    expect(
      processors.map((option) => {
        const type = option.properties!.type;
        if (typeof type !== "object")
          throw new Error("Processor discriminator must be a schema object");
        return type.const;
      }),
    ).toEqual(registryProcessors.map((processor) => processor.id));
    const sources = z.toJSONSchema(audioSourceSchema).oneOf!;
    const generated = sources.find((option) => {
      const kind = option.properties!.kind;
      return typeof kind === "object" && kind.const === "generated";
    })!;
    const engines = generated.properties!.engine;
    if (typeof engines !== "object")
      throw new Error("Generator engines must be a schema object");
    expect(engines.enum).toEqual(registryEngines.map((engine) => engine.id));
  });

  it("makes real Three model/animation/postprocessing helpers discoverable without implying automatic postprocessing", () => {
    for (const query of [
      "gltf",
      "Draco",
      "Meshopt",
      "KTX2",
      "bloom",
      "setAnimationTime",
    ])
      expect(
        getAuthoringCapabilities({ query }).items.map((item) => item.id),
      ).toContain("three");
    const three = getAuthoringCapabilities({ id: "three" }).items[0];
    expect(three.sources).toContain("src/engine/three-assets.ts");
    expect(three.integration.helpers?.map((helper) => helper.entry)).toContain(
      "createPostPipeline(renderer, scene, camera, bloom?)",
    );
    expect(three.requirements.join(" ")).toContain(
      "本身仍调用 renderer.render",
    );
    expect(three.requirements.join(" ")).toContain("自定义 Scene.render");
  });

  it("discovers the actual color source independently from renderer creation choices", () => {
    const color = getAuthoringCapabilities({ id: "color" }).items[0];
    expect(color).toMatchObject({
      kind: "asset-source",
      category: "media",
      supports: { template: false },
    });
    expect(rendererIds).not.toContain("color");
    expect(
      visualSourceSchema.parse({ kind: "color", color: "#12345678" }),
    ).toEqual({ kind: "color", color: "#12345678" });
    expect(
      getAuthoringCapabilities({ query: "纯色" }).items.map((item) => item.id),
    ).toContain("color");
  });

  it("links actual public modules, reference documents and declared packages", () => {
    const packages = JSON.parse(
      readFileSync("package.json", "utf8"),
    ).dependencies;
    for (const item of getAuthoringCapabilities().items) {
      expect(capabilityCategories).toContain(item.category);
      expect(item.integration.entry).toBeTruthy();
      expect(item.requirements.length).toBeGreaterThan(0);
      expect(item.sources.length).toBeGreaterThan(0);
      expect(authoringReferences).toHaveProperty(item.reference.key);
      expect(
        authoringReferences[
          item.reference.key as keyof typeof authoringReferences
        ].path,
      ).toBe(item.reference.path);
      expect(existsSync(item.reference.path), item.reference.path).toBe(true);
      for (const source of item.sources)
        expect(existsSync(source), source).toBe(true);
      if (item.integration.module.startsWith("src/"))
        expect(
          existsSync(item.integration.module),
          item.integration.module,
        ).toBe(true);
      if (item.package)
        expect(packages, item.package).toHaveProperty(item.package);
    }
  });

  it("explains the actual Remotion root and Canvas layer boundary", () => {
    const remotion = getAuthoringCapabilities({ id: "remotion" }).items[0];
    const composition = getAuthoringCapabilities({ id: "composition" })
      .items[0];
    expect(remotion.supports.canvasLayer).toBe(false);
    expect(remotion.supports.rootComposition).toBe(true);
    expect(remotion.integration.entry).toBe(
      "createRemotionScene(options, project)",
    );
    expect(remotion.requirements.join(" ")).toContain("不能放入 visual.json");
    expect(remotion.requirements.join(" ")).toContain("FrameScene");
    expect(composition.kind).toBe("composition");
    expect(composition.description).toContain("不预选");
    expect(
      getAuthoringCapabilities()
        .mixing.find((mix) => mix.id === "remotion-root")
        ?.requirements.join(" "),
    ).toContain("不能作为 visual.json");
  });

  it("distinguishes helper libraries and generator labels from automatic engines", () => {
    for (const id of ["gsap", "flubber"]) {
      const item = getAuthoringCapabilities({ id }).items[0];
      expect(item.kind).toBe("helper-library");
      expect(item.supports.template).toBe(false);
      expect(item.description).toContain("不是独立 renderer");
    }
    for (const id of audioEngines.map((engine) => engine.id)) {
      const item = getAuthoringCapabilities({ id }).items[0];
      expect(item.requirements.join(" ")).toContain("generators");
      expect(item.requirements.join(" ")).toContain("不会自动生成声音");
    }
    const worker = getAuthoringCapabilities({ id: "worker-pcm" }).items[0];
    expect(worker.requirements.join(" ")).toContain("另提供模块");
    const soundfont = getAuthoringCapabilities({ id: "soundfont" }).items[0];
    expect(soundfont.requirements.join(" ")).toContain("SoundFont 采样库");
    expect(
      getAuthoringCapabilities({ id: "audio-processor-duck" }).items[0]
        .description,
    ).toContain("不是实际信号包络");
  });

  it("resolves the documented morph query to Flubber across bilingual usage", () => {
    for (const query of ["morph", "MORPH", "路径形变"])
      expect(
        getAuthoringCapabilities({ category: "animation", query }).items.map(
          (item) => item.id,
        ),
      ).toEqual(["flubber"]);
  });

  it("filters by exact id/category and case-insensitive bounded query", () => {
    expect(
      getAuthoringCapabilities({ category: "media" }).items.map(
        (item) => item.id,
      ),
    ).toEqual(
      adapters
        .filter((adapter) => adapter.category === "media")
        .map((adapter) => adapter.id)
        .concat("color"),
    );
    expect(
      getAuthoringCapabilities({ query: " TONE.JS " }).items.map(
        (item) => item.id,
      ),
    ).toEqual(["tone", "audio-processor-tone"]);
    expect(
      getAuthoringCapabilities({ id: " three " }).items.map((item) => item.id),
    ).toEqual(["three"]);
    expect(
      getAuthoringCapabilities({ category: "audio", id: "three" }).items,
    ).toEqual([]);
    expect(
      getAuthoringCapabilities({ query: "there-is-no-such-capability" }).items,
    ).toEqual([]);
    expect(getAuthoringCapabilities({ query: "x".repeat(200) }).items).toEqual(
      [],
    );
  });

  it.each([
    { category: "3d" },
    { category: "" },
    { category: 1 },
    { id: "missing" },
    { id: "" },
    { id: "x".repeat(101) },
    { id: 3 },
    { query: "" },
    { query: " " },
    { query: "x".repeat(201) },
    { query: 3 },
    { unknown: true },
    { unknown: undefined },
    null,
    [],
  ])("rejects invalid filters %j", (options) => {
    try {
      getAuthoringCapabilities(options as never);
      expect.fail("invalid filters must fail");
    } catch (error) {
      expect(error).toHaveProperty("code", "INVALID_ARGUMENTS");
    }
  });

  it("exports exactly the shared strict filtering schema for every tool surface", () => {
    const schema = z.strictObject(capabilityFilterShape);
    expect(
      schema.parse({ query: " Three.js ", id: " three ", category: "visual" }),
    ).toEqual({ query: "Three.js", id: "three", category: "visual" });
    const properties = z.toJSONSchema(schema).properties!;
    expect(properties.query).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(properties.id).toMatchObject({ minLength: 1, maxLength: 100 });
    expect(schema.safeParse({ unknown: undefined }).success).toBe(false);
    expect(schema.safeParse({ category: "3d" }).success).toBe(false);
    expect(schema.safeParse({ query: "x".repeat(201) }).success).toBe(false);
  });

  it("does not let callers mutate future discovery results or registries", () => {
    const catalog = getAuthoringCapabilities();
    catalog.items[0].name = "mutated";
    catalog.items[0].requirements.push("mutated");
    catalog.mixing[0].requirements.push("mutated");
    catalog.categories.pop();
    const next = getAuthoringCapabilities();
    expect(next.items[0].name).toBe(adapters[0].name);
    expect(next.items[0].requirements).not.toContain("mutated");
    expect(next.mixing[0].requirements).not.toContain("mutated");
    expect(next.categories).toHaveLength(4);
  });

  it("keeps compact summaries complete and their discovery entrances consistent", () => {
    const catalog = getAuthoringCapabilities();
    const summary = authoringCapabilitySummary();
    expect(
      Object.values(summary.groups)
        .flat()
        .map((item) => item.id)
        .sort(),
    ).toEqual(catalog.items.map((item) => item.id).sort());
    expect(summary.discovery).toEqual({
      localCLI: "pnpm --silent film capabilities --json",
      mcp: "frame_capabilities",
      agent: "node scripts/work-tool.mjs capabilities",
      reference: "capabilities",
    });
    expect(summary.discovery).toEqual(catalog.discovery);
    expect(summary.mixing.map((mix) => mix.id)).toEqual(
      catalog.mixing.map((mix) => mix.id),
    );
    summary.groups.visual.pop();
    expect(
      Object.values(authoringCapabilitySummary().groups).flat(),
    ).toHaveLength(catalog.items.length);
  });

  it("renders a neutral complete README overview from the catalog", () => {
    const overview = renderCapabilityOverview();
    for (const item of getAuthoringCapabilities().items)
      expect(overview).toContain(item.name);
    expect(overview).toContain("不预选 2D/3D");
    expect(overview).toContain("Remotion DOM 不能");
    expect(overview).toContain("GSAP");
    expect(overview).toContain("Flubber");
    expect(overview).toContain("标签不自动生成内容");
    expect(overview).toContain("FrameScene");
    expect(overview).toContain("film capabilities --json");
  });
});
