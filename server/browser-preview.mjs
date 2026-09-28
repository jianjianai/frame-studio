import path from "node:path";
import { token, hash, problem } from "./security.mjs";
export async function browserPreview(db, task, { ai = false } = {}) {
  if (
    task.kind !== "build" ||
    task.state !== "succeeded" ||
    task.result?.previewVersion !== 3
  )
    throw problem(409, "Generate a current work preview first");
  const index = task.result.artifacts?.find((a) =>
    a.name.endsWith("index.html"),
  );
  if (!index) throw problem(404, "Preview missing");
  const secret = token(),
    expires = Date.now() + 3600000;
  await db.setting("preview:" + hash(secret), {
    task: task.id,
    base: path.posix.dirname(index.path),
    expires,
    ai,
  });
  return {
    url: "/preview/" + secret + "/index.html" + (ai ? "?ai=1" : ""),
    expires: new Date(expires).toISOString(),
  };
}
