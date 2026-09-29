-- Persisted tables remain the source of truth. Notifications contain identities only, never event contents or credentials.
CREATE FUNCTION frame_scoped_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; scope jsonb;
BEGIN
  item := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='tasks' THEN
    scope := jsonb_build_object('repo',item->>'repo','project',item->>'project','task',item->>'id','chat',item->>'chat');
  ELSIF TG_TABLE_NAME='events' THEN
    SELECT jsonb_build_object('repo',repo,'project',project,'task',id,'chat',chat) INTO scope FROM tasks WHERE id=(item->>'task')::uuid;
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
DROP TRIGGER frame_changed_tasks ON tasks;
DROP TRIGGER frame_changed_events ON events;
DROP TRIGGER frame_changed_works ON works;
CREATE TRIGGER frame_changed_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION frame_scoped_change();
CREATE TRIGGER frame_changed_events AFTER INSERT OR UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION frame_scoped_change();
CREATE TRIGGER frame_changed_works AFTER INSERT OR UPDATE OR DELETE ON works FOR EACH ROW EXECUTE FUNCTION frame_scoped_change();
CREATE TRIGGER frame_changed_undos AFTER INSERT OR UPDATE OR DELETE ON work_undos FOR EACH ROW EXECUTE FUNCTION frame_scoped_change();

CREATE OR REPLACE FUNCTION frame_notify_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='build' AND NEW.state='succeeded' THEN
    IF TG_OP='INSERT' THEN
      PERFORM pg_notify('frame_changes', jsonb_build_object('table','previews','repo',NEW.repo,'project',NEW.project,'task',NEW.id)::text);
    ELSIF NEW.state IS DISTINCT FROM OLD.state OR NEW.cleaned IS DISTINCT FROM OLD.cleaned THEN
      PERFORM pg_notify('frame_changes', jsonb_build_object('table','previews','repo',NEW.repo,'project',NEW.project,'task',NEW.id)::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION frame_notify_work_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM pg_notify('frame_changes',jsonb_build_object('table','work_sync','repo',NEW.repo,'project',NEW.project,'task',NEW.id)::text);
  END IF;
  RETURN NULL;
END $$;
