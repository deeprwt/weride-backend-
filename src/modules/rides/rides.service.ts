import { randomInt } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Ride } from '@prisma/client';
import type { QuoteRequestInput, RideCancelInput, RideRequestInput } from '@uride/validation';
import {
  isCancellableRideStatus,
  type DriverId,
  type FareQuote,
  type ISODateTime,
  type RideClass,
  type RideDriverInfo,
  type RideEventActor,
  type RideStatus,
  type RideSummary,
  type VehicleId,
} from '@uride/types';
import { PrismaService } from '../../common/prisma/prisma.module';
import { PricingClient, type PricingInputs } from '../../common/pricing-client/pricing-client';
import { RouteEstimatorService } from '../pricing/route-estimator.service';
import { SurgeService } from '../pricing/surge.service';
import { RealtimeService } from '../../realtime/realtime.service';
import {
  INITIAL_RIDE_STATUS,
  RIDE_ERRORS,
  RideStateService,
  notYourRideError,
  rideNotFoundError,
} from './ride-state.service';

/**
 * The typed error set, re-exported from the module's public face so a caller
 * that only knows about RidesService can still branch on `code` without
 * reaching into the state machine's file.
 */
export {
  RIDE_ERRORS,
  invalidTransitionError,
  notYourRideError,
  rideNotFoundError,
  rideStatusChangedError,
  type RideErrorBody,
  type RideErrorCode,
} from './ride-state.service';

/**
 * A ride as a client sees it once dispatch exists.
 *
 * Extends the shared RideSummary rather than changing it: RideSummary is the
 * minimal shape every surface already renders (history lists, receipts, the
 * admin table), and widening it would push the live-trip fields into places
 * that have no use for them. The extra fields are what a rider watching a trip
 * in progress needs — when each stage happened, who is driving, and the pickup
 * code they have to read out.
 */
export interface RideView extends RideSummary {
  searchingAt: ISODateTime | null;
  acceptedAt: ISODateTime | null;
  arrivedAt: ISODateTime | null;
  startedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  cancelledBy: RideEventActor | null;
  cancelReason: string | null;
  /** Populated once a driver is assigned. Never carries the driver's phone number. */
  driver: RideDriverInfo | null;
  /** The 4-digit pickup code. Returned to the RIDER only — see {@link toRideView}. */
  pickupOtp: string | null;
  /**
   * Encoded polyline of the road route, for drawing the trip on a map.
   *
   * Null for rides quoted while no routing provider answered, and for every
   * ride created before the route was stored. Clients fall back to joining the
   * two pins in that case, which is the behaviour every ride had before.
   */
  routePolyline: string | null;
}

/**
 * Who the payload is being built for. This is a redaction rule, not a
 * formatting one: the driver app and the support console receive the same ride
 * through different endpoints and must not receive the same fields.
 */
export type RideViewAudience = 'rider' | 'driver' | 'admin';

/**
 * The parties a ride view needs, loaded with the ride.
 *
 * Explicit selects, not `driver: true`: the users row carries the password
 * hash, the encrypted TOTP secret and the driver's real phone number, and a
 * rider-facing payload has no business pulling any of them into process memory
 * where the next careless spread operator can leak them.
 *
 * Exported with {@link toRideView} so the dispatch loop and the realtime
 * gateway render a ride the same way this service does — one redaction rule in
 * one place is what keeps the pickup code from reaching a driver's socket.
 */
export const RIDE_PARTIES_INCLUDE = {
  driver: {
    select: {
      userId: true,
      ratingSum: true,
      ratingCount: true,
      user: { select: { fullName: true } },
    },
  },
  vehicle: {
    select: { id: true, make: true, model: true, year: true, color: true, plate: true },
  },
} as const;

/** The matched driver, as narrow as RideDriverInfo needs and no wider. */
interface RideDriverRow {
  userId: string;
  ratingSum: number;
  ratingCount: number;
  user: { fullName: string | null };
}

