import fs from "node:fs";
import path from "node:path";
import { confined, problem, hash } from "./security.mjs";
import { command } from "./process.mjs";
export function agentTools({ app, db, data, assets, actions }) {
  app.post("/api/agent/action", async (req) => {
    const task = req.agentTask;
    if (!task) throw problem(403, "Task credential required");
    const { name, args = {} } = req.body || {};
    if (name === "assets")
      return actions.call("assets_list", {
        search: args.search || "",
        repo: task.repo,
      });
    if (name === "engines") return actions.call("engines_list", {});
    if (name === "use" || name === "speech") {
      const asset =
        name === "speech"
          ? (
              await actions.call("speech_test", {
                engine: args.engine,
                text: args.text,
                repo: task.repo,
                ...(args.voice ? { voice: args.voice } : {}),
              })
            ).asset
          : await assets.get(args.asset);
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
        if (fs.existsSync(dest) && hash(fs.readFileSync(dest)) !== asset.sha)
          throw problem(409, "Material file was modified");
        fs.copyFileSync(path.join(data, "blobs", asset.sha), dest);
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
        if (process.platform !== "win32")
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
        };
      });
    }
    throw problem(
      403,
      "Only assets, engines, use and speech are allowed for this task",
    );
  });
}
