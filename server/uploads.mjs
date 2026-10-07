import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { writeStream, uniquePath } from "./files.mjs";
import { problem, confined } from "./util.mjs";
import { probe } from "./media.mjs";
import { workArg } from "./tools/registry.mjs";

const LIFETIME_MS = 15 * 60 * 1000;

/**
 * Files on the AI's own computer (an AI connected over MCP, e.g. Claude Code on the user's
 * machine): the `upload_link` tool hands out one-time upload addresses, the AI runs curl,
 * and the bytes go straight to the work's public/ or a material library — never through
 * the conversation. An address is the credential: random, for one file at one place,
 * usable once, for 15 minutes.
 */
export function uploadsPlugin(services) {
  const { router, tools, works } = services;
  const links = new Map(); // token → { repo, id, path, library, replace, source, license, expires }
  const base = () => (services.config.publicUrl || services.baseUrl || "").replace(/\/$/, "");
  const sweep = () => {
    for (const [token, link] of links) if (link.expires < Date.now()) links.delete(token);
  };

  tools.add({
    name: "upload_link",
    published: true, // material libraries take uploads for a published work; its own files are checked below
    title: "上传本机文件",
    description:
      "需要把你所在电脑上的文件（图片、音频、视频、字体、模型等）放进作品的 public/ 或素材库时用：为每个文件返回一次性上传地址和 curl 命令，在你的终端执行即可，文件内容不经过对话（2 GB 以内）。地址 15 分钟内有效、只能用一次；上传成功的响应里有引用地址。网上的文件直接用 asset_import / material_write 的 url。",
    input: {
      work: workArg,
      files: z
        .array(
          z.strictObject({
            path: z.string().min(1).max(300).describe("放到哪里：作品里写 public/…（例如 public/img/logo.png）；素材库里写库内路径"),
            library: z.string().max(60).optional().describe("放进这个素材库（不写则放进作品）"),
            replace: z.boolean().default(false).describe("同名文件已存在时替换（默认另起名字）"),
            source: z.string().max(300).optional(),
            license: z.string().max(300).optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    async run({ files }, ctx) {
      const work = await ctx.work();
      sweep();
      const lines = [];
      const data = [];
      for (const file of files) {
        if (file.library) {
          const dir = await services.materials.dir(work.repo);
          services.materials.libraryOf(dir, file.library);
          confined(dir, `${file.library}/${file.path}`);
        } else {
          works.assertEditable(work);
          if (!/^(public|production)\//.test(file.path)) throw problem(400, `作品里的文件要放在 public/ 或 production/：${file.path}`);
          confined(work.dir, file.path);
        }
        const token = randomBytes(24).toString("base64url");
        links.set(token, { ...file, repo: work.repo, id: work.id, expires: Date.now() + LIFETIME_MS });
        const url = `${base()}/api/uploads/${token}`;
        const where = file.library ? `素材库「${file.library}」的 ${file.path}` : file.path;
        data.push({ target: where, url, command: `curl -fsS -T '<本机文件>' '${url}'` });
        lines.push(`${where}：\ncurl -fsS -T '<本机文件路径>' '${url}'`);
      }
      return {
        data: { uploads: data, expiresInMinutes: LIFETIME_MS / 60000 },
        text: `在你的终端执行（把 <本机文件路径> 换成文件的位置），15 分钟内有效、每个地址只能用一次：\n\n${lines.join("\n\n")}`,
      };
    },
  });

  /** The upload itself: the body is the file; the address says where it goes. */
  const receive = async ({ params, req }) => {
    sweep();
    const link = links.get(params.token);
    if (!link) throw problem(404, "上传地址无效、已用过或已过期：重新用 upload_link 获取", "NOT_FOUND");
    links.delete(params.token);
    if (link.library) {
      const saved = await services.materials.put(link.repo, link.library, link.path, { stream: req }, { source: link.source, license: link.license, replace: link.replace });
      const info = await probe(await services.materials.file(link.repo, {}, saved.ref)).catch(() => ({}));
      return { ok: true, ...saved, ...info };
    }
    const work = await services.openEditable(link.id, link.repo);
    const target = link.replace ? link.path : uniquePath(work.dir, link.path);
    const saved = await writeStream(work.dir, target, req, { overwrite: link.replace });
    if (link.license) {
      fs.mkdirSync(path.join(work.dir, "production"), { recursive: true });
      fs.appendFileSync(path.join(work.dir, "production", "licenses.md"), `- ${target}: ${link.license}\n`);
    }
    services.events.emit({ type: "assets", work: work.id, repo: work.repo });
    const info = await probe(path.join(work.dir, target)).catch(() => ({}));
    const url = target.startsWith("public/") ? `films/${work.slug}/${target.slice(7)}` : null;
    return { ok: true, path: target, ...(url ? { url } : {}), size: saved.size, ...info };
  };
  router.put("/api/uploads/:token", receive, { raw: true, public: true });
  router.post("/api/uploads/:token", receive, { raw: true, public: true });
}