interface RideVehicleRow {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  plate: string;
}

/**
 * A ride row loaded with {@link RIDE_PARTIES_INCLUDE}. Written out rather than
 * derived with Prisma.RideGetPayload to match how the admin module types its
 * own includes, and because the explicit shape is what makes the selects above
 * reviewable: if the two drift apart, every call site stops compiling.
 */
export type RideWithParties = Ride & {
  driver: RideDriverRow | null;
  vehicle: RideVehicleRow | null;
};

/**
 * Statuses where the pickup code still has a job to do.
 *
 * It is spent the moment the trip starts, so it stops being returned then: a
 * code that no longer opens anything has no reason to keep travelling to a
 * device or sitting in a response cache. This is the same list as
 * CANCELLABLE_RIDE_STATUSES today, which is a coincidence of the current state
 * machine rather than a shared rule — hence its own constant.
 */
const OTP_VISIBLE_STATUSES: readonly RideStatus[] = [
  'requested',
  'searching',
  'accepted',
  'driver_arriving',
  'arrived',
];

/**
 * RidesService — booking-flow core (Phase 3).
 *
 * Ownership is enforced here in addition to the DB-level RLS policy, because
 * the Nest service connects to Postgres as the table owner (which bypasses
 * RLS). Nothing in this file writes `status` directly: every change goes
 * through RideStateService so it is checked against the state machine and
 * lands in the event log with the transition that caused it.
 */
