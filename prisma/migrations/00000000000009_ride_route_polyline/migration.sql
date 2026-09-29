-- Ride route geometry.
--
-- The live trip map could only join the pickup and dropoff pins, because the
-- road route existed nowhere after the quote that produced it. On screen that
-- draws a straight line across rivers, railways and one-way systems — it looks
-- broken next to any competitor, and it quietly advertises that the distance
-- the fare was based on is not a road distance.
--
-- The quote already receives an encoded polyline from the Routes API. Storing
-- it on the ride means the trip screen can draw the route the driver will
-- actually take, without re-billing a routing call every time the screen opens
-- or a socket frame lands.
--
-- Nullable by design: a ride quoted while the maps provider was unreachable —
-- or with MAPS_PROVIDER=none — genuinely has no geometry, and the client
-- correctly falls back to the straight line for that one trip. Backfilling old
-- rides is deliberately not attempted: it would cost one billed route per
-- historical ride to redraw maps nobody is looking at.

-- =============================================================================
-- rides — encoded road route
-- =============================================================================
ALTER TABLE "rides"
  ADD COLUMN IF NOT EXISTS "route_polyline" TEXT;

COMMENT ON COLUMN "rides"."route_polyline" IS
  'Google-encoded polyline of the road route this ride was quoted on. NULL when no routing provider answered.';
