import type {
  DriverId,
  ISODateTime,
  RideId,
  UUID,
  UserId,
  VehicleId,
} from './primitives';
import type { LatLng } from './geo';
import type { RideClass, RideStatus } from './ride';

/**
 * Dispatch contract (Phase 3).
 *
 * Covers the three things that turn a `requested` row into a completed trip:
 * the offer loop that finds a driver, the event log that records every
 * transition, and the realtime channel both apps listen on.
 *
 * Shared verbatim by the backend, both mobile apps and the dashboard. Wire
 * shapes only — timestamps are ISO strings.
 */

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/**
 * One offer's outcome.
 *
 * `expired` and `declined` are kept distinct even though both free the driver:
 * a driver who silently lets offers time out is a very different acceptance-rate
 * signal from one who actively declines, and dispatch ranking needs to tell
 * them apart.
 */
export type RideOfferStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'expired'
  /** Withdrawn before the driver answered — rider cancelled, or another driver won. */
  | 'revoked';

export type RideOfferDeclineReason =
  | 'too_far'
  | 'wrong_direction'
  | 'taking_a_break'
  | 'vehicle_issue'
  | 'other';

export interface RideOffer {
  id: UUID;
  rideId: RideId;
  driverId: DriverId;
  /**
   * Which dispatch wave produced this offer. The matcher widens its radius each
   * round, so the round number is what lets you reconstruct why a far-away
   * driver was offered a ride at all.
   */
  round: number;
  status: RideOfferStatus;
  /** Road-free straight-line metres from driver to pickup at offer time. */
  distanceMeters: number;
  /** Estimated seconds for this driver to reach the pickup. */
  etaSeconds: number;
  offeredAt: ISODateTime;
  expiresAt: ISODateTime;
  respondedAt: ISODateTime | null;
  declineReason: RideOfferDeclineReason | null;
}

/** What the driver app renders when an offer arrives. */
export interface RideOfferForDriver {
  offer: RideOffer;
  pickup: LatLng;
  pickupAddress: string;
  dropoff: LatLng;
  dropoffAddress: string;
  rideClass: RideClass;
  /** What the driver earns, already net of commission. */
  driverEarningsCents: number;
  tripDistanceMeters: number;
  tripDurationSeconds: number;
  /** Seconds left to answer, computed server-side so a slow device cannot cheat. */
  secondsRemaining: number;
}

// ---------------------------------------------------------------------------
// Ride events — the audit log the ride status is derived from
// ---------------------------------------------------------------------------

export type RideEventActor = 'rider' | 'driver' | 'system' | 'admin';

/**
 * Every transition is appended here. `rides.status` is a denormalised cache of
 * the latest event for fast lookup; this table is the truth, and Phase 6 has a
 * property test asserting `replay(events) === rides.status` for every row.
 */
export interface RideEvent {
  id: UUID;
  rideId: RideId;
  /** Dotted name, e.g. `ride.requested`, `offer.accepted`, `ride.completed`. */
  type: string;
  fromStatus: RideStatus | null;
  toStatus: RideStatus | null;
  actorType: RideEventActor;
  actorId: UserId | null;
  metadata: Record<string, unknown> | null;
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Who the rider is riding with
// ---------------------------------------------------------------------------

/**
 * Driver details shown to the rider once matched.
 *
 * Deliberately narrow. The rider gets what they need to identify the car and
 * the person — never the driver's real phone number or exact home area. Contact
 * goes through a masked channel in a later phase.
 */
export interface RideDriverInfo {
  driverId: DriverId;
  firstName: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  vehicleId: VehicleId | null;
  vehicleDescription: string | null;
  vehiclePlate: string | null;
  vehicleColor: string | null;
}

// ---------------------------------------------------------------------------
// Realtime channel (socket.io namespace `/rt`)
// ---------------------------------------------------------------------------

/** Events the CLIENT emits. */
export const RT_CLIENT_EVENTS = {
  /** Rider or driver joins a ride room to receive its updates. */
  subscribeRide: 'ride:subscribe',
  unsubscribeRide: 'ride:unsubscribe',
  /** Driver streams position. Ignored from any socket without the driver role. */
  driverLocation: 'driver:location',
} as const;

/** Events the SERVER emits. */
export const RT_SERVER_EVENTS = {
  /** Full ride state after any transition. */
  rideStatus: 'ride:status',
  /** Driver's live position — only to the rider on that ride, only while active. */
  driverLocation: 'ride:driver_location',
  /** A new offer for this driver. */
  offerNew: 'offer:new',
  /** An offer is no longer answerable. */
  offerRevoked: 'offer:revoked',
  /** Something went wrong with a client message. */
  error: 'rt:error',
} as const;

export type RtClientEvent = (typeof RT_CLIENT_EVENTS)[keyof typeof RT_CLIENT_EVENTS];
export type RtServerEvent = (typeof RT_SERVER_EVENTS)[keyof typeof RT_SERVER_EVENTS];

export interface RtDriverLocationPayload {
  rideId: RideId;
  driverId: DriverId;
  location: LatLng;
  headingDegrees: number | null;
  /**
   * What the driver is currently heading for. `pickup` until the trip starts,
   * `dropoff` once it is in progress. Null outside an active trip.
   */
  target: 'pickup' | 'dropoff' | null;
  /** Metres from the driver's live position to `target`. */
  distanceMeters: number | null;
  /** Seconds to `target`, recomputed from the live position on every broadcast. */
  etaSeconds: number | null;
  recordedAt: ISODateTime;
}

export interface RtOfferRevokedPayload {
  offerId: UUID;
  rideId: RideId;
  reason: 'expired' | 'taken_by_another_driver' | 'rider_cancelled';
}

export interface RtErrorPayload {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * The only legal transitions. Anything absent here is rejected by
 * RidesService, so an out-of-order client can never corrupt a trip.
 *
 * Exported rather than kept private because both mobile apps use it to decide
 * which action buttons to render — the driver app should not offer "Start trip"
 * before the driver has arrived, and deriving that from one table keeps the
 * apps and the server from disagreeing about what is possible.
 */
export const RIDE_TRANSITIONS: Readonly<Record<RideStatus, readonly RideStatus[]>> = {
  requested: ['searching', 'no_drivers_found', 'cancelled_by_rider'],
  searching: ['accepted', 'no_drivers_found', 'cancelled_by_rider'],
  accepted: ['driver_arriving', 'cancelled_by_rider', 'cancelled_by_driver'],
  driver_arriving: ['arrived', 'cancelled_by_rider', 'cancelled_by_driver'],
  arrived: ['in_progress', 'cancelled_by_rider', 'cancelled_by_driver'],
  // Once the wheels turn, the only ways out are finishing or an admin/support
  // intervention — there is deliberately no rider-cancel edge here.
  in_progress: ['completed'],
  completed: ['payment_pending', 'rated_pending', 'closed'],
  payment_pending: ['payment_failed', 'rated_pending', 'closed'],
  payment_failed: ['payment_pending', 'closed'],
  rated_pending: ['closed'],
  closed: [],
  cancelled_by_rider: [],
  cancelled_by_driver: [],
  no_drivers_found: [],
} as const;

export const canTransition = (from: RideStatus, to: RideStatus): boolean =>
  RIDE_TRANSITIONS[from].includes(to);

/** Statuses where a driver is assigned and the rider should see them moving. */
export const ACTIVE_TRIP_STATUSES: readonly RideStatus[] = [
  'accepted',
  'driver_arriving',
  'arrived',
  'in_progress',
] as const;

export const isActiveTripStatus = (s: RideStatus): boolean =>
  ACTIVE_TRIP_STATUSES.includes(s);
