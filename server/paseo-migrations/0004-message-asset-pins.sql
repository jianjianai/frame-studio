-- Native message references retain original asset bytes without duplicating media.
CREATE TABLE paseo_message_assets (
  work_id uuid NOT NULL,
  agent_id text NOT NULL,
  message_id uuid NOT NULL,
  asset uuid NOT NULL,
  PRIMARY KEY(work_id,agent_id,message_id,asset),
  FOREIGN KEY(work_id,agent_id,message_id)
    REFERENCES paseo_message_contexts(work_id,agent_id,message_id) ON DELETE CASCADE,
  CONSTRAINT paseo_message_assets_asset_fkey
    FOREIGN KEY(asset) REFERENCES assets(id) ON DELETE RESTRICT
);
CREATE INDEX paseo_message_assets_asset ON paseo_message_assets(asset);

-- Retain matching existing originals, including references already in the trash.
-- Missing or changed historical originals cannot be reconstructed from metadata.
INSERT INTO paseo_message_assets(work_id,agent_id,message_id,asset)
SELECT DISTINCT m.work_id,m.agent_id,m.message_id,a.id
FROM paseo_message_contexts m
JOIN paseo_work_bindings b ON b.work_id=m.work_id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(m.review_reference->'materials')='array'
    THEN m.review_reference->'materials' ELSE '[]'::jsonb END
) material
JOIN assets a ON a.id::text=lower(material->>'id')
JOIN asset_repos ar ON ar.asset=a.id AND ar.repo=b.repo
WHERE a.sha=material->>'sha256' AND a.bytes::text=material->>'bytes'
ON CONFLICT DO NOTHING;
