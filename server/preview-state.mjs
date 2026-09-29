import { PREVIEW_VERSION } from "./preview-version.mjs";

/** Called for every subscription refresh: no directory walk or media reads here. */
export async function readWorkPreview({ db, work }) {
  const sourceRevision = work.source_revision || null;
  const latest = await db.one(
    "SELECT * FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded' AND cleaned IS NULL AND result->>'previewVersion'=$3 ORDER BY created DESC,id DESC LIMIT 1",
    [work.repo, work.project, String(PREVIEW_VERSION)],
  );
  return {
    sourceRevision, previewRevision: latest?.fingerprint || null,
    indexedAt: work.source_indexed_at || null, indexingRequired: !sourceRevision,
    stale: !sourceRevision || !latest || latest.fingerprint !== sourceRevision,
    latest: latest || null,
  };
}
