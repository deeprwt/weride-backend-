import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Ride } from '@prisma/client';
import {
  ACTIVE_TRIP_STATUSES,
  isTerminalRideStatus,
  type LatLng,
  type RideClass,
  type RideOffer,
  type RideOfferForDriver,
  type RideStatus,
} from '@uride/types';
import type {
  DriverArrivedInput,
  DriverCancelInput,
  OfferAcceptInput,
  OfferDeclineInput,
  RideCompleteInput,
  RideStartInput,
} from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { MatchingService } from '../matching/matching.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { RideEventsService } from './ride-events.service';
import { RideStateService, notYourRideError, rideNotFoundError } from './ride-state.service';
import {
  RIDE_PARTIES_INCLUDE,
  toRideView,
  type RideView,
  type RideWithParties,
} from './rides.service';

/**
 * What the driver app gets back the instant it wins a ride.
 *
 * The ride view alone is not enough: the navigation screen opens on the pickup
 * and needs the distance and ETA the matcher recomputed from where the driver
 * actually was when they tapped accept — numbers that exist nowhere on the ride
 * row, because the row records the TRIP's distance, not the driver's approach.
 */
export interface AcceptedTrip {
  ride: RideView;
  /** Straight-line metres from the accepting driver to the pickup. */
  pickupDistanceMeters: number;
  pickupEtaSeconds: number;
}

/** Errors this surface adds to the shared set in ride-state.service. */
export const DRIVER_RIDE_ERRORS = {
  invalidPickupCode: 'invalid_pickup_code',
  pickupCodeUnavailable: 'pickup_code_unavailable',
} as const;

/**
 * A wrong pickup code is recorded, not merely refused.
 *
 * Its own event type rather than a field on a transition event, because it
 * annotates a ride without moving it (`to_status` null, which
 * RideEventsService.replayStatus deliberately folds past) and because ops needs
 * to ask "who is accumulating these" with one predicate on `ride_events.type`.
 * A driver guessing at codes is the earliest visible signal of fake-ride fraud.
 */
const PICKUP_CODE_REJECTED_EVENT = 'ride.pickup_code_rejected';

/** Misses on one ride past which this stops looking like a mistyped digit. */
const PICKUP_CODE_SUSPICIOUS_ATTEMPTS = 3;

/**
 * Platform commission, as a fraction of the fare.
 *
 * A constant here, deliberately, and the only number in this file that is not
 * final. Commission belongs to the payments module (Phase 4) — it varies by
 * city, by driver agreement and by promotion, and none of that exists yet. The
 * offer card needs an earnings figure regardless: a driver decides in about
 * five seconds whether a trip is worth taking, and "you will be paid, amount to
 * follow" is not a decision anyone can make. An honest interim split that moves
 * to payments intact beats a zero or a missing field.
 */
const PLATFORM_COMMISSION_RATE = 0.2;

/**
 * DriverRidesService — the trip as the driver drives it.
 *
 * The same ride the rider is watching, seen from the other seat, so three rules
 * hold on every method here.
 *
 * **Ownership is checked in this service.** A driver may act only on a ride
 * whose `driver_id` is theirs. The `rides` RLS policies say the same thing, but
 * they are not what enforces it: Nest connects to Postgres as the table owner,
 * and the owner bypasses RLS. Those policies are the second fence, for a future
 * consumer connecting as a restricted role — {@link loadOwnedRide} is the check
 * that actually runs today.
 *
 * **Every status change goes through RideStateService.** Not one line in this
 * file writes `rides.status`. That is what makes an illegal move — starting a
 * trip nobody accepted, completing one twice — a 409 instead of a corrupted
 * row, and what guarantees the matching `ride_events` row exists.
 *
 * **Every committed change is announced.** The rider's screen is driven by
 * `ride:status` frames, not by polling, so a transition nobody emitted is a
 * rider staring at a stale map with a car outside their door. Emission happens
 * AFTER the transaction commits: announcing from inside one would broadcast a
 * state that a rollback then erased.
 */
