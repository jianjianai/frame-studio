-- OAuth schema is versioned with the core database.
CREATE TABLE IF NOT EXISTS oauth_clients (id text PRIMARY KEY, name text NOT NULL, redirects jsonb NOT NULL, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS oauth_requests (id text PRIMARY KEY, client text NOT NULL REFERENCES oauth_clients(id), redirect text NOT NULL, challenge text NOT NULL, state text NOT NULL, csrf text NOT NULL, expires timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes (hash text PRIMARY KEY, client text NOT NULL REFERENCES oauth_clients(id), redirect text NOT NULL, challenge text NOT NULL, expires timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_grants (id uuid PRIMARY KEY, client text NOT NULL REFERENCES oauth_clients(id), access text UNIQUE NOT NULL, refresh text UNIQUE NOT NULL, resource text NOT NULL, scope text NOT NULL, access_expires timestamptz NOT NULL, refresh_expires timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS oauth_used_refresh (hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE);
