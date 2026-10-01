-- Additive Paseo integration metadata. Core FRAME and legacy conversation data are unchanged.
CREATE TABLE paseo_work_bindings (
  work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  repo uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  project text NOT NULL,
  baseline_fingerprint text NOT NULL,
  baseline_mode_fingerprint text NOT NULL,
  baseline_commit text,
  draft_revision text NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  requested boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'cold' CHECK (state IN ('cold','starting','ready','stopped','failed')),
  daemon_generation bigint NOT NULL DEFAULT 0 CHECK (daemon_generation >= 0),
  endpoint text,
  container text,
  workspace_id text,
  server_id text,
  runtime_fingerprint text,
  image text,
  error text,
  last_observed timestamptz,
  native_summary jsonb,
  touched timestamptz NOT NULL DEFAULT now(),
  created timestamptz NOT NULL DEFAULT now(),
  updated timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paseo_work_bindings_runtime ON paseo_work_bindings(requested,state,updated);
CREATE TABLE paseo_message_contexts (
  work_id uuid NOT NULL REFERENCES paseo_work_bindings(work_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  message_id uuid NOT NULL,
  intent_hash text NOT NULL,
  envelope jsonb NOT NULL,
  review_reference jsonb,
  execution jsonb,
  created timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(work_id,agent_id,message_id)
);
CREATE TABLE paseo_candidates (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES paseo_work_bindings(work_id) ON DELETE CASCADE,
  repo uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  project text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  revision text NOT NULL,
  baseline_fingerprint text NOT NULL,
  baseline_mode_fingerprint text NOT NULL,
  baseline_commit text,
  run_id uuid NOT NULL UNIQUE,
  snapshot_fingerprint text NOT NULL,
  snapshot_mode_fingerprint text NOT NULL,
  runtime_fingerprint text,
  origin text NOT NULL CHECK (origin IN ('manual','agent','recovery')),
  state text NOT NULL DEFAULT 'queued_validation'
    CHECK (state IN ('queued_validation','validating','verified','publishing','applied','invalid','publish_failed','conflict','superseded')),
  result jsonb,
  error text,
  source_revision text,
  commit text,
  created timestamptz NOT NULL DEFAULT now(),
  updated timestamptz NOT NULL DEFAULT now(),
  UNIQUE(work_id,generation,revision)
);
CREATE INDEX paseo_candidates_work_state ON paseo_candidates(work_id,state,generation);
