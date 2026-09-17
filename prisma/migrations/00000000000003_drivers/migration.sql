-- Phase 2: drivers — onboarding, KYC, vehicles, availability, live location.
--
-- Conventions carried over from earlier migrations:
--  * `gen_random_uuid()` from pgcrypto.
--  * Small, closed status sets are TEXT + CHECK. This differs deliberately from
--    `rides.status`, which is bare TEXT because the ride state machine gains
--    states every phase. KYC / document / vehicle statuses are stable business
--    states, so the DB should reject a typo rather than persist it.
--  * RLS mirrors the service-layer ownership checks (defense in depth).
--
-- This is the first migration to put PostGIS to work: `driver_availability`
-- carries a geography(Point) with a GiST index, which is what makes the
-- nearby-driver search in GeoService an index scan instead of a seq scan over
-- every online driver.

-- =============================================================================
-- driver_profiles — one row per user who has applied to drive.
-- =============================================================================
CREATE TABLE "driver_profiles" (
  "user_id"            UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "kyc_status"         TEXT        NOT NULL DEFAULT 'not_started',
  "licence_number"     TEXT,
  "licence_province"   TEXT,
  "licence_expires_at" TIMESTAMPTZ,
  -- Denormalised rating aggregates. Recomputed on each new rating rather than
  -- averaged over the ratings table on every read; driver lists are hot.
  "rating_sum"         INTEGER     NOT NULL DEFAULT 0,
  "rating_count"       INTEGER     NOT NULL DEFAULT 0,
  "total_rides"        INTEGER     NOT NULL DEFAULT 0,
  "applied_at"         TIMESTAMPTZ,
  "submitted_at"       TIMESTAMPTZ,
  "approved_at"        TIMESTAMPTZ,
  "approved_by"        UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "rejection_reason"   TEXT,
  "suspended_at"       TIMESTAMPTZ,
  "suspension_reason"  TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "driver_profiles_kyc_status_check" CHECK ("kyc_status" IN (
    'not_started', 'documents_pending', 'under_review', 'approved', 'rejected', 'suspended'
  )),
  CONSTRAINT "driver_profiles_licence_province_check" CHECK (
    "licence_province" IS NULL OR "licence_province" IN (
      'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'
    )
  ),
  CONSTRAINT "driver_profiles_rating_count_nonneg" CHECK ("rating_count" >= 0)
);

-- The KYC queue is always filtered by status and ordered by submission time.
CREATE INDEX "driver_profiles_kyc_status_idx" ON "driver_profiles" ("kyc_status", "submitted_at");

-- =============================================================================
-- vehicles
-- =============================================================================
CREATE TABLE "vehicles" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "driver_id"        UUID        NOT NULL REFERENCES "driver_profiles"("user_id") ON DELETE CASCADE,
  "make"             TEXT        NOT NULL,
  "model"            TEXT        NOT NULL,
  "year"             INTEGER     NOT NULL,
  "color"            TEXT        NOT NULL,
  -- Normalised upper-case, no spaces or dashes (see plateSchema).
  "plate"            TEXT        NOT NULL,
  "province"         TEXT        NOT NULL,
  "ride_class"       TEXT        NOT NULL DEFAULT 'standard',
  "seats"            INTEGER     NOT NULL DEFAULT 4,
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  "rejection_reason" TEXT,
  "is_active"        BOOLEAN     NOT NULL DEFAULT true,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "vehicles_status_check"     CHECK ("status" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "vehicles_ride_class_check" CHECK ("ride_class" IN ('standard', 'xl', 'premium')),
  CONSTRAINT "vehicles_province_check"   CHECK ("province" IN (
    'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'
  )),
  CONSTRAINT "vehicles_seats_check"      CHECK ("seats" BETWEEN 1 AND 8),
  CONSTRAINT "vehicles_year_check"       CHECK ("year" BETWEEN 1980 AND 2100)
);

-- A plate is unique per province. Two provinces may legitimately issue the
-- same characters, so the uniqueness is on the pair, not the plate alone.
CREATE UNIQUE INDEX "vehicles_plate_province_key" ON "vehicles" ("plate", "province");

-- At most one active vehicle per driver — enforced by the DB so a race between
-- two "register vehicle" requests cannot leave a driver with two active cars.
CREATE UNIQUE INDEX "vehicles_one_active_per_driver"
  ON "vehicles" ("driver_id") WHERE "is_active";

CREATE INDEX "vehicles_driver_idx" ON "vehicles" ("driver_id");

-- =============================================================================
-- driver_documents — KYC uploads awaiting human review.
-- =============================================================================
CREATE TABLE "driver_documents" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "driver_id"        UUID        NOT NULL REFERENCES "driver_profiles"("user_id") ON DELETE CASCADE,
  "type"             TEXT        NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  -- Opaque key into the document store. Local dev writes to disk under
  -- DOCUMENT_STORAGE_PATH; production swaps the driver for object storage
  -- without touching this column.
  "storage_key"      TEXT        NOT NULL,
  "file_name"        TEXT        NOT NULL,
  "mime_type"        TEXT        NOT NULL,
  "size_bytes"       INTEGER     NOT NULL,
  -- SHA-256 of the bytes. Lets ops spot the same forged document reused across
  -- several driver applications.
  "content_sha256"   TEXT,
  "expires_at"       TIMESTAMPTZ,
  "rejection_reason" TEXT,
  "reviewed_by"      UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at"      TIMESTAMPTZ,
  "uploaded_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "driver_documents_type_check" CHECK ("type" IN (
    'drivers_license_front', 'drivers_license_back', 'vehicle_registration',
    'insurance', 'profile_photo', 'background_check'
  )),
  CONSTRAINT "driver_documents_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "driver_documents_size_check"   CHECK ("size_bytes" > 0)
);

