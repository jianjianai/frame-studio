import fs from "node:fs/promises";
import path from "node:path";
import { confinedAsync, fileSha256 } from "./project-files.mjs";

/** Copy only verified, bounded audio cache bytes; never mount another task's workspace. */
export async function seedPreviewAudio({ db, data, task, run }) {
  if (!task.repo || task.kind !== "build") return;
  const latest = await db.one(
    "SELECT id,result FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded' AND cleaned IS NULL ORDER BY created DESC,id DESC LIMIT 1",
    [task.repo, task.project],
  );
  const entry = latest?.result?.artifacts?.find(file => file.path?.endsWith("/index.html"));
  if (!entry || !entry.path.startsWith("projects/" + task.project + "/exports/")) return;
  const target = await confinedAsync(run, "projects/" + task.project + "/.cache/preview-audio-current");
  try {
    const source = await confinedAsync(path.join(data, "runs", latest.id), path.posix.dirname(entry.path));
    const index = await confinedAsync(source, "preview-audio.json");
    if ((await fs.stat(index)).size > 4 * 1024 * 1024) return;
    const manifest = JSON.parse(await fs.readFile(index, "utf8"));
    if (manifest.version !== 1 || !Array.isArray(manifest.tracks) || manifest.tracks.length > 32) return;
    const files = new Map();
    let bytes = 0;
    for (const track of manifest.tracks) {
      if (!Array.isArray(track.chunks) || track.chunks.length > 1800) return;
      for (const chunk of track.chunks) {
        if (!/^[a-f0-9]{64}$/.test(chunk.sha256) || chunk.file !== "preview-audio/" + chunk.sha256 + ".mp3" || !(chunk.bytes > 0 && chunk.bytes < 262144)) return;
        if (!files.has(chunk.file)) bytes += chunk.bytes;
        files.set(chunk.file, chunk);
      }
    }
    if (bytes > 512 * 1024 * 1024) return;
    await fs.mkdir(path.join(target, "preview-audio"), { recursive: true });
    for (const chunk of files.values()) {
      const sourceFile = await confinedAsync(source, chunk.file);
      if ((await fs.stat(sourceFile)).size !== chunk.bytes || await fileSha256(sourceFile) !== chunk.sha256) throw Error("Invalid audio cache");
      await fs.copyFile(sourceFile, await confinedAsync(target, chunk.file));
    }
    await fs.writeFile(path.join(target, "preview-audio.json"), JSON.stringify(manifest));
  } catch {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    // A retired/missing preview merely causes a cold build.
  }
}