@Injectable()
export class DriverRidesService {
  private readonly logger = new Logger(DriverRidesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: RideStateService,
    private readonly events: RideEventsService,
    private readonly matching: MatchingService,
    private readonly realtime: RealtimeService,
  ) {}

  // -------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------

  /**
   * The offer this driver is currently being asked about, or null.
   *
   * The app calls this on launch and after every reconnect: a push that landed
   * while the phone was asleep, or a socket frame lost in a tunnel, must not
   * cost a driver the ride. Null is the ordinary answer, not an error.
   *
   * `secondsRemaining` is computed here from `expires_at` rather than carried
   * over from whatever the offer frame said, so a device with a slow clock —
   * or one deliberately holding its countdown open — cannot show a timer for an
   * offer the server has already let go. The expiry check inside
   * {@link MatchingService.acceptOffer} is what actually refuses a late accept;
   * this is what stops the app from displaying a lie until then.
   */
  async currentOffer(driverId: string): Promise<RideOfferForDriver | null> {
    const [offer] = await this.matching.pendingOffersForDriver(driverId);
    if (!offer) return null;

    const secondsRemaining = secondsUntil(offer.expiresAt);
    if (secondsRemaining <= 0) return null;

    const ride = await this.prisma.ride.findUnique({ where: { id: offer.rideId } });
    if (!ride) return null;

    // A pending row whose ride has moved on: the revoke that should have
    // retired it was lost (a Redis blip, a process restart) and the sweeper has
    // not caught up yet. Rendering it would put a countdown in front of a driver
    // for a trip another driver is already on. The row is left alone rather than
    // retired here — a GET should not have side effects, and a driver polling
    // this endpoint is the wrong thing to hang offer bookkeeping off.
    if (ride.driverId !== null || isTerminalRideStatus(ride.status as RideStatus)) {
      this.logger.debug(
        `Offer ${offer.id} for driver ${driverId} is stale (ride ${ride.id} is ${ride.status}).`,
      );
      return null;
    }

    return {
      offer,
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
      pickupAddress: ride.pickupAddress,
      dropoff: { lat: ride.dropoffLat, lng: ride.dropoffLng },
      dropoffAddress: ride.dropoffAddress,
      rideClass: ride.rideClass as RideClass,
      driverEarningsCents: driverEarningsCentsFor(ride.fareCents),
      tripDistanceMeters: ride.distanceMeters,
      tripDurationSeconds: ride.durationSeconds,
      secondsRemaining,
    };
  }

  /**
   * Take the ride.
   *
   * Delegated whole to the matcher. Accept is where two drivers race for one
   * row, and that race is settled by the `ride_offers_one_accepted_per_ride`
   * unique index inside MatchingService's transaction; a second implementation
   * of the claim here — even a well-meaning pre-check — would be a second place
   * that can get it wrong. This method's own job is the part the matcher does
   * not do: telling the rider, who has been watching a spinner, that a car is
   * on its way.
   */
  async acceptOffer(
    driverId: string,
    offerId: string,
    input: OfferAcceptInput,
  ): Promise<AcceptedTrip> {
    const acceptance = await this.matching.acceptOffer(driverId, offerId, input);
    const ride = await this.loadView(acceptance.rideId);

    this.realtime.emitRideStatus(acceptance.rideId, ride);
    return {
      ride,
      pickupDistanceMeters: acceptance.pickupDistanceMeters,
      pickupEtaSeconds: acceptance.pickupEtaSeconds,
    };
  }

  /**
   * Pass.
   *
   * Nothing is emitted to the rider: from their side a decline is not an event,
   * it is the absence of one — the ride stays `searching` and the next wave goes
   * out (MatchingService re-dispatches immediately rather than waiting for the
   * worker's tick). Telling a waiting rider "a driver said no" would be an
   * anxiety generator with no action attached to it.
   */
  async declineOffer(
    driverId: string,
    offerId: string,
    input: OfferDeclineInput,
  ): Promise<RideOffer> {
    return this.matching.declineOffer(driverId, offerId, input);
  }

