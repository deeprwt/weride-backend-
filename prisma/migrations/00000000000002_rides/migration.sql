-- Phase 3: rides — the ride lifecycle / booking flow.
--
-- `status` is TEXT (the RideStatus union is validated in app code, not a DB
-- enum) so the state machine can evolve without a migration per state.
-- pickup/dropoff are plain lat/lng for now; a PostGIS geography column for
-- spatial driver-matching lands with the matching module.

CREATE TABLE "rides" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "rider_id"         UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "driver_id"        UUID,
  "status"           TEXT NOT NULL DEFAULT 'requested',
  "ride_class"       TEXT NOT NULL DEFAULT 'standard',
  "pickup_lat"       DOUBLE PRECISION NOT NULL,
  "pickup_lng"       DOUBLE PRECISION NOT NULL,
  "dropoff_lat"      DOUBLE PRECISION NOT NULL,
  "dropoff_lng"      DOUBLE PRECISION NOT NULL,
  "pickup_address"   TEXT NOT NULL,
  "dropoff_address"  TEXT NOT NULL,
  "distance_meters"  INTEGER NOT NULL,
  "duration_seconds" INTEGER NOT NULL,
  "fare_cents"       INTEGER,
  "currency"         TEXT NOT NULL DEFAULT 'CAD',
  "cancel_reason"    TEXT,
  "requested_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at"     TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "rides_rider_requested_idx" ON "rides" ("rider_id", "requested_at");
CREATE INDEX "rides_status_idx"          ON "rides" ("status");
CREATE INDEX "rides_driver_idx"          ON "rides" ("driver_id");

-- RLS: a rider can see and act on only their own rides. (Defense-in-depth for
-- the Supabase/PostgREST path; the Nest service also enforces ownership.)
ALTER TABLE "rides" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rides_self_select" ON "rides"
  FOR SELECT USING (rider_id = auth_uid());

CREATE POLICY "rides_self_insert" ON "rides"
  FOR INSERT WITH CHECK (rider_id = auth_uid());

CREATE POLICY "rides_self_update" ON "rides"
  FOR UPDATE USING (rider_id = auth_uid());
