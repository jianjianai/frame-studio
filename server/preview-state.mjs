import { treeHash } from "./security.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";

export async function readWorkPreview({ db, repos, work }) {
  const { dir } = await repos.project(work.repo, work.project);
  const sourceRevision = treeHash(dir);
  const latest = await db.one(
    "SELECT * FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded' AND cleaned IS NULL AND result->>'previewVersion'=$3 ORDER BY created DESC,id DESC LIMIT 1",
    [work.repo, work.project, String(PREVIEW_VERSION)],
  );
  return {
    sourceRevision,
    previewRevision: latest?.fingerprint || null,
    stale: !latest || latest.fingerprint !== sourceRevision,
    latest: latest || null,
  };
}
