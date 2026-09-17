-- uRide initial migration (Phase 0).
-- Extensions, base tables, RLS, and partition scaffold.
--
-- Notes:
--  * `gen_random_uuid()` comes from pgcrypto (preferred over uuid-ossp's v4).
--  * PostGIS is installed empty here; geo columns land per phase.
--  * `audit_logs` is intentionally NOT partitioned yet — low write volume.
--    `ride_events` / `ride_locations` will be partitioned in Phase 3.

-- =============================================================================
-- Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================================================
-- Enums
-- =============================================================================
DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('rider', 'driver', 'admin', 'ops', 'support');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- =============================================================================
-- users
-- =============================================================================
CREATE TABLE "users" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "phone"      TEXT UNIQUE,
  "email"      TEXT UNIQUE,
  "full_name"  TEXT,
  "locale"     TEXT NOT NULL DEFAULT 'en-CA',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX "users_deleted_at_idx" ON "users" ("deleted_at");

-- =============================================================================
-- user_roles
-- =============================================================================
CREATE TABLE "user_roles" (
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"       "UserRole" NOT NULL,
  "granted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "role")
);

-- =============================================================================
-- audit_logs
-- =============================================================================
CREATE TABLE "audit_logs" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id"    UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_role"  TEXT,
  "action"      TEXT NOT NULL,
  "resource"    TEXT NOT NULL,
  "resource_id" UUID,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" ("resource", "resource_id");
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" ("actor_id", "created_at");

-- =============================================================================
-- idempotency_keys
-- =============================================================================
CREATE TABLE "idempotency_keys" (
  "key"           TEXT PRIMARY KEY,
  "scope"         TEXT NOT NULL,
  "user_id"       UUID,
  "response_body" JSONB,
  "status_code"   INT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"    TIMESTAMPTZ NOT NULL
);
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- =============================================================================
-- Row Level Security — Phase 0 baseline.
--
-- Strategy: enable RLS on every user-facing table; admins read/write via the
-- service role (which bypasses RLS) on the server side. Clients use the
-- anon key + a JWT whose `sub` matches users.id.
-- =============================================================================
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;

-- Self-read / self-update on users.
-- The auth.uid() function is provided by Supabase Auth; in local docker dev
-- we use a SECURITY DEFINER shim so these policies don't error.
CREATE OR REPLACE FUNCTION auth_uid() RETURNS UUID
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE POLICY "users_self_select" ON "users"
  FOR SELECT USING (id = auth_uid());

CREATE POLICY "users_self_update" ON "users"
  FOR UPDATE USING (id = auth_uid());

CREATE POLICY "user_roles_self_select" ON "user_roles"
  FOR SELECT USING (user_id = auth_uid());

-- audit_logs and idempotency_keys are server-side only (service role).
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
-- No policies = no access for non-service-role clients (default deny).

-- =============================================================================
-- updated_at trigger helper
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER "users_set_updated_at"
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
