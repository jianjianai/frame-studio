-- Actual task provenance is immutable once execution starts; old tasks remain explicitly unversioned.
ALTER TABLE tasks ADD COLUMN runtime jsonb;
CREATE INDEX tasks_preview_runtime ON tasks(repo,project,(result->>'runtimeFingerprint'),created DESC)
WHERE kind='build' AND state='succeeded' AND cleaned IS NULL;
