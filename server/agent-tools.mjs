import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { fileSha256 } from "./project-files.mjs";
import { command } from "./process.mjs";
export function agentTools({ app, db, data, assets, actions, localMode = false }) {
  app.post("/api/agent/action", async (req) => {
    const task = req.agentTask;
    if (!task) throw problem(403, "Task credential required");
    const { name, args = {} } = req.body || {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw problem(400, "Tool args must be a JSON object");
    if (name === "question_create")
      return actions.interactions.create(task.id, args);
    if (name === "question_poll") {
      if (typeof args.id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.id))
        throw problem(400, "Invalid question id");
      return actions.interactions.poll(task.id, args.id);
    }
    if (name === "assets") {
      const limit = args.limit ?? 60,
        offset = args.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw problem(
          400,
          "assets requires limit 1..200 and a nonnegative integer offset",
        );
      return actions.call("assets_list", {
        search: args.search || "",
        limit,
        offset,
        repo: task.repo,
      });
    }
    if (name === "engines") return actions.call("engines_list", {});
    if (
      [
        "speech_providers",
        "engines_discover",
        "speech_status",
        "speech_cancel",
      ].includes(name)
    )
      return actions.call(name, args);
    if (name === "engine_add") {
      if (args.id)
        throw problem(
          403,
          "Task AI can add a custom engine, not replace existing configurations",
        );
      return actions.call("engines_save", args);
    }
    if (name === "engine_test") {
      const preview = await actions.call("speech_test", args);
      const relative = `projects/${task.project}/.cache/speech/${preview.task}.${preview.mime === "audio/wav" ? "wav" : "mp3"}`;
      const target = confined(path.join(data, "runs", task.id), relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(
        confined(path.join(data, "runs", preview.task), preview.path),
        target,
      );
      if (process.platform !== "win32" && !localMode)
        await command("chown", ["1000:1000", path.dirname(target), target]);
      return {
        path: relative,
        temporary: true,
        elapsedMs: preview.elapsedMs,
        requestId: preview.requestId,
        applied: preview.applied,
        warnings: preview.warnings,
        expiresAt: preview.expiresAt,
      };
    }
    if (name === "use" || name === "speech") {
      const speechResult =
        name === "speech"
          ? await actions.call("speech_generate", {
              ...args,
              repo: task.repo,
              project: undefined,
            })
          : null;
      const asset = speechResult?.asset || (await assets.get(args.asset));
      if (
        !(await db.one(
          "SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2",
          [asset.id, task.repo],
        ))
      )
        throw problem(403, "Material does not belong to this repository");
      if (asset.deleted) throw problem(409, "Material is in recycle bin");
      const root = path.join(data, "runs", task.id, "projects", task.project),
        ext = path
          .extname(asset.name)
          .replace(/[^.a-zA-Z0-9]/g, "")
          .slice(0, 12);
      const relative = `public/imports/${asset.sha.slice(0, 20)}${ext}`,
        dest = confined(root, relative);
      return db.lock("agent-material:" + task.id, async () => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && (await fileSha256(dest)) !== asset.sha)
          throw problem(409, "Material file was modified");
        await fs.promises.copyFile(path.join(data, "blobs", asset.sha), dest);
        const manifest = confined(root, "production/materials.json");
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        const refs = fs.existsSync(manifest)
          ? JSON.parse(fs.readFileSync(manifest, "utf8"))
          : [];
        if (!Array.isArray(refs))
          throw problem(409, "Invalid material manifest");
        fs.writeFileSync(
          manifest,
          JSON.stringify(
            [
              ...refs.filter((r) => r.asset !== asset.id),
              {
                asset: asset.id,
                path: relative,
                sha256: asset.sha,
                source: asset.license,
                name: asset.name,
              },
            ],
            null,
            2,
          ),
        );
        if (process.platform !== "win32" && !localMode)
          await command("chown", [
            "1000:1000",
            path.dirname(dest),
            dest,
            path.dirname(manifest),
            manifest,
          ]);
        return {
          asset: asset.id,
          path: `projects/${task.project}/${relative}`,
          url: `films/${task.project}/${relative.slice(7)}`,
          name: asset.name,
          mime: asset.mime,
          bytes: Number(asset.bytes),
          source: asset.license,
          ...(speechResult
            ? {
                requestId: speechResult.requestId,
                applied: speechResult.applied,
                warnings: speechResult.warnings,
              }
            : {}),
          nextAction:
            name === "speech" || asset.mime?.startsWith("audio/")
              ? "Add this URL to a file audioTrack in project.ts and measure its duration before aligning subtitles. Importing a material does not enable playback."
              : "Reference this URL from the current work's scene; importing does not modify the scene.",
        };
      });
    }
    throw problem(
      403,
      "Allowed: assets, engines, speech_providers, engines_discover, speech_status, speech_cancel, engine_add, engine_test, use and speech",
    );
  });
}
