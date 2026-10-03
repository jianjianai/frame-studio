-- The administrator explicitly retired FRAME conversations and authorized their
-- deletion. Native Paseo metadata, provider credentials and work history remain.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE kind='agent' AND state IN
    ('queued','running','cancelling','publishing','publish_failed')) THEN
    RAISE EXCEPTION 'Stop or finish legacy FRAME AI tasks before retiring the legacy schema';
  END IF;
END $$;

-- Exact ownership journal allows filesystem cleanup after a database restart.
-- It contains only retired identities, never chat content or provider secrets.
CREATE TABLE legacy_ai_cleanup (
  kind text NOT NULL CHECK (kind IN ('task','chat','undo')),
  id uuid NOT NULL,
  container text,
  PRIMARY KEY(kind,id)
);
INSERT INTO legacy_ai_cleanup(kind,id,container)
  SELECT 'task',id,container FROM tasks WHERE kind='agent';
INSERT INTO legacy_ai_cleanup(kind,id)
  SELECT 'chat',id FROM chats;
INSERT INTO legacy_ai_cleanup(kind,id)
  SELECT 'undo',id FROM work_undos WHERE task IN (SELECT id FROM tasks WHERE kind='agent');

DROP TRIGGER IF EXISTS frame_agent_task_state ON tasks;
DROP FUNCTION IF EXISTS frame_agent_task_state();
DROP TABLE agent_notifications;
DROP TABLE agent_questions;
DROP FUNCTION IF EXISTS frame_agent_question_state();
DROP TABLE agent_tokens;
DELETE FROM work_undos WHERE task IN (SELECT id FROM tasks WHERE kind='agent');
DELETE FROM artifact_leases WHERE task IN (SELECT id FROM tasks WHERE kind='agent');
DELETE FROM settings WHERE (key LIKE 'preview:%' OR key LIKE 'preview-link:%')
  AND value->>'task' IN (SELECT id::text FROM tasks WHERE kind='agent');
DELETE FROM events WHERE task IN (SELECT id FROM tasks WHERE kind='agent');
DELETE FROM tasks WHERE kind='agent';

-- General task notifications no longer depend on the retired chat column.
CREATE OR REPLACE FUNCTION frame_scoped_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; scope jsonb;
BEGIN
  item := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='tasks' THEN
    scope := jsonb_build_object('repo',item->>'repo','project',item->>'project','task',item->>'id');
  ELSIF TG_TABLE_NAME='events' THEN
    SELECT jsonb_build_object('repo',repo,'project',project,'task',id) INTO scope FROM tasks WHERE id=(item->>'task')::uuid;
  ELSIF TG_TABLE_NAME='work_undos' THEN
    SELECT jsonb_build_object('repo',repo,'project',project,'work',id,'task',item->>'task') INTO scope FROM works WHERE id=(item->>'work')::uuid;
  ELSE
    scope := jsonb_build_object('repo',item->>'repo','project',item->>'project','work',item->>'id');
  END IF;
  scope := COALESCE(scope,'{}'::jsonb);
  PERFORM pg_notify('frame_changes', (scope || jsonb_build_object('table',TG_TABLE_NAME))::text);
  IF TG_TABLE_NAME='works' AND TG_OP='UPDATE' THEN
    IF NEW.sync_state IS DISTINCT FROM OLD.sync_state THEN
      PERFORM pg_notify('frame_changes',(scope || jsonb_build_object('table','work_sync'))::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP INDEX IF EXISTS tasks_chat_recent;
ALTER TABLE tasks DROP COLUMN chat;
ALTER TABLE tasks DROP COLUMN interaction;
ALTER TABLE tasks DROP COLUMN input_wait_started;
ALTER TABLE tasks DROP COLUMN input_wait_ms;
DROP TABLE chats;