  // -------------------------------------------------------------------------
  // The trip
  // -------------------------------------------------------------------------

  /**
   * The trip this driver is on, or null.
   *
   * Driven off ACTIVE_TRIP_STATUSES — the contract's own definition of "a
   * driver is assigned and the rider should see them moving" — rather than a
   * list spelled out again here, so a status added to the trip lifecycle cannot
   * quietly stop appearing on the driver's home screen. At most one row can
   * match in practice (`driver_availability.current_ride_id` and its CHECK see
   * to that); the query is ordered and capped anyway, so that if the invariant
   * ever breaks the driver gets their newest trip rather than an arbitrary one.
   */
  async currentTrip(driverId: string): Promise<RideView | null> {
    const ride = await this.prisma.ride.findFirst({
      where: { driverId, status: { in: [...ACTIVE_TRIP_STATUSES] } },
      orderBy: { acceptedAt: 'desc' },
      include: RIDE_PARTIES_INCLUDE,
    });
    return ride ? toRideView(ride, 'driver') : null;
  }

  /** The driver's recent trips, newest first — their history and earnings screen. */
  async listMine(driverId: string, limit = 20): Promise<RideView[]> {
    const rides = await this.prisma.ride.findMany({
      where: { driverId },
      orderBy: { requestedAt: 'desc' },
      take: limit,
      include: RIDE_PARTIES_INCLUDE,
    });
    return rides.map((ride) => toRideView(ride, 'driver'));
  }

  /**
   * "I am at the pickup."
   *
   * Accepts from `accepted` as well as from `driver_arriving`, a move the state
   * machine has no single edge for — `accepted -> arrived` is absent from
   * RIDE_TRANSITIONS. Rather than widen the contract, a driver who never passed
   * through `driver_arriving` is walked over both edges inside one transaction.
   * That case is ordinary rather than exotic: a two-block pickup, or an app that
   * was backgrounded when it should have reported the driver setting off. Both
   * events land in the log, so the history still reads as a journey instead of
   * a jump, and the intermediate one is marked as inferred so a later look at
   * pickup times can tell an observation from bookkeeping.
   */
  async markArrived(
    driverId: string,
    rideId: string,
    input: DriverArrivedInput,
  ): Promise<RideView> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const ride = await this.loadOwnedRide(tx, driverId, rideId);

      const enRoute =
        ride.status === 'accepted'
          ? await this.state.transition(tx, ride, 'driver_arriving', {
              actorType: 'driver',
              actorId: driverId,
              metadata: { inferred: true, reason: 'arrival reported before departure' },
            })
          : ride;