@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingClient,
    private readonly state: RideStateService,
    private readonly realtime: RealtimeService,
    private readonly surge: SurgeService,
    private readonly routes: RouteEstimatorService,
  ) {}

  /** Fare estimate — no DB write, and deliberately no demand recorded. */
  async quote(input: QuoteRequestInput): Promise<FareQuote> {
    const { polyline, ...inputs } = await this.pricingInputsFor(input.pickup, input.dropoff);
    const fare = await this.pricing.quote(input, inputs);
    // Attached here rather than inside PricingClient: the polyline is the route
    // this fare was priced on, and it must not survive the local-fallback path
    // where the distance is a guess and there is no route to show.
    return { ...fare, routePolyline: polyline };
  }

  /**
   * The two live inputs a fare needs beyond the tariff: what surge applies at
   * the pickup right now, and how far the trip really is by road.
   *
   * Without this the pricing service had nothing to work with. SurgeService and
   * RouteEstimatorService were built but never injected anywhere, so every
   * quote went out at 1.0x on straight-line distance at a flat 28 km/h — a 5 km
   * crow-flies trip on a 6.8 km road route was underquoted by a quarter, and a
   * concert letting out priced exactly like 4am.
   *
   * The two lookups are independent, so they run in parallel: surge is a few
   * Redis reads and the route is at most one cached Google call. Neither throws —
   * both fall back internally — so a slow maps provider degrades a quote to the
   * detour-factor estimate instead of failing the booking.
   */
  private async pricingInputsFor(
    pickup: { lat: number; lng: number },
    dropoff: { lat: number; lng: number },
  ): Promise<PricingInputs & { polyline: string | null }> {
    const [surgeMultiplier, route] = await Promise.all([
      this.surge.multiplierFor(pickup.lat, pickup.lng),
      this.routes.estimate(pickup, dropoff),
    ]);
    return {
      surgeMultiplier,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      polyline: route.polyline,
    };
  }

  /**
   * Create a ride request. Fare is re-quoted server-side (never trust the
   * client's number), and the row plus its genesis event are written together
   * so the ride exists in the log from the first instant it exists at all.
   */
  async create(riderId: string, input: RideRequestInput): Promise<RideView> {
    // Quoted before the transaction opens, deliberately. This is an HTTP call
    // to the pricing service, and holding a pooled Postgres connection open
    // across a network round trip is how a slow dependency turns into pool
    // exhaustion for every other request.
    const { polyline, ...pricingInputs } = await this.pricingInputsFor(
      input.pickup,
      input.dropoff,
    );
    const fare = await this.pricing.quote(
      {
        pickup: input.pickup,
        dropoff: input.dropoff,
        rideClass: input.rideClass,
      },
      pricingInputs,
    );

    const ride = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ride.create({
        data: {
          riderId,
          status: INITIAL_RIDE_STATUS,
          rideClass: input.rideClass,
          pickupLat: input.pickup.lat,
          pickupLng: input.pickup.lng,
          dropoffLat: input.dropoff.lat,
          dropoffLng: input.dropoff.lng,
          pickupAddress: input.pickupAddress,
          dropoffAddress: input.dropoffAddress,
          distanceMeters: fare.distanceMeters,
          durationSeconds: fare.durationSeconds,
          fareCents: fare.fareCents,
          currency: fare.currency,
          // Stored so the live trip map can draw the road route instead of a
          // straight line between the pins. Null when no provider answered;
          // the client falls back for that trip rather than showing nothing.
          routePolyline: polyline,
          pickupOtp: generatePickupOtp(),
        },
      });
      await this.state.recordRequested(tx, created, riderId, {
        rideClass: input.rideClass,
        fareCents: fare.fareCents,
        surgeMultiplier: fare.surgeMultiplier,
      });
      return created;
    });

    this.logger.log(`Ride ${ride.id} requested by ${riderId} (${input.rideClass}).`);

    // Demand is counted on a REQUEST, never on a quote, and only after commit.
    //
    // Counting quotes would let one rider drag the pin around and push the price
    // up for the whole neighbourhood; a rider comparing ride classes fires
    // several quotes for one trip. A committed request is the signal that
    // someone actually wants a car. After commit, so a rolled-back request never
    // counts. recordDemand never throws, so surge bookkeeping cannot fail a
    // booking that already succeeded.
    await this.surge.recordDemand(input.pickup.lat, input.pickup.lng, riderId);
    // The parties are filled in by hand rather than re-read with an include: a
    // ride one statement old cannot have a driver or a car yet, and this is the
    // hottest write in the booking flow.
    return toRideView({ ...ride, driver: null, vehicle: null }, 'rider');
  }

  async get(riderId: string, id: string): Promise<RideView> {
    const ride = await this.prisma.ride.findUnique({
      where: { id },
      include: RIDE_PARTIES_INCLUDE,
    });
    if (!ride) throw rideNotFoundError();
    if (ride.riderId !== riderId) throw notYourRideError();
    return toRideView(ride, 'rider');
  }

  async listMine(riderId: string, limit = 20): Promise<RideView[]> {
    const rides = await this.prisma.ride.findMany({
      where: { riderId },
      orderBy: { requestedAt: 'desc' },
      take: limit,
      include: RIDE_PARTIES_INCLUDE,
    });
    return rides.map((ride) => toRideView(ride, 'rider'));
  }

  /**
   * One ride for an audience that has already been authorised elsewhere — the
   * realtime broadcast after a transition, the driver's active-trip screen, the
   * support console.
   *
   * Performs no ownership check on purpose: the caller knows which party it is
   * serving, which is the same knowledge the redaction needs. Rider-facing
   * entry points are {@link get} and {@link listMine}, which do check.
   */
  async view(id: string, audience: RideViewAudience): Promise<RideView> {
    const ride = await this.prisma.ride.findUnique({
      where: { id },
      include: RIDE_PARTIES_INCLUDE,
    });
    if (!ride) throw rideNotFoundError();
    return toRideView(ride, audience);
  }

  /**
   * Rider-initiated cancellation.
   *
   * Everything happens in one transaction, including revoking the offers still
   * out with drivers. Leaving those pending for even a moment means a driver
   * can accept a ride that no longer exists — and because a driver may hold
   * only one pending offer at a time, a stale row also locks them out of the
   * next real ride until the expiry sweeper catches up.
   */
  async cancel(riderId: string, id: string, input: RideCancelInput): Promise<RideView> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      // Loaded inside the transaction rather than reusing get(): a ride read
      // before the transaction opened could have been accepted, started or
      // cancelled in between, and the cancellability gate has to be applied to
      // the status this write will actually be racing against.
      const ride = await tx.ride.findUnique({ where: { id } });
      if (!ride) throw rideNotFoundError();
      if (ride.riderId !== riderId) throw notYourRideError();

      // Gate on cancellability, NOT on non-terminality: `in_progress`,
      // `completed` and the payment states are all non-terminal, so the looser
      // check let a rider cancel a trip they had already taken.
      if (!isCancellableRideStatus(ride.status as RideStatus)) {
        throw new BadRequestException({
          code: RIDE_ERRORS.notCancellable,
          message: `A ride that is ${ride.status} can no longer be cancelled.`,
        });
      }

      // `responded_at` stays null. It records the DRIVER's answer, and a
      // revoked offer was never answered — stamping it would quietly corrupt
      // the response-time and acceptance-rate figures that drive dispatch
      // ranking and deactivation decisions.
      const revoked = await tx.rideOffer.updateMany({
        where: { rideId: id, status: 'pending' },
        data: { status: 'revoked' },
      });

      // Release the assigned driver back to the dispatch pool.
      //
      // This is not optional bookkeeping. A rider can cancel from `accepted`,
      // `driver_arriving` and `arrived` — all states where a driver is already
      // attached and their availability row reads `on_trip` with
      // `current_ride_id` pointing here. Cancelling the ride without clearing
      // that leaves the driver permanently invisible to dispatch: they are not
      // `online`, so `findNearbyDrivers` skips them, and nothing else ever
      // resets the row. The driver's app shows them online while they receive
      // no work, and the DB CHECK stays satisfied the whole time, so nothing
      // complains.
      //
      // Guarded on `currentRideId` so a driver who has already moved on to
      // another trip (a reassignment landed between our read and this write)
      // is not yanked out of it.
      if (ride.driverId) {
        await tx.driverAvailability.updateMany({
          where: { driverId: ride.driverId, currentRideId: id },
          data: { status: 'online', currentRideId: null },
        });
      }

      await this.state.transition(tx, ride, 'cancelled_by_rider', {
        actorType: 'rider',
        actorId: riderId,
        type: 'ride.cancelled',
        metadata: {
          reason: input.reason,
          note: input.note ?? null,
          // The stage the rider bailed at is what a no-fault-cancellation
          // policy is written against; `status` alone stops telling you once
          // the row has moved on.
          cancelledFrom: ride.status,
          offersRevoked: revoked.count,
        },
        extraData: { cancelReason: input.reason },
      });

      const updated = await tx.ride.findUniqueOrThrow({
        where: { id },
        include: RIDE_PARTIES_INCLUDE,
      });
      this.logger.log(
        `Ride ${id} cancelled by rider ${riderId} from ${ride.status} ` +
          `(${revoked.count} offer(s) revoked).`,
      );
      return updated;
    });

    // Announce AFTER the commit, never inside it. Emitting from within the
    // transaction would tell a driver the trip is cancelled and then, on a
    // rollback, leave them the only party who believes it.
    //
    // The driver is the one who needs this: they may be actively driving to a
    // pickup that no longer exists, and polling would leave them doing it for
    // up to another cycle. Sent on the ride room, which the driver joined when
    // they accepted.
    this.realtime.emitRideStatus(cancelled.id, toRideView(cancelled, 'driver'));

    return toRideView(cancelled, 'rider');
  }
}

