import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Ride } from '@prisma/client';
import {
  RIDE_TRANSITIONS,
  canTransition,
  type RideEventActor,
  type RideStatus,
} from '@uride/types';
import { RideEventsService, isRideStatus } from './ride-events.service';

// ---------------------------------------------------------------------------
// Typed errors
//
// Every ride failure the API can produce, in one place, so a caller can branch
// on `code` instead of matching on message text. They live in this file rather
// than in RidesService because RidesService depends on this module — putting
// them the other way round would make the two files import each other, and a
// cycle between a service and the errors it throws breaks Nest's DI at boot in
// a way that is thoroughly unpleasant to diagnose.
// ---------------------------------------------------------------------------

export const RIDE_ERRORS = {
  notFound: 'ride_not_found',
  notYours: 'not_your_ride',
  invalidTransition: 'invalid_transition',
  /** Lost a race: the ride moved between the caller's read and its write. */
  statusChanged: 'ride_status_changed',
  notCancellable: 'ride_not_cancellable',
} as const;

export type RideErrorCode = (typeof RIDE_ERRORS)[keyof typeof RIDE_ERRORS];

/** The body shape every ride error carries — `code` is the contract, `message` is for humans. */
export interface RideErrorBody {
  code: RideErrorCode;
  message: string;
}

export const rideNotFoundError = (): NotFoundException =>
  new NotFoundException({ code: RIDE_ERRORS.notFound, message: 'Ride not found.' });

export const notYourRideError = (): ForbiddenException =>
  new ForbiddenException({ code: RIDE_ERRORS.notYours, message: 'Not your ride.' });

/**
 * 409 rather than 400: the request is well formed and the caller is allowed to
 * make it — it is the ride that is in the wrong state, and the client's correct
 * response is to refetch the ride, not to fix its payload.
 */
export const invalidTransitionError = (from: RideStatus, to: RideStatus): ConflictException =>
  new ConflictException({
    code: RIDE_ERRORS.invalidTransition,
    message: `A ride that is ${from} cannot become ${to}.`,
    // The apps render their action buttons from RIDE_TRANSITIONS, so handing
    // back the legal moves lets a client that has drifted resynchronise from
    // the refusal instead of guessing.
    allowed: RIDE_TRANSITIONS[from],
  });

export const rideStatusChangedError = (expected: string, actual: string): ConflictException =>
  new ConflictException({
    code: RIDE_ERRORS.statusChanged,
    message: `This ride is no longer ${expected}; it is now ${actual}.`,
    currentStatus: actual,
  });

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Where every ride starts. Exported so the INSERT in RidesService does not
 * hard-code a status of its own — this file is meant to be the only place in
 * the codebase that names a value for `rides.status`.
 */
export const INITIAL_RIDE_STATUS: RideStatus = 'requested';

/** Statuses that mean the trip ended before it ran, and so stamp `cancelled_by`. */
const CANCELLED_STATUSES: readonly RideStatus[] = ['cancelled_by_rider', 'cancelled_by_driver'];

export interface RideTransitionOptions {
  actorType: RideEventActor;
  /** `users.id` of whoever acted; null for the dispatcher and the sweepers. */
  actorId: string | null;
  /** Event name for the log. Defaults to `ride.<toStatus>`. */
  type?: string;
  metadata?: Prisma.InputJsonObject;
  /**
   * Extra columns to write in the SAME conditional UPDATE — `driverId` and
   * `vehicleId` on accept, `actualDistanceMeters` on completion, and so on.
   * Applied last, so a caller can override a default this service would
   * otherwise set (an admin cancelling on a rider's behalf, for instance).
   */
  extraData?: Omit<Prisma.RideUncheckedUpdateManyInput, 'id' | 'status'>;
}

/**
 * RideStateService — the only place a ride's status changes.
 *
 * Concentrating every write to `rides.status` here is what makes two guarantees
 * checkable rather than aspirational: that no ride ever takes an edge missing
 * from RIDE_TRANSITIONS, and that no status change exists without the
 * ride_events row explaining it. The dispatch loop, the driver trip endpoints,
 * the expiry sweeper and the admin console all funnel through
 * {@link transition}; a second writer anywhere else silently invalidates the
 * Phase 6 replay assertion.
 */
@Injectable()
export class RideStateService {
  private readonly logger = new Logger(RideStateService.name);

  constructor(private readonly events: RideEventsService) {}