-- Re-uploading a document type replaces the previous one, so only the newest
-- row per (driver, type) is live. Superseded rows are deleted, which keeps this
-- unique index valid and the review queue free of stale duplicates.
CREATE UNIQUE INDEX "driver_documents_driver_type_key" ON "driver_documents" ("driver_id", "type");
CREATE INDEX "driver_documents_status_idx"   ON "driver_documents" ("status", "uploaded_at");
CREATE INDEX "driver_documents_sha_idx"      ON "driver_documents" ("content_sha256")
  WHERE "content_sha256" IS NOT NULL;

-- =============================================================================
-- driver_availability — the dispatcher's view of who can take a ride.
--
-- One row per driver, updated in place on every location ping. Kept separate
-- from driver_profiles because it is written thousands of times more often:
-- co-locating it would bloat the profile table and its indexes.
-- =============================================================================
CREATE TABLE "driver_availability" (
  "driver_id"       UUID PRIMARY KEY REFERENCES "driver_profiles"("user_id") ON DELETE CASCADE,
  "status"          TEXT        NOT NULL DEFAULT 'offline',
  "vehicle_id"      UUID REFERENCES "vehicles"("id") ON DELETE SET NULL,
  -- WGS84 point. geography (not geometry) so ST_DWithin/ST_Distance return
  -- true metres on the spheroid without us picking a local projection.
  "last_location"   geography(Point, 4326),
  "heading_degrees" REAL,
  "speed_mps"       REAL,
  "last_ping_at"    TIMESTAMPTZ,
  "current_ride_id" UUID,
  "went_online_at"  TIMESTAMPTZ,
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "driver_availability_status_check" CHECK ("status" IN ('offline', 'online', 'on_trip')),
  -- A driver on a trip must have a ride attached, and vice versa. Prevents the
  -- dispatcher from ever seeing a half-assigned driver.
  CONSTRAINT "driver_availability_trip_consistency" CHECK (
    ("status" = 'on_trip') = ("current_ride_id" IS NOT NULL)
  )
);

-- THE dispatch index: spatial lookup restricted to drivers who can take a ride.
-- Partial on status so the index holds only online drivers, which is a tiny
-- fraction of the table and stays in memory.
CREATE INDEX "driver_availability_location_gix"
  ON "driver_availability" USING GIST ("last_location")
  WHERE "status" = 'online';

CREATE INDEX "driver_availability_status_ping_idx"
  ON "driver_availability" ("status", "last_ping_at");

-- =============================================================================
-- driver_locations — append-only breadcrumb trail.
--
-- Declared partitioned by month from day one, per DATA_MODEL.md: this table
-- grows faster than any other in the system (one row per driver per few
-- seconds), and converting a large heap table to partitioned later is a
-- multi-hour rewrite. A rotation job creates future partitions and detaches
-- old ones (Phase 6).
--
-- Deliberately NOT modelled in schema.prisma: Prisma cannot express partitioned
-- parents or geography columns. GeoService reads and writes it via $queryRaw.
-- =============================================================================
CREATE TABLE "driver_locations" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "driver_id"       UUID        NOT NULL,
  -- Set while the point was recorded during a ride, so a trip can be replayed
  -- for support and fare disputes without scanning by timestamp.
  "ride_id"         UUID,
  "location"        geography(Point, 4326) NOT NULL,
  "heading_degrees" REAL,
  "speed_mps"       REAL,
  "accuracy_meters" REAL,
  "recorded_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY ("id", "recorded_at")
) PARTITION BY RANGE ("recorded_at");

CREATE INDEX "driver_locations_driver_time_idx" ON "driver_locations" ("driver_id", "recorded_at");
CREATE INDEX "driver_locations_ride_idx" ON "driver_locations" ("ride_id", "recorded_at")
  WHERE "ride_id" IS NOT NULL;

-- Seed partitions: current month plus the next three. The rotation job takes
-- over from here; if it ever fails, inserts start erroring loudly rather than
-- landing in a DEFAULT partition that silently becomes unmaintainable.
CREATE TABLE "driver_locations_2026_09" PARTITION OF "driver_locations"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE "driver_locations_2026_10" PARTITION OF "driver_locations"
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE "driver_locations_2026_11" PARTITION OF "driver_locations"
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE "driver_locations_2026_12" PARTITION OF "driver_locations"
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- =============================================================================
-- rides: attach the driver FK now that driver_profiles exists.
-- =============================================================================
ALTER TABLE "rides"
  ADD CONSTRAINT "rides_driver_id_fkey"
  FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("user_id") ON DELETE SET NULL;

-- =============================================================================
-- Row Level Security
--
-- The Nest service connects as the table owner and therefore bypasses RLS; these
-- policies protect the Supabase/PostgREST path and any future least-privilege
-- role. Ownership is ALSO enforced in DriversService — see the note there.
-- =============================================================================
ALTER TABLE "driver_profiles"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicles"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "driver_documents"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "driver_availability" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "driver_profiles_self_select" ON "driver_profiles"
  FOR SELECT USING (user_id = auth_uid());
CREATE POLICY "driver_profiles_self_update" ON "driver_profiles"
  FOR UPDATE USING (user_id = auth_uid());

CREATE POLICY "vehicles_self_all" ON "vehicles"
  USING (driver_id = auth_uid()) WITH CHECK (driver_id = auth_uid());

CREATE POLICY "driver_documents_self_all" ON "driver_documents"
  USING (driver_id = auth_uid()) WITH CHECK (driver_id = auth_uid());

CREATE POLICY "driver_availability_self_all" ON "driver_availability"
  USING (driver_id = auth_uid()) WITH CHECK (driver_id = auth_uid());