      return this.state.transition(tx, enRoute, 'arrived', {
        actorType: 'driver',
        actorId: driverId,
        metadata: { location: locationMetadata(input.location) },
      });
    });

    return this.publish(updated);
  }

  /**
   * Start the trip — the anti-fraud gate.
   *
   * The 4-digit code the rider reads out is the only evidence the server ever
   * gets that the rider is actually in the car. Without it a driver can accept,
   * "arrive", start and complete a trip nobody took and be paid for it; that is
   * the standard shape of fake-ride payout fraud, and it is why this is the one
   * driver action with a secret attached.
   *
   * Two things defend a 10,000-value space, and neither is the comparison
   * itself. The controller's per-driver rate limit is the real control: it
   * turns an exhaustive search into something that takes days instead of
   * seconds. This method supplies the other — every miss is written to
   * `ride_events` before the refusal is thrown, in a transaction of its own,
   * precisely because it has to survive that refusal. An event appended inside
   * the failing path would roll back with it and ops would see nothing at all.
   *
   * The comparison is a plain one, not a constant-time one. Timing is not the
   * exposure on a four-digit code reached over the public internet — it is
   * brute-forced by guessing, not by measuring — and guessing is what the rate
   * limit and this log close off.
   */
  async startTrip(driverId: string, rideId: string, input: RideStartInput): Promise<RideView> {
    const ride = await this.loadOwnedRide(this.prisma, driverId, rideId);

    if (!ride.pickupOtp) {
      // Nothing to check against. Refusing is the only safe answer: letting it
      // through would make the gate optional for any ride that lost its code,
      // which is exactly the ride an attacker would arrange to be holding.
      this.logger.error(`Ride ${rideId} has no pickup code on file; refusing to start it.`);
      throw new ForbiddenException({
        code: DRIVER_RIDE_ERRORS.pickupCodeUnavailable,
        message: 'This trip has no pickup code on file. Contact support.',
      });
    }

    if (input.pickupOtp !== ride.pickupOtp) {
      await this.recordPickupCodeRejection(ride, driverId, input.location);
      throw new ForbiddenException({
        code: DRIVER_RIDE_ERRORS.invalidPickupCode,
        // Says nothing about the real code. An error that narrows the search
        // space is a worse error than a vague one.
        message: 'That pickup code is not right. Ask your rider to read it again.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Re-read inside the transaction. The code check above ran against a row
      // the rider could have cancelled since; the conditional UPDATE in
      // RideStateService is what settles that race, and it has to be given the
      // row this transaction will actually be competing with.
      const fresh = await this.loadOwnedRide(tx, driverId, rideId);
      return this.state.transition(tx, fresh, 'in_progress', {
        actorType: 'driver',
        actorId: driverId,
        metadata: { location: locationMetadata(input.location), pickupCodeVerified: true },
      });
    });

    this.logger.log(`Driver ${driverId} started ride ${rideId}.`);
    return this.publish(updated);
  }

  /**
   * End the trip.
   *
   * Three writes that have to commit together: the transition, the driver going
   * back into the dispatch pool, and their ride count. A completion that frees
   * nobody leaves a driver `on_trip` forever — invisible to dispatch, unable to
   * go offline (DriversService refuses that mid-trip), and effectively locked
   * out of the platform until somebody edits the database by hand.
   *
   * `actual_distance_meters` is written beside the quoted estimate, never over
   * it. A fare dispute needs both numbers: what the rider was quoted, and what
   * the car actually drove.
   */
  async complete(driverId: string, rideId: string, input: RideCompleteInput): Promise<RideView> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const ride = await this.loadOwnedRide(tx, driverId, rideId);

      const moved = await this.state.transition(tx, ride, 'completed', {
        actorType: 'driver',
        actorId: driverId,
        metadata: {
          location: locationMetadata(input.location),
          actualDistanceMeters: input.actualDistanceMeters ?? null,
          quotedDistanceMeters: ride.distanceMeters,
        },
        // Written only when the app actually tracked it. Defaulting to the
        // quote would put an estimate in the column reserved for the
        // measurement, and nothing downstream could tell the two apart again.
        extraData:
          input.actualDistanceMeters === undefined
            ? undefined
            : { actualDistanceMeters: input.actualDistanceMeters },
      });

      await this.releaseDriver(tx, driverId, ride.id);

      // The lifetime counter on the driver's profile, and the denominator every
      // rating is read against. Incremented rather than recomputed: a COUNT
      // over every ride they have ever driven, on the hot path of every
      // completion, to produce a number that only ever goes up by one.
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: { totalRides: { increment: 1 } },
      });

      return moved;
    });

    this.logger.log(`Driver ${driverId} completed ride ${rideId}.`);
    return this.publish(updated);
  }

  /**
   * The driver bails after accepting — a no-show rider, a flat tyre, a pickup
   * they cannot physically reach.
   *
   * Terminal, and deliberately not re-dispatched: `cancelled_by_driver` has no
   * outgoing edge in RIDE_TRANSITIONS, so the rider requests again rather than
   * being silently handed on. Re-dispatching here would mean a rider whose trip
   * was cancelled watching a different car appear without ever being told the
   * first one dropped them — and it needs an edge the contract does not have.
   *
   * Cancelling an `in_progress` trip is refused by the state machine, which is
   * the right answer: once the wheels are turning the trip either completes or
   * becomes a support case with a refund attached. It is not a driver-side undo.
   */
  async cancel(driverId: string, rideId: string, input: DriverCancelInput): Promise<RideView> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const ride = await this.loadOwnedRide(tx, driverId, rideId);

      const moved = await this.state.transition(tx, ride, 'cancelled_by_driver', {
        actorType: 'driver',
        actorId: driverId,
        // Same event name as the rider's cancellation. Who did it is already on
        // the row in `cancelled_by`, and one name means one query answers "how
        // many trips were cancelled" without knowing every spelling of it.
        type: 'ride.cancelled',
        metadata: {
          reason: input.reason,
          note: input.note ?? null,
          // The stage they abandoned at is what a driver-cancellation-rate
          // policy is written against: bailing before arriving and bailing
          // after a ten-minute wait are not the same behaviour, and `status`
          // stops being able to tell you once the row has moved on.
          cancelledFrom: ride.status,
        },
        extraData: { cancelReason: input.reason },
      });

      // Straight back into the pool. A driver whose rider never showed up is
      // available again immediately; leaving them `on_trip` would charge them
      // for the rider's no-show.
      await this.releaseDriver(tx, driverId, ride.id);
      return moved;
    });

    this.logger.warn(`Driver ${driverId} cancelled ride ${rideId}: ${input.reason}.`);
    return this.publish(updated);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Load a ride and prove it is this driver's.
   *
   * The ownership check lives here, in the service, rather than being left to
   * the `rides` RLS policy: the API connects to Postgres as the table owner,
   * and the owner bypasses RLS entirely. The policy is the fence for a future
   * consumer connecting as a restricted role; this comparison is the one that
   * runs on every request today.
   *
   * A ride that exists but belongs to someone else answers 403, not 404. The id
   * came from the driver's own trip list or from an offer addressed to them, so
   * "not yours" tells them nothing they could not already work out — and a 404
   * would send an app holding a stale id into a retry loop against a ride that
   * is perfectly real.
   *
   * Takes the client rather than reaching for `this.prisma`, so the ownership
   * read happens on the caller's transaction and sees the same snapshot as the
   * write that follows it.
   */
  private async loadOwnedRide(
    client: Prisma.TransactionClient,
    driverId: string,
    rideId: string,
  ): Promise<Ride> {
    const ride = await client.ride.findUnique({ where: { id: rideId } });
    if (!ride) throw rideNotFoundError();
    if (ride.driverId !== driverId) throw notYourRideError();
    return ride;
  }

  /**
   * Put the driver back in the dispatch pool.
   *
   * Guarded on `current_ride_id` so it can only ever release the driver from
   * THIS trip: a stale request replayed after they have accepted their next
   * ride would otherwise unassign a trip with a passenger already in the car.
   * Both columns move together because `driver_availability_trip_consistency`
   * requires it — `on_trip` with a null ride id is a state the database refuses,
   * and rightly so.
   *
   * `online`, not `offline`: they were online to have been dispatched at all,
   * and a driver finishing a fare expects the next one rather than a logout. A
   * driver who wants to stop presses go-offline, which this write makes
   * possible again.
   */
  private async releaseDriver(
    tx: Prisma.TransactionClient,
    driverId: string,
    rideId: string,
  ): Promise<void> {
    const { count } = await tx.driverAvailability.updateMany({
      where: { driverId, currentRideId: rideId },
      data: { status: 'online', currentRideId: null },
    });
    if (count === 0) {
      // Not fatal, and not worth rolling a finished trip back over: ops may
      // have force-released the driver, or the row may have been reassigned.
      // Worth a line, because the other explanation is a bug that leaves
      // drivers stuck `on_trip`.
      this.logger.warn(
        `Driver ${driverId} was not attached to ride ${rideId} when it ended; ` +
          'availability left untouched.',
      );
    }
  }

  /**
   * Write the miss to the ride's history, on its own transaction so it survives
   * the refusal that follows.
   *
   * The attempt number is counted by replaying the ride's own log rather than
   * kept in a counter: that is a dozen rows over an index the support console
   * hits anyway, on a path that only runs once somebody has already got the code
   * wrong, and it means the count can never drift from the events it describes.
   *
   * Never throws. A logging failure must not turn a wrong 4-digit code into a
   * 500 — that would tell the guesser nothing useful while hiding the miss from
   * the only people who need to see it.
   */
  private async recordPickupCodeRejection(
    ride: Ride,
    driverId: string,
    location: LatLng | undefined,
  ): Promise<void> {
    try {
      const history = await this.events.listForRide(ride.id);
      const attempt = history.filter((e) => e.type === PICKUP_CODE_REJECTED_EVENT).length + 1;

      await this.prisma.$transaction((tx) =>
        this.events.append(tx, {
          rideId: ride.id,
          type: PICKUP_CODE_REJECTED_EVENT,
          fromStatus: ride.status as RideStatus,
          // Null: this records something that happened TO the ride without
          // moving it, and replayStatus skips those rather than resetting.
          toStatus: null,
          actorType: 'driver',
          actorId: driverId,
          // The submitted digits are not stored. Keeping rejected guesses would
          // build a table of near-misses against live codes for whoever reads
          // the log later, and the fact of the miss is the entire signal.
          metadata: { attempt, location: locationMetadata(location) },
        }),
      );

      if (attempt >= PICKUP_CODE_SUSPICIOUS_ATTEMPTS) {
        this.logger.warn(
          `Driver ${driverId} has missed the pickup code ${attempt} times on ride ${ride.id}.`,
        );
      } else {
        this.logger.log(
          `Driver ${driverId} gave the wrong pickup code for ride ${ride.id} (attempt ${attempt}).`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not record a pickup-code miss on ride ${ride.id}: ${detail}`);
    }
  }

  /**
   * Announce a committed transition, and hand the driver their view of it.
   *
   * One funnel, so that no endpoint can move a ride and forget to tell the
   * rider — which is a stationary map with a car outside the window. The frame
   * carries the DRIVER-audience view: both parties share the ride room, and the
   * rider-audience view is the one that carries the pickup code. RealtimeService
   * strips that field on the way out as well, and sending it there in the first
   * place would be relying on somebody else's belt to hold up our trousers.
   */
  private async publish(ride: Ride): Promise<RideView> {
    const view = await this.loadView(ride.id);
    this.realtime.emitRideStatus(ride.id, view);
    return view;
  }

  /** Re-read with the parties attached — the driver's name and car are joins. */
  private async loadView(rideId: string): Promise<RideView> {
    const ride: RideWithParties | null = await this.prisma.ride.findUnique({
      where: { id: rideId },
      include: RIDE_PARTIES_INCLUDE,
    });
    if (!ride) throw rideNotFoundError();
    return toRideView(ride, 'driver');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * What the driver takes home from a fare, in whole cents.
 *
 * The commission is rounded and then SUBTRACTED, rather than multiplying the
 * fare by (1 - rate): the two halves then always add back up to the fare
 * exactly, with no half-cent appearing or vanishing between the driver's
 * statement and the platform's ledger. Money is integer cents everywhere, and
 * this is the kind of rounding rule that otherwise gets invented twice.
 */
function driverEarningsCentsFor(fareCents: number | null): number {
  if (fareCents === null || fareCents <= 0) return 0;
  return fareCents - Math.round(fareCents * PLATFORM_COMMISSION_RATE);
}

/** Seconds from now until an ISO instant, floored at zero. */
function secondsUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

/**
 * Where the driver said they were when they pressed the button.
 *
 * Recorded in the event rather than checked against the pickup. A geofence on
 * "arrived" sounds right and is not: GPS in a downtown canyon is routinely 100m
 * out, and refusing a real arrival strands a driver who has done nothing wrong.
 * Keeping the claim is what makes the dispute answerable afterwards, which is
 * what the log is for.
 */
function locationMetadata(location: LatLng | undefined): Prisma.InputJsonValue | null {
  return location ? { lat: location.lat, lng: location.lng } : null;
}