  /**
   * Move a ride to `toStatus`, inside the caller's transaction.
   *
   * Three things happen together or not at all: the legality check, the row
   * update with its lifecycle timestamp, and the event that records who did it.
   * The caller owns the transaction because a transition is almost never alone —
   * accepting an offer also settles the offer rows and claims the driver's
   * availability, and a partially applied accept is a double-booked car.
   *
   * Lost-update control is a conditional UPDATE (`WHERE id = ? AND status = ?`)
   * rather than a re-read with SELECT ... FOR UPDATE. Both are correct; the
   * compare-and-set wins on three counts. It is one statement instead of two,
   * on a path the dispatcher runs for every offer response. It holds no row
   * lock across the rest of the caller's transaction, so a slow follow-up write
   * cannot stall every other actor touching that ride. And under Postgres'
   * default READ COMMITTED, a second transaction that blocks on the same row
   * re-evaluates the WHERE clause once the first commits, sees the new status
   * and matches zero rows — so the loser of a race gets a precise 409 naming
   * the status that actually won, instead of a silent overwrite. Note this is
   * the second line of defence for double-assignment, not the first: the
   * `ride_offers_one_accepted_per_ride` partial unique index is what makes two
   * simultaneous accepts impossible at the database level.
   */
  async transition(
    tx: Prisma.TransactionClient,
    ride: Ride,
    toStatus: RideStatus,
    opts: RideTransitionOptions,
  ): Promise<Ride> {
    // `rides.status` is TEXT so the state machine can evolve without a
    // migration, which means a value outside the union is representable. Guard
    // before indexing RIDE_TRANSITIONS: an unknown key would make canTransition
    // throw a TypeError and surface as a 500 on a perfectly ordinary request.
    if (!isRideStatus(ride.status)) {
      this.logger.error(`Ride ${ride.id} holds unknown status "${ride.status}".`);
      throw new ConflictException({
        code: RIDE_ERRORS.invalidTransition,
        message: 'This ride is in a state the server does not recognise.',
      });
    }
    const fromStatus: RideStatus = ride.status;

    if (!canTransition(fromStatus, toStatus)) {
      throw invalidTransitionError(fromStatus, toStatus);
    }

    const now = new Date();
    const data: Prisma.RideUncheckedUpdateManyInput = {
      status: toStatus,
      ...lifecyclePatch(toStatus, now),
      // Who ended it, from the actor rather than from the target status: a
      // support agent cancelling for a rider is `admin`, and the refund path
      // needs to tell that apart from the rider tapping cancel themselves.
      ...(CANCELLED_STATUSES.includes(toStatus) ? { cancelledBy: opts.actorType } : {}),
      ...opts.extraData,
    };

    const changed = await tx.ride.updateMany({ where: { id: ride.id, status: fromStatus }, data });
    if (changed.count !== 1) {
      // updateMany returns a count instead of throwing on no-match, which is
      // exactly why it is used here: the lost race arrives as an ordinary value
      // we can turn into a precise error, rather than as a P2025 that would
      // also be thrown for a ride that does not exist at all.
      const current = await tx.ride.findUnique({
        where: { id: ride.id },
        select: { status: true },
      });
      if (!current) throw rideNotFoundError();
      throw rideStatusChangedError(fromStatus, current.status);
    }

    await this.events.append(tx, {
      rideId: ride.id,
      type: opts.type ?? `ride.${toStatus}`,
      fromStatus,
      toStatus,
      actorType: opts.actorType,
      actorId: opts.actorId,
      metadata: opts.metadata ?? null,
    });

    this.logger.log(
      `Ride ${ride.id} ${fromStatus} -> ${toStatus} ` +
        `by ${opts.actorType}:${opts.actorId ?? 'system'}.`,
    );

    // Re-read rather than trusting a locally patched copy: `updated_at` and any
    // default the database applied are only knowable from the row itself, and
    // every caller hands this object straight to the realtime broadcast. It is
    // a primary-key lookup inside the same transaction, on a page Postgres has
    // just written and therefore has in cache.
    return tx.ride.findUniqueOrThrow({ where: { id: ride.id } });
  }

  /**
   * Record the genesis event for a freshly inserted ride.
   *
   * Creation is not a transition and deliberately does not go through
   * {@link transition}: there is no prior status to move from, and the INSERT
   * has already written `requested`. What it does need is the first row in the
   * log, because replayStatus starts from nothing — without this event a ride
   * would replay as null and every Phase 6 assertion about it would fail.
   */
  async recordRequested(
    tx: Prisma.TransactionClient,
    ride: Ride,
    actorId: string,
    metadata?: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.events.append(tx, {
      rideId: ride.id,
      type: 'ride.requested',
      fromStatus: null,
      toStatus: INITIAL_RIDE_STATUS,
      actorType: 'rider',
      actorId,
      metadata: metadata ?? null,
    });
  }
}

/**
 * The lifecycle timestamp a given status stamps, if any.
 *
 * A switch rather than a lookup table so the statuses that stamp nothing are
 * visible as a decision instead of as an absence: `driver_arriving` is covered
 * by `accepted_at` (the driver is en route from the moment they accept),
 * `no_drivers_found` and the payment states are timestamped by `updated_at`,
 * and nothing needs a column of its own until money moves in Phase 4.
 */
function lifecyclePatch(toStatus: RideStatus, at: Date): Prisma.RideUncheckedUpdateManyInput {
  switch (toStatus) {
    case 'searching':
      return { searchingAt: at };
    case 'accepted':
      return { acceptedAt: at };
    case 'arrived':
      return { arrivedAt: at };
    case 'in_progress':
      return { startedAt: at };
    case 'completed':
      return { completedAt: at };
    case 'cancelled_by_rider':
    case 'cancelled_by_driver':
      return { cancelledAt: at };
    default:
      return {};
  }
}
