-- ---------------------------------------------------------------------------
-- Vendored from supabase/supabase docker/volumes/db/roles.sql (Postgres image
-- init script, first boot only: it runs when the data volume is empty).
--
-- Why it is needed: PostgREST connects as `authenticator`, GoTrue as
-- `supabase_auth_admin`, Storage API as `supabase_storage_admin`. Those roles
-- exist in the `supabase/postgres` image, but with the image's default
-- password, not ours. Without this file every one of the three fails to
-- authenticate and the stack starts but answers 500 on every request.
--
-- It is mounted to /docker-entrypoint-initdb.d/init-scripts/99-roles.sql.
-- ---------------------------------------------------------------------------

\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator            WITH PASSWORD :'pgpass';
ALTER USER pgbouncer                WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin      WITH PASSWORD :'pgpass';
ALTER USER supabase_functions_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin   WITH PASSWORD :'pgpass';
