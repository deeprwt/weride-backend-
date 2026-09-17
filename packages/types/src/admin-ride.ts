import type { Cents, Currency, DriverId, ISODateTime, RideId, UserId } from './primitives';
import type { LatLng } from './geo';
import type { RideClass, RideStatus } from './ride';
import type { RideEvent, RideEventActor, RideOffer } from './dispatch';

/**
 * Ops-facing dispatch views (Phase 3).
 *
 * The live-rides board is how an operator finds out that dispatch is working at
 * all: which rides are still hunting for a driver, which are under way, and —
 * when one goes wrong — every offer that was made and every transition that
 * followed. Shared by the API and the dashboard so the two cannot drift.
 *
 * Wire shapes only: timestamps are ISO strings, money is integer cents.
 */

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The tabs on the board, and the statuses behind each one.
 *
 * Declared here rather than in the dashboard because both ends need the same
 * answer: `GET /v1/admin/rides?status=live` resolves the group server-side, and
 * the tab linking to it shows a count summed from the same map. Two copies of
 * this is how a tab ends up promising eleven rides and showing nine.
 *
 * `searching` deliberately includes `requested`: a rider watching a spinner
 * does not care whether the dispatcher has picked their ride up yet, and a pile
 * of rides stuck in `requested` is the loudest symptom of a dead worker.
 */
export const ADMIN_RIDE_FILTERS = {
  /** A driver is assigned and the trip is happening. */
  live: ['accepted', 'driver_arriving', 'arrived', 'in_progress'],
  /** Nobody assigned yet — the dispatch loop owns these. */
  searching: ['requested', 'searching'],
  /** Dispatch gave up. Every one of these is a rider left standing. */
  unmatched: ['no_drivers_found'],
  finished: ['completed', 'payment_pending', 'payment_failed', 'rated_pending', 'closed'],
  cancelled: ['cancelled_by_rider', 'cancelled_by_driver'],
} as const satisfies Record<string, readonly RideStatus[]>;

export type AdminRideFilter = keyof typeof ADMIN_RIDE_FILTERS;

export const ADMIN_RIDE_FILTER_NAMES = Object.keys(ADMIN_RIDE_FILTERS) as AdminRideFilter[];

export const isAdminRideFilter = (value: string): value is AdminRideFilter =>
  Object.prototype.hasOwnProperty.call(ADMIN_RIDE_FILTERS, value);

/**
 * Rides that are still happening right now.
 *
 * The board sorts and highlights on this: an in-flight ride is one somebody is
 * currently waiting on, and it has to be distinguishable from an hour-old
 * completed trip at a glance, from across a room.
 */
export const ADMIN_RIDE_IN_FLIGHT: readonly RideStatus[] = [
  ...ADMIN_RIDE_FILTERS.searching,
  ...ADMIN_RIDE_FILTERS.live,
];

export const isInFlightRideStatus = (status: RideStatus): boolean =>
  ADMIN_RIDE_IN_FLIGHT.includes(status);

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/**
 * Who is on the ride, as the board renders them.
 *
 * Names only. Contact details live on the detail view instead: the board is a
 * screen that sits open on a wall for a whole shift, and there is no reason for
 * every rider's phone number in the city to be on it.
 */
export interface AdminRideRider {
  id: UserId;
  fullName: string | null;
}

export interface AdminRideDriver {
  id: DriverId;
  fullName: string | null;
}

/** On the detail view, where an operator may actually have to phone someone. */
export interface AdminRideRiderContact extends AdminRideRider {
  phone: string | null;
  email: string | null;
}

export interface AdminRideDriverContact extends AdminRideDriver {
  phone: string | null;
  email: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  vehicleDescription: string | null;
  vehiclePlate: string | null;
  vehicleColor: string | null;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export interface AdminRideListItem {
  id: RideId;
  status: RideStatus;
  rideClass: RideClass;
  rider: AdminRideRider;
  driver: AdminRideDriver | null;
  pickupAddress: string;
  dropoffAddress: string;
  distanceMeters: number;
  durationSeconds: number;
  fareCents: Cents | null;
  currency: Currency;
  /** Dispatch waves this ride has been through. 0 means never dispatched. */
  dispatchRound: number;
  offerCount: number;
  /** Offers still ticking. An unassigned ride with none is a stuck ride. */
  pendingOfferCount: number;
  requestedAt: ISODateTime;
  acceptedAt: ISODateTime | null;
  startedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  /**
   * Seconds since the request, computed by the database.
   *
   * Not derived in the browser from `requestedAt`: an operator's laptop clock
   * can be minutes out, and "this rider has been waiting six minutes" is the
   * number they escalate on.
   */
  ageSeconds: number;
}

/** Per-status totals behind the tab badges. */
export type AdminRideCounts = Record<RideStatus, number>;

export interface AdminRideListPage {
  items: AdminRideListItem[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Counted under the rider/driver filters but NOT the status filter — a tab
   * badge has to keep saying how many rides are in the tab you are not on.
   */
  counts: AdminRideCounts;
}

// ---------------------------------------------------------------------------
// One ride, in full
// ---------------------------------------------------------------------------

/** An offer with the driver it went to, for the detail view's offer table. */
export interface AdminRideOffer extends RideOffer {
  driver: AdminRideDriver;
}

/**
 * A driver ops can hand the ride to: approved, online, and near the pickup.
 *
 * Supplied by the API rather than typed in by the operator, because a
 * reassignment is only as good as the driver it names — and an id pasted out of
 * a support ticket is how a ride gets handed to somebody who went offline
 * twenty minutes ago.
 */
export interface AdminRideCandidate {
  driver: AdminRideDriver;
  /** Straight-line metres from the pickup, per PostGIS. */
  distanceMeters: number;
  ratingAvg: number | null;
  lastPingAt: ISODateTime;
}

export interface AdminRideDetail {
  ride: AdminRideListItem;
  pickup: LatLng;
  dropoff: LatLng;
  rider: AdminRideRiderContact;
  driver: AdminRideDriverContact | null;
  cancelledBy: RideEventActor | null;
  cancelReason: string | null;
  actualDistanceMeters: number | null;
  /**
   * The status folded out of `ride_events`, which is the truth `rides.status`
   * caches. Equal to `ride.status` on every healthy ride; when it is not, the
   * console says so loudly, because a divergence means something moved the ride
   * without going through the state machine.
   */
  replayedStatus: RideStatus | null;
  /** Oldest first. The trail a dispatch bug is reconstructed from. */
  events: RideEvent[];
  /** Every offer ever made for this ride, oldest first, outcome included. */
  offers: AdminRideOffer[];
  /** Empty once the ride can no longer be reassigned. */
  candidates: AdminRideCandidate[];
  /** Mirrors the API's own gates, so the console hides controls it would refuse. */
  canReassign: boolean;
  canCancel: boolean;
}
