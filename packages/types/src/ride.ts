import type { Cents, Currency, DriverId, ISODateTime, RideId, UserId } from './primitives';
import type { LatLng } from './geo';

/** Canonical ride lifecycle. Persisted as TEXT in Postgres; validated by zod. */
export type RideStatus =
  | 'requested'
  | 'searching'
  | 'accepted'
  | 'driver_arriving'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'payment_pending'
  | 'payment_failed'
  | 'rated_pending'
  | 'closed'
  | 'cancelled_by_rider'
  | 'cancelled_by_driver'
  | 'no_drivers_found';

/** Terminal states — no further transitions allowed. */
export const TERMINAL_RIDE_STATUSES: readonly RideStatus[] = [
  'closed',
  'cancelled_by_rider',
  'cancelled_by_driver',
  'no_drivers_found',
] as const;

/**
 * States from which a RIDER may still cancel.
 *
 * Deliberately NOT the inverse of TERMINAL_RIDE_STATUSES. "Not terminal" is a
 * much wider set: it includes `in_progress`, `completed`, `payment_pending` and
 * `rated_pending`. Gating cancellation on non-terminality therefore lets a
 * rider cancel a trip they have already taken, which destroys the fare and
 * corrupts the ride history. Cancellation stops being a rider action the moment
 * the trip starts; after that it is a support/refund action.
 */
export const CANCELLABLE_RIDE_STATUSES: readonly RideStatus[] = [
  'requested',
  'searching',
  'accepted',
  'driver_arriving',
  'arrived',
] as const;

export const isTerminalRideStatus = (s: RideStatus): boolean =>
  TERMINAL_RIDE_STATUSES.includes(s);

export const isCancellableRideStatus = (s: RideStatus): boolean =>
  CANCELLABLE_RIDE_STATUSES.includes(s);

/** Service classes a rider can request. */
export type RideClass = 'standard' | 'xl' | 'premium';

export interface RideSummary {
  id: RideId;
  riderId: UserId;
  driverId: DriverId | null;
  status: RideStatus;
  rideClass: RideClass;
  pickup: LatLng;
  dropoff: LatLng;
  pickupAddress: string;
  dropoffAddress: string;
  distanceMeters: number;
  durationSeconds: number;
  fareCents: Cents | null;
  currency: Currency;
  requestedAt: ISODateTime;
  completedAt: ISODateTime | null;
}

/** Itemised fare, mirrored from the pricing service `/v1/quote` response. */
export interface FareBreakdown {
  baseFareCents: Cents;
  distanceCents: Cents;
  timeCents: Cents;
  bookingFeeCents: Cents;
  classMultiplier: number;
  surgeMultiplier: number;
}

/** A fare estimate for a pickup -> dropoff trip. */
export interface FareQuote {
  currency: Currency;
  rideClass: RideClass;
  distanceMeters: number;
  durationSeconds: number;
  fareCents: Cents;
  surgeMultiplier: number;
  breakdown: FareBreakdown;
}
