-- =============================================================================
-- 001_init.sql  --  Multi-tenant schema + PostgreSQL Row-Level Security (RLS)
--
-- This migration is IDEMPOTENT (safe to run repeatedly). It is applied by
-- scripts/setup-db.ts (`npm run db:setup`) and by the isolation test before it
-- inserts its fixtures.
--
-- The whole point: a row of `projects` / `users` can only ever be read or
-- written by the tenant that owns it, and that rule is enforced by the DATABASE
-- -- not by application code -- via RLS policies keyed off a per-session GUC,
-- `app.current_tenant`.
-- =============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+, so no extension is required
-- on PostgreSQL 16.

-- -----------------------------------------------------------------------------
-- Control-plane table: the registry of tenants.
-- A row here *is* a tenant, so this table is not itself tenant-scoped and has
-- no RLS. Only privileged/admin code should write to it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Tenant-scoped tables. Every row carries a tenant_id and is protected by RLS.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS users_tenant_id_idx    ON users (tenant_id);
CREATE INDEX IF NOT EXISTS projects_tenant_id_idx ON projects (tenant_id);

-- -----------------------------------------------------------------------------
-- Application role.
--
-- RLS is BYPASSED for superusers and for a table's owner. Isolation is only
-- actually enforced when queries run as a role that is neither. `app_user` is
-- that role: the app connects as a privileged role and then `SET ROLE app_user`
-- per transaction (see lib/db.ts), or -- in production -- you would give
-- `app_user` LOGIN + a password and connect directly as it.
--
-- NOLOGIN is fine here because we reach it via SET ROLE, which does not require
-- the role to be able to log in.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT                         ON tenants  TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO app_user;

-- -----------------------------------------------------------------------------
-- Turn RLS on.
--
-- ENABLE makes policies apply to normal roles. FORCE additionally makes them
-- apply to the table owner (defense in depth). Superusers still bypass RLS
-- entirely -- which is exactly why the app must not run tenant queries as one.
-- -----------------------------------------------------------------------------
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    FORCE  ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;

-- The predicate every policy shares:
--
--     tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
--
--   * current_setting('app.current_tenant', true) -> returns NULL (instead of
--     raising) when the GUC was never set on this session.
--   * NULLIF(..., '') -> also treats the empty string as "no tenant".
--   * uuid = NULL is NULL (not TRUE), so when no tenant is set NO row matches.
--
-- That gives a FAIL-CLOSED default: forget to set the tenant and you see
-- nothing, rather than everything.

-- projects: one explicit policy per command --------------------------------
DROP POLICY IF EXISTS projects_select ON projects;
CREATE POLICY projects_select ON projects
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS projects_insert ON projects;
CREATE POLICY projects_insert ON projects
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects
  FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS projects_delete ON projects;
CREATE POLICY projects_delete ON projects
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- users: same pattern (every tenant-scoped table gets the same treatment) ---
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS users_insert ON users;
CREATE POLICY users_insert ON users
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users
  FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS users_delete ON users;
CREATE POLICY users_delete ON users
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
