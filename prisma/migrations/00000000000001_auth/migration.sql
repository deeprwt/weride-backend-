-- Phase 1: auth fields on users + auth_sessions + otp_attempts.

-- =============================================================================
-- users: extend with auth-related columns.
-- =============================================================================
ALTER TABLE "users"
  ADD COLUMN "auth_provider"         TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN "email_verified_at"     TIMESTAMPTZ,
  ADD COLUMN "phone_verified_at"     TIMESTAMPTZ,
  ADD COLUMN "password_hash"         TEXT,
  ADD COLUMN "totp_secret_encrypted" TEXT,
  ADD COLUMN "totp_enrolled_at"      TIMESTAMPTZ,
  ADD COLUMN "recovery_codes"        JSONB,
  ADD COLUMN "last_login_at"         TIMESTAMPTZ;

-- =============================================================================
-- auth_sessions — refresh token storage with rotation + reuse detection.
-- =============================================================================
CREATE TABLE "auth_sessions" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "family_id"          UUID NOT NULL,
  "refresh_token_hash" TEXT NOT NULL UNIQUE,
  "device_label"       TEXT,
  "ip"                 TEXT,
  "user_agent"         TEXT,
  "surface"            TEXT NOT NULL,                   -- 'mobile' | 'admin-web'
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"         TIMESTAMPTZ NOT NULL,
  "revoked_at"         TIMESTAMPTZ,
  "revoked_reason"     TEXT
);
CREATE INDEX "auth_sessions_user_expires_idx" ON "auth_sessions" ("user_id", "expires_at");
CREATE INDEX "auth_sessions_family_idx"       ON "auth_sessions" ("family_id");

-- RLS: users can read their own sessions; nobody else.
ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_sessions_self_select" ON "auth_sessions"
  FOR SELECT USING (user_id = auth_uid());

-- =============================================================================
-- otp_attempts — for analytics + brute-force defense. Service-role only.
-- Stores phone HASH, not raw phone. Purged after 30 days by job.
-- =============================================================================
CREATE TABLE "otp_attempts" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "phone_hash" TEXT NOT NULL,
  "ip"         TEXT,
  "succeeded"  BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "otp_attempts_phone_idx" ON "otp_attempts" ("phone_hash", "created_at");
CREATE INDEX "otp_attempts_ip_idx"    ON "otp_attempts" ("ip", "created_at");

ALTER TABLE "otp_attempts" ENABLE ROW LEVEL SECURITY;
-- No policies = default-deny for non-service-role.
