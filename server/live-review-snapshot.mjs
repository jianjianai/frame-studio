import { problem } from "./security.mjs";

const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const snapshotRevision = /^[a-f0-9]{64}(?:-[a-f0-9]{64})?$/;

/** Frozen review identity includes compiled resources; old source-only snapshots remain addressable. */
export function liveReviewRevision({ sourceRevision, compiledRevision }) {
  if (!sha256.test(sourceRevision || "") || compiledRevision !== undefined && !sha256.test(compiledRevision))
    throw problem(400, "Invalid live review snapshot revision");
  return sourceRevision + (compiledRevision ? "-" + compiledRevision : "");
}
export function isLiveReviewRevision(value) {
  return typeof value === "string" && snapshotRevision.test(value);
}
export function liveReviewSnapshotKey(reference) {
  if (!uuid.test(reference?.liveSessionId || "")) throw problem(400, "Invalid live review snapshot session");
  return reference.liveSessionId + "/" + liveReviewRevision(reference);
}
export function liveReviewSnapshotPath(reference, project) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(project || "")) throw problem(400, "Invalid live review snapshot project");
  return "live-preview-references/" + liveReviewSnapshotKey(reference) + "/projects/" + project;
}
