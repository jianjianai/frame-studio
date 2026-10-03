-- One editable checkout; validation reports describe its exact revision without source copies.
DO $$
BEGIN
  LOCK TABLE paseo_candidates IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM paseo_candidates) THEN
    RAISE EXCEPTION 'Paseo workspace migration requires auditing retained candidates and stopping their old validation workers before removing candidate records';
  END IF;
END $$;
ALTER TABLE paseo_work_bindings RENAME COLUMN draft_revision TO revision;
ALTER TABLE paseo_work_bindings DROP COLUMN baseline_fingerprint;
ALTER TABLE paseo_work_bindings DROP COLUMN baseline_mode_fingerprint;
ALTER TABLE paseo_work_bindings DROP COLUMN baseline_commit;
DROP TABLE paseo_candidates;
CREATE TABLE paseo_validations (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES paseo_work_bindings(work_id) ON DELETE CASCADE,
  revision text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  runtime_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','passed','failed','stale','cancelled')),
  result jsonb,
  error text,
  created timestamptz NOT NULL DEFAULT now(),
  updated timestamptz NOT NULL DEFAULT now(),
  UNIQUE(work_id,revision,runtime_fingerprint)
);
CREATE INDEX paseo_validations_work_state ON paseo_validations(work_id,state,generation);

CREATE FUNCTION frame_paseo_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row jsonb;
BEGIN
  row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  PERFORM pg_notify('frame_changes', jsonb_build_object('table',TG_TABLE_NAME,'work',row->>'work_id')::text);
  RETURN NULL;
END $$;
CREATE TRIGGER frame_paseo_binding_notify AFTER INSERT OR UPDATE OR DELETE ON paseo_work_bindings FOR EACH ROW EXECUTE FUNCTION frame_paseo_change();
CREATE TRIGGER frame_paseo_validation_notify AFTER INSERT OR UPDATE OR DELETE ON paseo_validations FOR EACH ROW EXECUTE FUNCTION frame_paseo_change();
