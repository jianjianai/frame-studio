-- FRAME metadata owns work identity and frozen references; T3 owns native sessions.
CREATE TABLE ai_work_bindings (
 work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
 repo uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
 project text NOT NULL,
 revision text NOT NULL,
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 requested boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'cold' CHECK(state IN ('cold','starting','ready','stopped','failed')),
 native_project_id uuid UNIQUE,
 environment_id text,
 cwd text UNIQUE,
 runtime_fingerprint text,
 image text,
 error text,
 last_observed timestamptz,
 native_summary jsonb,
 touched timestamptz NOT NULL DEFAULT now(),
 created timestamptz NOT NULL DEFAULT now(),
 updated timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_work_bindings_runtime ON ai_work_bindings(requested,state,updated);
CREATE TABLE ai_message_contexts (
 work_id uuid NOT NULL REFERENCES ai_work_bindings(work_id) ON DELETE CASCADE,
 thread_id text NOT NULL,
 message_id uuid NOT NULL,
 intent_hash text NOT NULL,
 envelope jsonb NOT NULL,
 review_reference jsonb,
 execution jsonb,
 created timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(work_id,thread_id,message_id),
 UNIQUE(work_id,message_id)
);
CREATE TABLE ai_message_assets (
 work_id uuid NOT NULL,
 thread_id text NOT NULL,
 message_id uuid NOT NULL,
 asset uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 PRIMARY KEY(work_id,thread_id,message_id,asset),
 FOREIGN KEY(work_id,thread_id,message_id) REFERENCES ai_message_contexts(work_id,thread_id,message_id) ON DELETE CASCADE
);
CREATE INDEX ai_message_assets_asset ON ai_message_assets(asset);
CREATE TABLE ai_validations (
 id uuid PRIMARY KEY,
 work_id uuid NOT NULL REFERENCES ai_work_bindings(work_id) ON DELETE CASCADE,
 revision text NOT NULL,
 generation bigint NOT NULL CHECK(generation>=0),
 runtime_fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','passed','failed','stale','cancelled')),
 result jsonb,
 error text,
 created timestamptz NOT NULL DEFAULT now(),
 updated timestamptz NOT NULL DEFAULT now(),
 UNIQUE(work_id,revision,runtime_fingerprint)
);
CREATE INDEX ai_validations_work_state ON ai_validations(work_id,state,generation);
CREATE FUNCTION frame_ai_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row jsonb;
BEGIN
 row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 PERFORM pg_notify('frame_changes',jsonb_build_object('table',TG_TABLE_NAME,'work',row->>'work_id')::text);
 RETURN NULL;
END $$;
CREATE TRIGGER frame_ai_binding_notify AFTER INSERT OR UPDATE OR DELETE ON ai_work_bindings FOR EACH ROW EXECUTE FUNCTION frame_ai_change();
CREATE TRIGGER frame_ai_validation_notify AFTER INSERT OR UPDATE OR DELETE ON ai_validations FOR EACH ROW EXECUTE FUNCTION frame_ai_change();
