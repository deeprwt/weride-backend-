-- Rider profile + saved places.
--
-- The rider app's profile screen asks for the details every ride-hailing app
-- keeps on a rider — gender, date of birth, an emergency contact — and its
-- search screen lets a rider heart a place to find it again. Until now
-- PATCH /v1/me could only store a name and a language, so none of that could
-- be saved anywhere.

-- =============================================================================
-- users — profile details
-- =============================================================================
ALTER TABLE "users"
  ADD COLUMN "gender"                  TEXT,
  ADD COLUMN "date_of_birth"           DATE,
  ADD COLUMN "emergency_contact_name"  TEXT,
  ADD COLUMN "emergency_contact_phone" TEXT,

  -- Self-described, and optional: the app never requires it.
  ADD CONSTRAINT "users_gender_check" CHECK (
    "gender" IS NULL OR "gender" IN ('male', 'female', 'non_binary', 'prefer_not_to_say')
  ),
  -- An emergency contact is only useful as a pair. A name with no number cannot
  -- be called from the SOS flow, and a bare number tells support nothing.
  ADD CONSTRAINT "users_emergency_contact_pair" CHECK (
    ("emergency_contact_name" IS NULL) = ("emergency_contact_phone" IS NULL)
  );

-- users_self_update (migration 0000) already lets a user edit their own row.
-- These columns are the user's own details, so that is the right access: no
-- guard trigger is needed, unlike the driver KYC columns in migration 0004.

-- =============================================================================
-- saved_places — places a rider hearted
-- =============================================================================
CREATE TABLE "saved_places" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind"       TEXT        NOT NULL DEFAULT 'other',
  -- What the rider calls it ("Home", "Mom's place"). The address is separate
  -- because a rider renames a place far more often than they move it.
  "name"       TEXT        NOT NULL,
  "address"    TEXT        NOT NULL,
  "lat"        DOUBLE PRECISION NOT NULL,
  "lng"        DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "saved_places_kind_check" CHECK ("kind" IN ('home', 'work', 'other')),
  CONSTRAINT "saved_places_lat_check"  CHECK ("lat" BETWEEN -90 AND 90),
  CONSTRAINT "saved_places_lng_check"  CHECK ("lng" BETWEEN -180 AND 180)
);

CREATE INDEX "saved_places_user_idx" ON "saved_places" ("user_id", "created_at");

-- One Home and one Work each. "Set as home" replaces the old one rather than
-- adding a second, which is what every rider expects the word to mean; the
-- index makes a double-tap race impossible rather than merely unlikely.
CREATE UNIQUE INDEX "saved_places_one_home_per_user"
  ON "saved_places" ("user_id") WHERE "kind" = 'home';
CREATE UNIQUE INDEX "saved_places_one_work_per_user"
  ON "saved_places" ("user_id") WHERE "kind" = 'work';

ALTER TABLE "saved_places" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "saved_places_self_all" ON "saved_places"
  USING (user_id = auth_uid()) WITH CHECK (user_id = auth_uid());
