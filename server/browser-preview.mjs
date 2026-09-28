import path from "node:path";
import { token, hash, problem } from "./security.mjs";
export async function browserPreview(db, task, { ai = false } = {}) {
  if (
    task.kind !== "build" ||
    task.state !== "succeeded" ||
    task.result?.previewVersion !== PREVIEW_VERSION
  )
    throw problem(409, "Generate a current work preview first");
  const index = task.result.artifacts?.find((a) =>
    a.name.endsWith("index.html"),
  );
  if (!index) throw problem(404, "Preview missing");
  if (task.cleaned) throw problem(410, "Preview expired; rebuild this work");
  const key = `preview-link:${task.id}:${ai ? "ai" : "player"}`;
  const cached = await db.setting(key);
  if (cached && cached.until > Date.now()) {
    const secret = cached.url.split("/")[2],
      capKey = "preview:" + hash(secret),
      cap = await db.setting(capKey);
    if (cap) {
      const until = Date.now() + 3600000;
      await db.setting(capKey, { ...cap, expires: until });
      await db.setting(key, { ...cached, until });
      return { url: cached.url, expires: new Date(until).toISOString() };
    }
  }
  const secret = token(),
    expires = Date.now() + 3600000;
  await db.setting("preview:" + hash(secret), {
    task: task.id,
    base: path.posix.dirname(index.path),
    expires,
    ai,
  });
  const url = "/preview/" + secret + "/index.html" + (ai ? "?ai=1" : "");
  await db.setting(key, { url, until: expires });
  return {
    url,
    expires: new Date(expires).toISOString(),
  };
}
import { PREVIEW_VERSION } from "./preview-version.mjs";
