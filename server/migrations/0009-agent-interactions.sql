-- Interaction state is orthogonal to task execution. A waiting agent still owns
-- its isolated workspace and queue slot; no fake new turn is created for an answer.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS interaction jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_wait_started timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_wait_ms bigint NOT NULL DEFAULT 0;

CREATE TABLE agent_questions (
  id uuid PRIMARY KEY,
  task uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','answered','cancelled','expired')),
  answers jsonb,
  answer_key uuid,
  created timestamptz NOT NULL DEFAULT now(),
  answered timestamptz,
  expires timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE(task, request_key)
);
CREATE INDEX agent_questions_task_created ON agent_questions(task,created,id);
CREATE INDEX agent_questions_pending ON agent_questions(task) WHERE state='pending';
CREATE TABLE agent_notifications (
  id bigserial PRIMARY KEY,
  task uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  question uuid REFERENCES agent_questions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('question','completed','failed')),
  source text NOT NULL UNIQUE,
  created timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX agent_notifications_unread ON agent_notifications(id DESC) WHERE read_at IS NULL;

CREATE FUNCTION frame_agent_question_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending jsonb;
BEGIN
  SELECT jsonb_build_object('id', q.id, 'title', q.payload->>'title', 'created', q.created,
    'count', (SELECT count(*) FROM agent_questions WHERE task=NEW.task AND state='pending'))
    INTO pending FROM agent_questions q WHERE q.task=NEW.task AND q.state='pending' ORDER BY q.created,q.id LIMIT 1;
  UPDATE tasks SET interaction=pending,
    input_wait_ms=input_wait_ms + CASE WHEN pending IS NULL AND input_wait_started IS NOT NULL
      THEN greatest(0, (extract(epoch FROM (now()-input_wait_started))*1000)::bigint) ELSE 0 END,
    input_wait_started=CASE WHEN pending IS NULL THEN NULL ELSE coalesce(input_wait_started,now()) END
    WHERE id=NEW.task;
  IF TG_OP='INSERT' AND NEW.state='pending' THEN
    INSERT INTO agent_notifications(task,question,kind,source) VALUES(NEW.task,NEW.id,'question','question:'||NEW.id) ON CONFLICT DO NOTHING;
  ELSIF NEW.state<>'pending' THEN
    UPDATE agent_notifications SET read_at=coalesce(read_at,now()) WHERE question=NEW.id;
  END IF;
  PERFORM pg_notify('frame_changes','agent_questions');
  RETURN NULL;
END $$;
CREATE TRIGGER frame_agent_question_state AFTER INSERT OR UPDATE ON agent_questions FOR EACH ROW EXECUTE FUNCTION frame_agent_question_state();

CREATE FUNCTION frame_agent_task_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='agent' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state NOT IN ('running','queued') THEN
      UPDATE agent_questions SET state='cancelled' WHERE task=NEW.id AND state='pending';
    END IF;
    IF NEW.state IN ('succeeded','failed','publish_failed') THEN
      IF NEW.state='succeeded' THEN
        UPDATE agent_notifications SET read_at=coalesce(read_at,now()) WHERE task=NEW.id;
      END IF;
      INSERT INTO agent_notifications(task,kind,source) VALUES(NEW.id,
        CASE WHEN NEW.state='succeeded' THEN 'completed' ELSE 'failed' END,
        'task:'||NEW.id||':'||NEW.state) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER frame_agent_task_state AFTER UPDATE OF state ON tasks FOR EACH ROW EXECUTE FUNCTION frame_agent_task_state();
CREATE TRIGGER frame_changed_agent_notifications AFTER INSERT OR UPDATE OR DELETE ON agent_notifications FOR EACH STATEMENT EXECUTE FUNCTION frame_notify_change();
