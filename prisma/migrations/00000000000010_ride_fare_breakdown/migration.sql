-- Itemised fare on the ride.
--
-- A receipt has to say what was charged and why: base fare, distance, time,
-- booking fee, and the multipliers that moved them. Those numbers exist only in
-- the quote that created the ride, and recomputing them later would produce a
-- DIFFERENT total, because surge and tariffs move. A receipt that changes when
-- you reopen it is worse than one that shows only a total.
--
-- Nullable and not backfilled: rides created before this column genuinely have
-- no stored itemisation, and inventing one after the fact would be fabricating
-- a financial record.

ALTER TABLE "rides"
  ADD COLUMN IF NOT EXISTS "fare_breakdown" JSONB;

COMMENT ON COLUMN "rides"."fare_breakdown" IS
  'FareBreakdown the ride was quoted at. NULL for rides created before this column.';