/**
 * The 4-digit code the rider reads out before the trip may start.
 *
 * crypto.randomInt, never Math.random. Math.random is a fast non-cryptographic
 * PRNG whose internal state can be recovered from a handful of observed
 * outputs, and a driver sees a fresh code on every ride they take — so a
 * predictable generator hands the one person with the most samples the ability
 * to guess the next rider's code. That code is the only thing standing between
 * a driver and starting a trip the rider was never in, which is how fake-ride
 * payout fraud works. randomInt draws from the platform CSPRNG and rejection-
 * samples its range, so 0000-9999 is uniform rather than modulo-biased.
 */
function generatePickupOtp(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** Map a Prisma row to the wire shape (ISO timestamps, nested coords, redaction). */
export function toRideView(r: RideWithParties, audience: RideViewAudience): RideView {
  const status = r.status as RideStatus;
  return {
    id: r.id as RideSummary['id'],
    riderId: r.riderId as RideSummary['riderId'],
    driverId: (r.driverId ?? null) as RideSummary['driverId'],
    status,
    rideClass: r.rideClass as RideClass,
    pickup: { lat: r.pickupLat, lng: r.pickupLng },
    dropoff: { lat: r.dropoffLat, lng: r.dropoffLng },
    pickupAddress: r.pickupAddress,
    dropoffAddress: r.dropoffAddress,
    distanceMeters: r.distanceMeters,
    durationSeconds: r.durationSeconds,
    fareCents: (r.fareCents ?? null) as RideSummary['fareCents'],
    currency: r.currency as RideSummary['currency'],
    requestedAt: r.requestedAt.toISOString() as ISODateTime,
    searchingAt: isoOrNull(r.searchingAt),
    acceptedAt: isoOrNull(r.acceptedAt),
    arrivedAt: isoOrNull(r.arrivedAt),
    startedAt: isoOrNull(r.startedAt),
    completedAt: isoOrNull(r.completedAt),
    cancelledAt: isoOrNull(r.cancelledAt),
    cancelledBy: (r.cancelledBy ?? null) as RideEventActor | null,
    cancelReason: r.cancelReason,
    driver: toDriverInfo(r),
    // The one field in this payload that is a secret rather than a detail. It
    // goes to the rider, and only while it can still be used: the driver
    // endpoints share this mapper, and a driver who can read the code does not
    // need the rider to be in the car.
    pickupOtp: audience === 'rider' && OTP_VISIBLE_STATUSES.includes(status) ? r.pickupOtp : null,
    // Not redacted by audience: the driver needs the route as much as the
    // rider, and it describes the trip rather than either party.
    routePolyline: r.routePolyline ?? null,
  };
}

/**
 * What the rider is told about who is picking them up.
 *
 * Deliberately narrow, per the RideDriverInfo contract: enough to identify the
 * person and the car at the kerb, and nothing that would let a rider find the
 * driver afterwards. Contact goes through a masked channel in a later phase.
 */
function toDriverInfo(r: RideWithParties): RideDriverInfo | null {
  const driver = r.driver;
  if (!driver) return null;
  const vehicle = r.vehicle;
  return {
    driverId: driver.userId as DriverId,
    firstName: firstNameOf(driver.user.fullName),
    // The table stores the running sum and count; the wire carries the mean,
    // rounded to the two decimals every surface displays.
    ratingAvg:
      driver.ratingCount > 0
        ? Math.round((driver.ratingSum / driver.ratingCount) * 100) / 100
        : null,
    ratingCount: driver.ratingCount,
    vehicleId: (vehicle?.id ?? null) as VehicleId | null,
    vehicleDescription: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
    vehiclePlate: vehicle?.plate ?? null,
    vehicleColor: vehicle?.color ?? null,
  };
}

/**
 * First name only. A rider needs "Sam" to find the right car; the surname is
 * identifying information they have no use for and the driver did not agree to
 * share with every passenger.
 */
function firstNameOf(fullName: string | null): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first ? first : null;
}

function isoOrNull(value: Date | null): ISODateTime | null {
  return value ? (value.toISOString() as ISODateTime) : null;
}
