ALTER TABLE tasks ADD COLUMN frozen jsonb;
ALTER TABLE tasks ADD COLUMN workspace_cleaned timestamptz;
ALTER TABLE tasks ADD COLUMN cleanup_error text;
CREATE INDEX tasks_workspace_cleanup ON tasks(state,workspace_cleaned)
  WHERE workspace_cleaned IS NULL;
