-- A frozen source folder is scoped by work and native message UUID.
CREATE UNIQUE INDEX paseo_message_identity ON paseo_message_contexts(work_id,message_id);
