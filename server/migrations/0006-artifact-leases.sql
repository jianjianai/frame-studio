CREATE TABLE artifact_leases (
  id uuid PRIMARY KEY,
  task uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  expires timestamptz NOT NULL
);
CREATE INDEX artifact_leases_task ON artifact_leases(task,expires);
