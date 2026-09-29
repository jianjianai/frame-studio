ALTER TABLE tasks ADD COLUMN controller_id uuid;
ALTER TABLE tasks ADD COLUMN launch_attempted_at timestamptz;
-- A claimed task is never automatically re-executed after controller failure.
CREATE INDEX tasks_controller_claim ON tasks(controller_id) WHERE state IN ('running','cancelling');
