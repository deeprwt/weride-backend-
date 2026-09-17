-- Make auth_uid() work on Supabase as well as local Postgres.
--
-- The Phase 0 shim read exactly one setting:
--
--   SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
--
-- That is the LEGACY PostgREST claim format. Supabase sets
-- `request.jwt.claims` — a single JSON document — and exposes `auth.uid()` on
-- top of it. On Supabase the old shim therefore returns NULL for every request,
-- including genuine end-user ones.
--
-- That is not a cosmetic difference. Migration 00000000000004 hangs the driver
-- self-approval guards off exactly this signal:
--
--   IF auth_uid() IS NULL THEN RETURN NEW;  -- trusted service, allow
--
-- so a shim that always returns NULL turns every one of those triggers into a
-- no-op, and a driver reaching the database through PostgREST could once again
-- set their own kyc_status to 'approved'. The guard would still be listed in
-- pg_trigger, still look present in review, and protect nothing.
--
-- The replacement resolves the caller in three steps, most authoritative first,
-- and is deliberately tolerant: a malformed or absent claim means "no end user",
-- which is the same answer the service path already relies on.

CREATE OR REPLACE FUNCTION auth_uid() RETURNS UUID
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  raw_claims TEXT;
  raw_sub    TEXT;
  resolved   UUID;
BEGIN
  -- 1. Supabase's own helper, when this database has one. It is the definition
  --    Supabase's own RLS policies use, so agreeing with it keeps our policies
  --    and theirs from disagreeing about who the caller is.
  BEGIN
    EXECUTE 'SELECT auth.uid()' INTO resolved;
    IF resolved IS NOT NULL THEN
      RETURN resolved;
    END IF;
  EXCEPTION WHEN undefined_function OR invalid_schema_name THEN
    -- Local Postgres has no auth schema. Fall through.
    NULL;
  END;

  -- 2. Supabase / modern PostgREST: the whole claim set as one JSON document.
  raw_claims := current_setting('request.jwt.claims', true);
  IF raw_claims IS NOT NULL AND raw_claims <> '' THEN
    BEGIN
      raw_sub := (raw_claims::jsonb) ->> 'sub';
      IF raw_sub IS NOT NULL AND raw_sub <> '' THEN
        RETURN raw_sub::uuid;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN
      -- A non-JSON setting, or a `sub` that is not a UUID (an anon key, say).
      -- Treated as "no end user" rather than raising: this function runs inside
      -- RLS policies and triggers, where an exception would surface as an
      -- unexplained failure on an ordinary query.
      NULL;
    END;
  END IF;

  -- 3. Legacy PostgREST format, still what the local dev shim sets.
  raw_sub := current_setting('request.jwt.claim.sub', true);
  IF raw_sub IS NOT NULL AND raw_sub <> '' THEN
    BEGIN
      RETURN raw_sub::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION auth_uid() IS
  'Resolves the end user behind the current request across Supabase and local '
  'Postgres. Returns NULL for the trusted service path (the API connects as the '
  'table owner with no JWT settings), which every driver_* guard trigger and RLS '
  'policy depends on — see migration 00000000000004_driver_rls_hardening.';
