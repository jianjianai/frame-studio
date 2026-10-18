import sharp from "sharp";
import { z } from "zod";
import { workArg } from "./registry.mjs";
import { problem } from "../util.mjs";

/** Output beyond this is cut (the AI asked for too much; it can print less). */
const OUTPUT_MAX = 30000;

/** `abt/<shot>.json`, `<shot>`, or the full path → projects/<name>/abt/<shot>.json. */
export function shotPath(work, shot) {
  let name = String(shot).trim().replace(/\\/g, "/");
  if (name.startsWith(`projects/${work.slug}/`)) name = name.slice(`projects/${work.slug}/`.length);
  if (name.startsWith("abt/")) name = name.slice(4);
  if (!name.endsWith(".json")) name += ".json";
  if (!name || name.includes("/") || name.startsWith(".")) throw problem(400, `镜头写 abt/<镜头>.json（作品的 abt 文件夹里的文件）：${shot}`);
  return `projects/${work.slug}/abt/${name}`;
}

const shown = (relative) => relative.replace(/^projects\/[^/]+\//, "");

/** A picture for the AI: at most 1280 wide, as JPEG. */
async function fit(data) {
  const image = sharp(data);
  const meta = await image.metadata();
  return { data: await (meta.width > 1280 ? image.resize({ width: 1280 }) : image).jpeg({ quality: 80 }).toBuffer(), mimeType: "image/jpeg" };
}

/** What the add-on says about itself, in lines for the AI. */
export function describeBlender(link, live, work) {
  const state = live.state ?? {};
  const lines = [`Blender：连着（${link.name}${state.addon ? `，AB to T ${state.addon}` : ""}）`];
  const own = `${work.repo}/${work.id}`;
  if (state.shot?.path) {
    const where = state.shot.work === own ? "这个作品" : `另一个作品 ${state.shot.work}`;
    lines.push(
      `打开的镜头：${where}的 ${shown(state.shot.path)}，实时同步${state.live ? "开着（Blender 里的改动自动写回作品）" : "关着（改动不会写回，请用户在 AB to T 面板里打开）"}`,
    );
    if (state.uploading) lines.push(`有改动正在写回 FRAME`);
  } else lines.push(`打开的文件：${state.file || "未保存的新文件"}（不是从 FRAME 打开的镜头）`);
  if (state.conflict) lines.push(`⚠ 写回冲突：${state.conflict.message}`);
  if (state.error) lines.push(`连接上的问题：${state.error}`);
  if (state.activity?.length) lines.push(`最近在 Blender 里执行的：${state.activity.join("；")}`);
  return lines.join("\n");
}

export function registerBlenderTools(registry) {
  const { services } = registry;
  // Code runs on the user's computer: never for a read-only grant.
  const common = { signedIn: true };

  registry.add({
    name: "blender_status",
    title: "Blender 状态",
    ...common,
    readOnly: true,
    description:
      "用户电脑上的 Blender（装了 AB to T 插件、连着 FRAME）现在怎样：连没连着、开着哪个镜头、实时同步开没开、写回有没有冲突、最近执行过什么。用 blender_open / blender_run / blender_view 前不确定时先看；没连着时把结果里的说明转告用户。",
    input: { work: workArg },
    async run(_args, ctx) {
      const work = await ctx.work();
      const { blenders } = services;
      const live = blenders.connection(work.repo);
      if (!live) {
        let reason;
        try {
          blenders.require(work.repo);
        } catch (error) {
          reason = error.message;
        }
        const links = blenders.links(work.repo);
        const seen = links.find((item) => item.lastSeen);
        return { data: { online: false, links }, text: `${reason}${seen ? `\n（${seen.name} 上次在线 ${seen.lastSeen}）` : ""}` };
      }
      return { data: { online: true, name: live.link.name, state: live.state }, text: describeBlender(live.link, live, work) };
    },
  });

  registry.add({
    name: "blender_open",
    title: "在 Blender 里打开镜头",
    ...common,
    description:
      "在用户电脑上的 Blender 里打开作品的 AB to T 镜头（abt/<镜头>.json，abt-scene skill 做的 three 场景图层），让用户和你在 Blender 里一个参数一个参数地调。插件把镜头和它用的组件、字体、图片放到那台电脑上，第一次导入成 Blender 场景，以后打开上次的 .blend（保留手调），并开启实时同步：Blender 里的改动自动写回作品里的这个 JSON，FRAME 预览跟着刷新。导入以后以 Blender 为准：改这个镜头用 blender_run，不要再直接改 JSON（会和 Blender 冲突）。reimport 用作品里现在的 JSON 重新导入，会冲掉 Blender 里没写进 JSON 的调整，先问用户。",
    input: {
      work: workArg,
      shot: z.string().min(1).max(200).describe("镜头：abt/<镜头>.json（或只写镜头名）"),
      reimport: z.boolean().default(false).describe("用作品里现在的 JSON 重新导入（冲掉 Blender 里没写进 JSON 的调整，先问用户）"),
    },
    async run({ shot, reimport }, ctx) {
      const work = await ctx.work();
      const relative = shotPath(work, shot);
      const result = await services.blenders.open(work, relative, { reimport });
      const next = "之后改这个镜头用 blender_run（bpy、abt 可以直接用），看 Blender 里的画面用 blender_view。";
      return { data: result, text: `${result.message || `已在 Blender 里打开 ${shown(relative)}`}\n${next}` };
    },
  });

  registry.add({
    name: "blender_run",
    title: "在 Blender 里执行代码",
    ...common,
    description:
      "在用户电脑上的 Blender 里执行 Python（和 abt-scene skill 里的 bl.py 一样）：可以直接用 bpy、abt（AB to T 插件的 core：set_param、get_param、set_rotation、get_rotation…），print 出来的就是结果。只查、只改需要的对象，不要打印整个场景。每次执行记一步撤销（用户可以 Ctrl+Z）；开着从 FRAME 打开的镜头时改动自动写回作品。代码在用户的电脑上运行：只做和镜头有关的事，不读写镜头以外的文件、不联网、不启动其他程序。",
    input: {
      work: workArg,
      code: z.string().min(1).max(200000).describe("Python 代码"),
      timeout: z.number().int().min(5).max(600).default(60).describe("最多等几秒"),
    },
    async run({ code, timeout }, ctx) {
      const work = await ctx.work();
      const live = services.blenders.require(work.repo);
      const open = live.state?.shot?.work;
      if (open && open !== `${work.repo}/${work.id}`)
        throw problem(409, `Blender 里开着的是另一个作品（${open}）的镜头：先用 blender_open 打开这个作品的镜头`, "OTHER_WORK");
      const result = await live.call("run", { code }, { timeout: timeout * 1000 + 5000 });
      let output = String(result.output ?? "");
      if (output.length > OUTPUT_MAX) output = `${output.slice(0, OUTPUT_MAX)}\n…（还有 ${output.length - OUTPUT_MAX} 字没显示：只打印需要的部分）`;
      return { data: { ok: true }, text: output.trim() ? output : "（执行完成，没有输出）" };
    },
  });

  registry.add({
    name: "blender_view",
    title: "看 Blender 画面",
    ...common,
    readOnly: true,
    description:
      "看用户电脑上 Blender 里的画面（用那台电脑的显卡画）：camera 相机视角的视口预览（快，和 3D 视图的材质预览一样）；render 用场景的渲染引擎正式渲染一帧（EEVEE 或 Cycles，几秒到几分钟）；window 截 Blender 整个窗口（看用户在看什么、面板和节点）。frame 是第几帧，默认当前帧。最宽 1280。检查效果时取少量帧；FRAME 里的 three.js 画面用 preview_frames 看。",
    input: {
      work: workArg,
      what: z.enum(["camera", "render", "window"]).default("camera"),
      frame: z.number().int().optional().describe("第几帧（Blender 的帧号）"),
    },
    async run({ what, frame }, ctx) {
      const work = await ctx.work();
      const live = services.blenders.require(work.repo);
      const result = await live.call("view", { what, frame }, { timeout: what === "render" ? 10 * 60 * 1000 : 90 * 1000 });
      if (!result.image) throw problem(422, "Blender 没有返回画面");
      const label = { camera: "相机视角的视口预览", render: `渲染（${result.engine || "场景的渲染引擎"}）`, window: "Blender 窗口" }[what];
      return {
        data: { frame: result.frame, width: result.width, height: result.height },
        text: `${what === "window" ? "" : `第 ${result.frame} 帧，`}${label}（${result.width}×${result.height}）`,
        images: [await fit(Buffer.from(result.image, "base64"))],
      };
    },
  });
}
