-- Fix: auth_uid() must never raise, whatever is in the JWT settings.
--
-- Migration 00000000000006 delegates to Supabase's own `auth.uid()` first and
-- catches only `undefined_function` / `invalid_schema_name` — the cases where
-- there is no auth schema at all (local Postgres). That is too narrow.
--
-- Supabase's `auth.uid()` itself parses `request.jwt.claims` as JSON, so a
-- setting that is not valid JSON raises `invalid_text_representation` from
-- INSIDE the delegated call, which sailed straight past the handler:
--
--   select set_config('request.jwt.claims','not-json',true); select auth_uid();
--   ERROR:  invalid input syntax for type json
--   CONTEXT: SQL statement "SELECT auth.uid()" / PL/pgSQL function auth_uid()
--
-- auth_uid() is called from RLS policies and from every driver_* guard trigger,
-- so an exception there does not surface as a clear auth error — it surfaces as
-- an ordinary INSERT or SELECT failing with a JSON parse error, on a request
-- whose only sin was carrying a malformed claim header.
--
-- The fallback is widened to WHEN OTHERS. Any failure of Supabase's helper now
-- means "ask the next source", which is the correct reading: this function
-- answers "which end user is behind this request", and being unable to tell is
-- the same as there being none. The service path is unaffected — it sets no JWT
-- settings and continues to resolve NULL.

CREATE OR REPLACE FUNCTION auth_uid() RETURNS UUID
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  raw_claims TEXT;
  raw_sub    TEXT;
  resolved   UUID;
BEGIN
  -- 1. Supabase's own helper, when this database has one. Agreeing with it
  --    keeps our policies and Supabase's from disagreeing about the caller.
  BEGIN
    EXECUTE 'SELECT auth.uid()' INTO resolved;
    IF resolved IS NOT NULL THEN
      RETURN resolved;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- No auth schema (local Postgres), or the helper choked on a malformed
    -- claim. Either way: fall through, never propagate.
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
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- 3. Legacy PostgREST format, still what the local dev shim sets.
  raw_sub := current_setting('request.jwt.claim.sub', true);
  IF raw_sub IS NOT NULL AND raw_sub <> '' THEN
    BEGIN
      RETURN raw_sub::uuid;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION auth_uid() IS
  'Resolves the end user behind the current request across Supabase and local '
  'Postgres, and never raises: an unreadable claim resolves to NULL. Returns '
  'NULL for the trusted service path (the API connects as the table owner with '
  'no JWT settings), which every driver_* guard trigger and RLS policy depends '
  'on — see migration 00000000000004_driver_rls_hardening.';
