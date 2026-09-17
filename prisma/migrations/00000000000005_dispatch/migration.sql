-- Phase 3: dispatch — the offer loop, the ride event log, and the trip lifecycle.
--
-- Before this migration a ride could only ever be `requested`: nothing assigned
-- a driver and nothing recorded a transition. This adds the two tables that
-- make a trip possible and the columns that record when each stage happened.

-- =============================================================================
-- rides — lifecycle timestamps and the pickup code
-- =============================================================================
ALTER TABLE "rides"
  ADD COLUMN "searching_at"     TIMESTAMPTZ,
  ADD COLUMN "accepted_at"      TIMESTAMPTZ,
  ADD COLUMN "arrived_at"       TIMESTAMPTZ,
  ADD COLUMN "started_at"       TIMESTAMPTZ,
  ADD COLUMN "cancelled_at"     TIMESTAMPTZ,
  ADD COLUMN "cancelled_by"     TEXT,
  -- 4-digit code the rider reads out to the driver before the trip starts.
  -- Generated at request time, never shown to the driver, and checked
  -- server-side. Without it a driver can start and complete a trip the rider
  -- was never in, which is the standard fake-ride payout fraud.
  ADD COLUMN "pickup_otp"       TEXT,
  -- Actual travelled distance reported by the driver app, kept beside the
  -- quoted estimate rather than overwriting it: fare disputes need both.
  ADD COLUMN "actual_distance_meters" INTEGER,
  ADD COLUMN "vehicle_id"       UUID REFERENCES "vehicles"("id") ON DELETE SET NULL,
  ADD COLUMN "dispatch_round"   INTEGER NOT NULL DEFAULT 0,

  ADD CONSTRAINT "rides_cancelled_by_check" CHECK (
    "cancelled_by" IS NULL OR "cancelled_by" IN ('rider', 'driver', 'system', 'admin')
  );

-- The dispatcher's hot query: find rides still looking for a driver, oldest
-- first. Partial, because this is a handful of rows out of the whole table.
CREATE INDEX "rides_awaiting_dispatch_idx"
  ON "rides" ("requested_at")
  WHERE "status" IN ('requested', 'searching');

-- Driver's active trip lookup — one row at most, but hit on every ping.
CREATE INDEX "rides_driver_active_idx"
  ON "rides" ("driver_id")
  WHERE "status" IN ('accepted', 'driver_arriving', 'arrived', 'in_progress');

-- =============================================================================
-- ride_offers — one row per driver per dispatch wave.
--
-- Kept as rows rather than transient Redis entries because acceptance rate and
-- decline reasons are the inputs to driver ranking and to any conversation
-- about deactivating a driver. That needs a durable record, not a TTL key.
-- =============================================================================
CREATE TABLE "ride_offers" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ride_id"         UUID        NOT NULL REFERENCES "rides"("id") ON DELETE CASCADE,
  "driver_id"       UUID        NOT NULL REFERENCES "driver_profiles"("user_id") ON DELETE CASCADE,
  "round"           INTEGER     NOT NULL DEFAULT 1,
  "status"          TEXT        NOT NULL DEFAULT 'pending',
  "distance_meters" INTEGER     NOT NULL,
  "eta_seconds"     INTEGER     NOT NULL,
  "offered_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"      TIMESTAMPTZ NOT NULL,
  "responded_at"    TIMESTAMPTZ,
  "decline_reason"  TEXT,

  CONSTRAINT "ride_offers_status_check" CHECK (
    "status" IN ('pending', 'accepted', 'declined', 'expired', 'revoked')
  ),
  CONSTRAINT "ride_offers_decline_reason_check" CHECK (
    "decline_reason" IS NULL OR "decline_reason" IN (
      'too_far', 'wrong_direction', 'taking_a_break', 'vehicle_issue', 'other'
    )
  ),
  -- A driver is offered a given ride at most once per wave. Stops a retrying
  -- dispatcher from spamming the same driver with duplicates of one ride.
  CONSTRAINT "ride_offers_unique_per_round" UNIQUE ("ride_id", "driver_id", "round")
);

-- THE integrity constraint of the whole dispatch system: at most one accepted
-- offer per ride, enforced by the database. Two drivers tapping accept in the
-- same millisecond is the defining race here, and application-level locking is
-- not something to stake a double-assignment on.
CREATE UNIQUE INDEX "ride_offers_one_accepted_per_ride"
  ON "ride_offers" ("ride_id") WHERE "status" = 'accepted';

-- A driver may hold only one pending offer at a time — otherwise two riders
-- can be promised the same car.
CREATE UNIQUE INDEX "ride_offers_one_pending_per_driver"
  ON "ride_offers" ("driver_id") WHERE "status" = 'pending';

-- Sweeper query: pending offers past their deadline.
CREATE INDEX "ride_offers_expiry_idx"
  ON "ride_offers" ("expires_at") WHERE "status" = 'pending';

CREATE INDEX "ride_offers_driver_idx" ON "ride_offers" ("driver_id", "offered_at");

-- =============================================================================
-- ride_events — append-only transition log.
--
-- `rides.status` is a denormalised cache of the newest event here; this table
-- is the truth. Partitioned monthly from day one per DATA_MODEL.md: it grows
-- with every transition of every ride, and converting a large heap table to
-- partitioned later is a multi-hour rewrite.
--
-- Not modelled in schema.prisma — Prisma cannot express a partitioned parent.
-- RidesService writes it with $executeRaw inside the same transaction as the
-- status change, so a transition and its audit row commit together or not at all.
-- =============================================================================
CREATE TABLE "ride_events" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "ride_id"     UUID        NOT NULL,
  "type"        TEXT        NOT NULL,
  "from_status" TEXT,
  "to_status"   TEXT,
  "actor_type"  TEXT        NOT NULL DEFAULT 'system',
  "actor_id"    UUID,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY ("id", "created_at"),
  CONSTRAINT "ride_events_actor_type_check" CHECK (
    "actor_type" IN ('rider', 'driver', 'system', 'admin')
  )
) PARTITION BY RANGE ("created_at");

-- Replaying one ride's history in order is the access pattern that matters.
CREATE INDEX "ride_events_ride_time_idx" ON "ride_events" ("ride_id", "created_at");
CREATE INDEX "ride_events_type_time_idx" ON "ride_events" ("type", "created_at");

-- Seed partitions: current month plus the next three, matching driver_locations.
CREATE TABLE "ride_events_2026_09" PARTITION OF "ride_events"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE "ride_events_2026_10" PARTITION OF "ride_events"
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE "ride_events_2026_11" PARTITION OF "ride_events"
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE "ride_events_2026_12" PARTITION OF "ride_events"
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- =============================================================================
-- Row Level Security
-- =============================================================================
ALTER TABLE "ride_offers" ENABLE ROW LEVEL SECURITY;

-- A driver sees only their own offers, and may never author one: offers are
-- created by the dispatcher. Accept/decline goes through the API, which runs as
-- the table owner, so no self-update policy is granted here either.
CREATE POLICY "ride_offers_driver_select" ON "ride_offers"
  FOR SELECT USING (driver_id = auth_uid());
