-- New installations keep provider settings in their native CLI and T3 home.
-- Existing credentials are retired only by the explicit, receipt-checked import.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='connections')
     AND NOT EXISTS (SELECT 1 FROM connections) THEN
    DROP TABLE connections;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM work_undos) THEN
    DROP TABLE work_undos;
  END IF;
END $$;
