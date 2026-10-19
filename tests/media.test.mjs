import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { probe, gltfInfo, lottieInfo, panoramaSize } from "../server/media.mjs";
import { browserExecutable } from "../server/render.mjs";

/** A GLB cube (12 triangles) with one animation, "Spin", one second long. */
function cubeGlb() {
  const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  const times = new Float32Array([0, 1]);
  const turns = new Float32Array([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  const parts = [positions, indices, times, turns].map((array) => Buffer.from(array.buffer));
  const offsets = [];
  let length = 0;
  for (const part of parts) {
    offsets.push(length);
    length += Math.ceil(part.length / 4) * 4;
  }
  const bin = Buffer.alloc(length);
  parts.forEach((part, index) => part.copy(bin, offsets[index]));
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: length }],
    bufferViews: parts.map((part, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: part.length })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 3, componentType: 5126, count: 2, type: "VEC4" },
    ],
    animations: [{ name: "Spin", samplers: [{ input: 2, output: 3 }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

/** A Lottie square that slides across a 100×100 picture in one second. */
const SQUARE = {
  v: "5.7.0",
  fr: 30,
  ip: 0,
  op: 30,
  w: 100,
  h: 100,
  layers: [
    {
      ty: 4,
      ind: 1,
      nm: "square",
      ip: 0,
      op: 30,
      st: 0,
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 1, k: [{ t: 0, s: [20, 50, 0], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }, { t: 29, s: [80, 50, 0] }] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      shapes: [
        { ty: "rc", nm: "box", d: 1, s: { a: 0, k: [30, 30] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
        { ty: "fl", nm: "fill", c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
      ],
    },
  ],
};

/** A 4×2 Radiance HDR, flat (uncompressed) scanlines. */
const hdr = () => Buffer.concat([Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n", "latin1"), Buffer.alloc(4 * 2 * 4, 128)]);

/** The start of an EXR file: magic, version and a dataWindow attribute. */
function exrHeader(width, height) {
  const box = Buffer.alloc(16);
  box.writeInt32LE(0, 0);
  box.writeInt32LE(0, 4);
  box.writeInt32LE(width - 1, 8);
  box.writeInt32LE(height - 1, 12);
  const size = Buffer.alloc(4);
  size.writeInt32LE(16, 0);
  return Buffer.concat([Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]), Buffer.from("dataWindow\0box2i\0", "latin1"), size, box, Buffer.from([0])]);
}

describe("media the studio draws itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-media-"));
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it("reads what a glTF model holds without decoding it", async () => {
    expect(gltfInfo(write("cube.glb", cubeGlb()))).toEqual({ meshes: 1, triangles: 12, animations: [{ name: "Spin", duration: 1 }], skinned: false, materials: 0, textures: 0 });
    expect(await probe(path.join(dir, "cube.glb"))).toMatchObject({ kind: "model", triangles: 12 });
    expect((await probe(write("other.fbx", "Kaydara FBX Binary"))).kind).toBe("model");
  });

  it("tells Lottie animations from other JSON, and what their player cannot draw", async () => {
    expect(await probe(write("square.json", JSON.stringify(SQUARE)))).toMatchObject({ kind: "lottie", width: 100, height: 100, fps: 30, frames: 30, duration: 1 });
    expect((await probe(write("data.json", '{"a":1}'))).kind).toBe("file");
    const linked = { ...SQUARE, assets: [{ id: "img", w: 10, h: 10, p: "photo.png", u: "images/" }] };
    expect(lottieInfo(write("linked.json", JSON.stringify(linked)), 1000).problem).toMatch(/内嵌/);
    const scripted = structuredClone(SQUARE);
    scripted.layers[0].ks.r = { a: 0, k: 0, x: "var $bm_rt = time * 90;" };
    expect(lottieInfo(write("scripted.json", JSON.stringify(scripted)), 1000).problem).toMatch(/表达式/);
  });

  it("reads the size of HDR and EXR panoramas from their headers", async () => {
    expect(panoramaSize(write("sky.hdr", hdr()))).toEqual({ width: 4, height: 2 });
    expect(panoramaSize(write("sky.exr", exrHeader(2048, 1024)))).toEqual({ width: 2048, height: 1024 });
    expect(await probe(path.join(dir, "sky.hdr"))).toMatchObject({ kind: "environment", width: 4, height: 2 });
  });
});

describe("models, Lottie and panoramas in works and libraries", () => {
  let app, base, work;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const lib = "/api/repos/local/materials";
  const put = (file, content) => call(`${lib}/libraries/${encodeURIComponent("三维")}/upload?path=${encodeURIComponent(file)}&replace=1`, { method: "POST", raw: content });
  /** Ask for a thumbnail until it is drawn. */
  const thumbnail = async (route) => {
    let response = await call(route);
    for (let i = 0; response.status === 202 && i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      response = await call(route);
    }
    return response;
  };

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-media-app-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    await call(`${lib}/libraries`, { method: "POST", body: { name: "三维" } });
    await put("models/cube.glb", cubeGlb());
    await put("fx/square.json", JSON.stringify(SQUARE));
    await put("env/sky.hdr", hdr());
    work = await app.services.works.create({ title: "三维素材" });
  });
  afterAll(() => app.close());

  it("lists models, Lottie and panoramas with what they hold", async () => {
    const files = (await call(`${lib}/libraries/${encodeURIComponent("三维")}/files`)).body;
    expect(files.map((file) => [file.path, file.kind])).toEqual([
      ["env/sky.hdr", "environment"],
      ["fx/square.json", "lottie"],
      ["models/cube.glb", "model"],
    ]);
    expect(files.find((file) => file.kind === "model")).toMatchObject({ triangles: 12, animations: [{ name: "Spin", duration: 1 }] });
    expect(files.find((file) => file.kind === "lottie")).toMatchObject({ width: 100, height: 100, duration: 1, fps: 30 });
    // A work's own files say the same, with a version for their thumbnails.
    fs.mkdirSync(path.join(work.dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(work.dir, "public", "square.json"), JSON.stringify(SQUARE));
    const assets = (await call(`/api/works/local/${work.id}/assets`)).body;
    expect(assets).toEqual([expect.objectContaining({ path: "public/square.json", kind: "lottie", duration: 1, version: expect.any(String) })]);
    // Images, video and sound are shown by the browser itself: no thumbnail is drawn for them.
    await put("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect((await call(`${lib}/thumb?path=${encodeURIComponent("三维/logo.svg")}`)).status).toBe(400);
    // resources_search finds files too: by kind words and by what the README says about them.
    await tool("material_write", { repo: "local", library: "三维", operations: [{ op: "put", path: "README.md", content: "# 三维\n\n测试用的三维素材。\n\n- `fx/square.json`：红色方块滑过画面\n\n## Cube\n\nCube 是一个会转的立方体。\n" }] });
    const found = await tool("resources_search", { repo: "local", query: "红色方块" });
    expect(found.body.text).toContain("[文件 · Lottie] materials/三维/fx/square.json — `fx/square.json`：红色方块滑过画面");
    const models = await tool("resources_search", { repo: "local", query: "模型", kind: "file" });
    expect(models.body.data.files.map((item) => item.id)).toEqual(["materials/三维/models/cube.glb"]);
    // Named by its stem in the README ("Cube"), the model is found by what the README says.
    expect((await tool("resources_search", { repo: "local", query: "立方体", kind: "file" })).body.data.files[0].id).toBe("materials/三维/models/cube.glb");
    expect((await tool("resources_search", { repo: "local", query: "长颈鹿" })).body.text).toContain("也用英文关键词试一次");
  });

  it("puts models on the timeline and keeps their files locked", async () => {
    const cube = { id: "cube", source: { kind: "model", src: "materials/三维/models/cube.glb", spin: 90, environment: "materials/三维/env/sky.hdr" }, start: 0, duration: 2 };
    const placed = await tool("layers_edit", { work: work.id, operations: [{ op: "replace", document: { schemaVersion: 1, background: "#000000", clips: [cube] } }] });
    expect(placed.status).toBe(200);
    await app.services.works.commit(app.services.works.describe("local", work.id), "放模型");
    expect(Object.keys(app.services.materials.readLocks(work.dir)).sort()).toEqual(["三维/env/sky.hdr", "三维/models/cube.glb"]);
    // Caught before writing: an animation the file lacks, and too many 3D layers at once.
    const wrong = await tool("layers_edit", { work: work.id, operations: [{ op: "update", id: "cube", patch: { source: { animation: "Walk" } } }] });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("没有动画「Walk」（有：Spin）");
    const crowd = Array.from({ length: 13 }, (_, i) => ({ op: "add", clip: { ...cube, id: `c${i}`, start: 0.5 } }));
    expect((await tool("layers_edit", { work: work.id, operations: crowd, dryRun: true })).body.error.message).toContain("0.5 秒起同时有 14 个三维图层");
    // Removing fields needs no patch.
    expect((await tool("layers_edit", { work: work.id, operations: [{ op: "update", id: "cube", unset: ["source.spin"] }] })).status).toBe(200);
    expect((await tool("asset_view", { work: work.id, files: ["materials/三维/models/cube.glb"], animation: "Walk" })).body.error.message).toContain("没有动画「Walk」");
  });

  it.skipIf(!browserExecutable())("draws models, Lottie and panoramas for thumbnails, the AI and the picture", async () => {
    const model = await thumbnail(`${lib}/thumb?path=${encodeURIComponent("三维/models/cube.glb")}`);
    expect(model.status).toBe(200);
    expect((await sharp(model.body).metadata()).format).toBe("webp");
    const lottie = await thumbnail(`/api/works/local/${work.id}/assets/thumb?path=${encodeURIComponent("public/square.json")}`);
    expect(lottie.status).toBe(200);
    // The red square is in the picture.
    const { data, info } = await sharp(lottie.body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
    expect(red / (info.width * info.height)).toBeGreaterThan(0.03);

    const view = await tool("asset_view", { work: work.id, files: ["materials/三维/models/cube.glb", "materials/三维/fx/square.json", "materials/三维/env/sky.hdr"] });
    expect(view.status).toBe(200);
    expect(view.body.text).toContain("materials/三维/models/cube.glb：三维模型，12 个三角形");
    expect(view.body.text).toContain("动画：Spin（1 秒）");
    expect(view.body.text).toContain("materials/三维/fx/square.json：Lottie 动画 100×100 1 秒，30 fps");
    expect(view.body.text).toContain("全景图");
    expect(view.body.images).toHaveLength(1);
    expect(view.body.data.cells).toHaveLength(4 + 3 + 1);

    // The model layer in the work's picture: the cube covers the middle, the corners stay clear.
    const { frames } = await app.services.renderer.frames(app.services.works.describe("local", work.id), { times: [0.5], width: 320 });
    const picture = await sharp(frames[0].png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [...picture.data.subarray((y * picture.info.width + x) * 3, (y * picture.info.width + x) * 3 + 3)];
    const corner = at(2, 2);
    const middle = at(Math.floor(picture.info.width / 2), Math.floor(picture.info.height / 2));
    expect(middle).not.toEqual(corner);

    // A Lottie layer is drawn at its own shape: the square animation fills a square box.
    const square = { id: "square", source: { kind: "lottie", src: "materials/三维/fx/square.json" }, start: 0, duration: 1, transform: { x: 0.35, y: 0.1, width: 0.3, height: 0.3 * (16 / 9) } };
    await tool("layers_edit", { work: work.id, operations: [{ op: "replace", document: { schemaVersion: 1, background: "#000000", clips: [square] } }] });
    const lottieFrames = (await app.services.renderer.frames(app.services.works.describe("local", work.id), { times: [0.5], width: 320 })).frames;
    const shot = await sharp(lottieFrames[0].png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let squarePixels = 0;
    for (let i = 0; i < shot.data.length; i += 3) if (shot.data[i] > 200 && shot.data[i + 1] < 60 && shot.data[i + 2] < 60) squarePixels++;
    // The box is 96 px wide in a 320 px picture, the square 30% of the animation: about 29 × 29.
    expect(squarePixels).toBeGreaterThan(650);
    expect(squarePixels).toBeLessThan(1100);
    // Past the animation's end: refused before writing, naming the layer, the length and the formula.
    const late = await tool("layers_edit", { work: work.id, operations: [{ op: "update", id: "square", patch: { offset: 0.5, loop: 1 } }] });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toMatch(/图层「square」要播放到 .*square\.json 的第 1\.5 秒，但它只有 1 秒（动画时间 = offset \+ \(经过的时间 × rate \+ phase\)，有 loop 时括号部分对 loop 取余）$/);
  }, 180000);
});
