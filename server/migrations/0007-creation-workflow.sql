-- V5 is additive: scene/audio protocol 1 and existing task records remain readable.
ALTER TABLE tasks ADD COLUMN request_input jsonb;
ALTER TABLE tasks ADD COLUMN execution jsonb;
ALTER TABLE tasks ADD COLUMN review_reference jsonb;
ALTER TABLE tasks ADD COLUMN base_commit text;
ALTER TABLE tasks ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE chats ADD COLUMN upstream_execution text;
ALTER TABLE connections ADD COLUMN auth_generation bigint NOT NULL DEFAULT 0;

-- A reversal has its own idempotency key and recovery journal; it never rewrites history.
CREATE TABLE work_undos (
  id uuid PRIMARY KEY,
  work uuid NOT NULL REFERENCES works(id),
  task uuid NOT NULL UNIQUE REFERENCES tasks(id),
  expected_commit text NOT NULL,
  expected_revision text NOT NULL,
  state text NOT NULL CHECK (state IN ('applying','succeeded','failed')),
  commit text,
  output_revision text,
  error text,
  created timestamptz NOT NULL DEFAULT now(),
  finished timestamptz
);
CREATE INDEX work_undos_work ON work_undos(work,created DESC);
