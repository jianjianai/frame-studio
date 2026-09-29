ALTER TABLE works ADD COLUMN source_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE works ADD COLUMN source_revision text;
ALTER TABLE works ADD COLUMN source_indexed_at timestamptz;

-- UI access/sync changes do not invalidate content. Metadata and content updates do.
CREATE FUNCTION frame_invalidate_work_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.updated,NEW.title,NEW.category,NEW.status,NEW.description,NEW.deleted,NEW.branch)
     IS DISTINCT FROM (OLD.updated,OLD.title,OLD.category,OLD.status,OLD.description,OLD.deleted,OLD.branch) THEN
    NEW.source_generation := OLD.source_generation + 1;
    NEW.source_revision := NULL;
    NEW.source_indexed_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frame_work_revision BEFORE UPDATE ON works
FOR EACH ROW EXECUTE FUNCTION frame_invalidate_work_revision();
