import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Ride, type RideOffer as RideOfferRow } from '@prisma/client';
import type {
  DriverId,
  ISODateTime,
  LatLng,
  RideClass,
  RideEventActor,
  RideId,
  RideOffer,
  RideOfferDeclineReason,
  RideOfferStatus,
  RideStatus,
  RtOfferRevokedPayload,
  UUID,
  VehicleId,
} from '@uride/types';
import type { OfferAcceptInput, OfferDeclineInput } from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import { GeoService } from '../geo/geo.service';
import { RouteEstimatorService } from '../pricing/route-estimator.service';
import {
  H3DriverIndexService,
  type IndexedDriverStatus,
  type NearbyIndexedDriver,
} from '../geo/h3-driver-index.service';

// ---------------------------------------------------------------------------
// Ports — the two edges this module is allowed to touch
// ---------------------------------------------------------------------------

/**
 * The ride state machine, as narrow as dispatch needs it.
 *
 * The matcher never writes `rides.status` itself. Every transition goes through
 * the rides module's state service, because that is where the legal-transition
 * table and the `ride_events` append live, and a second writer would be a
 * second — inevitably divergent — implementation of the state machine.
 *
 * Declaring the dependency as a port rather than importing the concrete class
 * keeps this file free of anything rides-specific, which is the constraint
 * ARCHITECTURE.md §8 puts on the module that is meant to become a Go service:
 * the port becomes an RPC call and nothing else in here changes. The binding
 * lives in MatchingModule, where a typed factory proves at compile time that
 * the real service still satisfies this shape.
 *
 * The caller's transaction is a parameter because a transition is never alone
 * on this path: accepting an offer also settles the offer rows and claims the
 * driver's availability, and a partially applied accept is a double-booked car.
 */
export const RIDE_STATE_PORT = Symbol('RIDE_STATE_PORT');

export interface RideStateTransitionOptions {
  actorType: RideEventActor;
  /** `users.id` of whoever acted; null for the dispatcher itself. */
  actorId: string | null;
  /** Event name for the log. Defaults to `ride.<toStatus>`. */
  type?: string;
  metadata?: Prisma.InputJsonObject;
  /** Extra columns written in the SAME conditional UPDATE as the status. */
  extraData?: Omit<Prisma.RideUncheckedUpdateManyInput, 'id' | 'status'>;
}

export interface RideStatePort {
  /**
   * Move a ride, or throw: an illegal edge is a 409, and so is losing a race to
   * another writer. Returns the row as it is after the change.
   */
  transition(
    tx: Prisma.TransactionClient,
    ride: Ride,
    toStatus: RideStatus,
    opts: RideStateTransitionOptions,
  ): Promise<Ride>;
}

/**
 * Outbound realtime, as Redis pub/sub rather than an injected gateway.
 *
 * The realtime module's boundary contract is "Redis pub/sub, no domain
 * modules", and ARCHITECTURE.md §8 names "publish state changes onto a pub/sub
 * channel that the WS gateway forwards" as the post-extraction output shape.
 * Publishing here means a Go rewrite emits the same JSON on the same channels
 * and the gateway never learns the difference — whereas injecting the gateway
 * would bake a Nest provider into the one module that is supposed to leave.
 */
export const DISPATCH_CHANNELS = {
  /** A new offer for one driver. The gateway forwards it as `offer:new`. */
  offerNew: 'uride:dispatch:offer.new',
  /** An offer stopped being answerable. Forwarded as `offer:revoked`. */
  offerRevoked: 'uride:dispatch:offer.revoked',
} as const;

/**
 * The ride detail an offer card renders.
 *
 * Field names mirror `RideOfferForDriver` so the driver-facing layer completes
 * that contract by adding `driverEarningsCents` — the one field dispatch cannot
 * supply, because commission is the payments module's number and it does not
 * exist until Phase 4.
 */
export interface DispatchOfferRide {
  rideId: RideId;
  rideClass: RideClass;
  pickup: LatLng;
  pickupAddress: string;
  dropoff: LatLng;
  dropoffAddress: string;
  tripDistanceMeters: number;
  tripDurationSeconds: number;
  fareCents: number | null;
}

export interface DispatchOfferEvent {
  /** Who to deliver to. The gateway routes on this; the payload is not broadcast. */
  driverId: DriverId;
  offer: RideOffer;
  ride: DispatchOfferRide;
  /** Countdown computed server-side, so a slow or lying device cannot extend it. */
  secondsRemaining: number;
}

/**
 * `RtOfferRevokedPayload` plus the recipient. The wire contract deliberately
 * omits `driverId` — the driver app knows who it is — but the gateway needs it
 * to pick the socket.
 */
export interface DispatchOfferRevokedEvent extends RtOfferRevokedPayload {
  driverId: DriverId;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * What one wave did.
 *
 * - `offered`   — offers are out; the ride is waiting on drivers to answer.
 * - `waiting`   — nothing to do: offers from an earlier wave are still live, or
 *                 this wave found nobody and the ladder widens on the next tick.
 * - `exhausted` — the ladder ran out; the ride is now `no_drivers_found`.
 * - `skipped`   — the ride is not dispatchable (cancelled, already matched), or
 *                 another instance holds the wave lock.
 */
export type DispatchDecision = 'offered' | 'waiting' | 'exhausted' | 'skipped';

export interface DispatchOutcome {
  rideId: RideId;
  /** The wave that ran, or the ride's current round when nothing ran. */
  round: number;
  offersCreated: number;
  decision: DispatchDecision;
}

/** What the driver's app needs the moment they win a ride. */
export interface OfferAcceptance {
  offer: RideOffer;
  rideId: RideId;
  driverId: DriverId;
  vehicleId: VehicleId;
  pickup: LatLng;
  pickupAddress: string;
  /** Straight-line metres from where the driver was when they tapped accept. */
  pickupDistanceMeters: number;
  pickupEtaSeconds: number;
}

// ---------------------------------------------------------------------------
// Tuning that is not an operator knob
// ---------------------------------------------------------------------------

/**
 * Straight-line metres → road metres.
 *
 * Every distance in the platform is geodesic until MAPS_PROVIDER stops being
 * `none` (a routing API is the first billable dependency — see RUNBOOK §cost).
 * A flat 1.3 is the usual urban detour ratio: enough to keep a quoted ETA
 * honest, without pretending we routed anything.
 */
const ROAD_DETOUR_FACTOR = 1.3;

/**
 * How many candidates get routed when re-ranking a shortlist.
 *
 * The matrix bills per origin, so this is the per-round cost ceiling. Eight is
 * comfortably more than DISPATCH_CANDIDATES_PER_ROUND, which is what gives the
 * ranking something to choose between, while keeping a wave's spend flat no
 * matter how dense the neighbourhood is.
 */
const ROAD_RANKING_MAX_ORIGINS = 8;

/** Nobody is ever 20 seconds away once finding the car and the door are counted. */
const MIN_ETA_SECONDS = 60;

/**
 * Ask the index for more drivers than a wave needs, and grow the ask by the
 * same factor when the filters eat the pool.
 *
 * Every filter runs after the spatial search — the index knows where drivers
 * are, not whether they may take this ride — so without headroom a wave
 * downtown would come back short simply because the nearest handful were all
 * holding somebody else's offer, or drive the wrong class of car.
 */
const CANDIDATE_OVERFETCH = 4;

/**
 * Most drivers one wave will pull from the index and put to the eligibility
 * query. Only reached by a dense area whose nearest drivers are mostly
 * ineligible (an XL request in a sea of standard cars); past it the wave offers
 * what it found and the next round tries again, rather than walking hundreds of
 * hashes to fill three slots.
 */
const CANDIDATE_POOL_CEILING = 200;

/** A wave is a handful of queries; ten seconds is a crash guard, not a work budget. */
const RIDE_LOCK_TTL_SECONDS = 10;

const RIDE_LOCK_PREFIX = 'uride:dispatch:ride:';

/** Release only our own lock — a lock that outlived its holder belongs to someone else now. */
const RELEASE_IF_OWNED = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/** The statuses a ride can be dispatched from. */
const DISPATCHABLE: readonly string[] = ['requested', 'searching'];

/** Raw row shapes — snake_case, straight from Postgres. */
interface DriverIdRow {
  driver_id: string;
}

interface RideIdRow {
  id: string;
}

interface EligibleDriverRow {
  driver_id: string;
  rating_avg: number | null;
}

/** What Postgres adds to an index hit once it has cleared the driver. */
interface EligibleDriver {
  ratingAvg: number | null;
}

/** Where one wave looks, and how far away it will accept. */
interface WaveSearch {
  /** gridDisk radius around the pickup's H3 cell. */
  rings: number;
  /** Hard ceiling on a candidate's straight-line distance from the pickup. */
  capMeters: number;
}

/** A driver a wave has decided to offer, with what the ranking and the offer row need. */
interface DispatchCandidate {
  driverId: string;
  /** Straight-line metres at selection; replaced by road metres once ranked. */
  distanceMeters: number;
  ratingAvg: number | null;
  /** Where the driver was when the pool was built — the matrix origin. */
  lat: number;
  lng: number;
  /** Routed seconds to the pickup. Absent when road ranking did not run. */
  roadEtaSeconds?: number;
}

interface RetiredOfferRow {
  id: string;
  ride_id: string;
  driver_id: string;
}

/** Outcome of trying to take the per-ride wave lock. */
interface RideLock {
  /** Non-null when we hold it; the token proves ownership at release time. */
  token: string | null;
  /** True when somebody else is mid-wave for this ride and we must stand down. */
  contended: boolean;
}

/**
 * MatchingService — the dispatch engine.
 *
 * Three jobs: choose who gets offered a ride, decide who won when two drivers
 * tap accept in the same millisecond, and retire offers nobody answered.
 *
 * Two decisions carry the whole module.
 *
 * **The database decides the winner.** `ride_offers_one_accepted_per_ride` is a
 * partial UNIQUE index, so whichever accept commits second raises a unique
 * violation no matter how the requests interleave or how many API instances are
 * running. An application-level lock is an optimisation on top of that, never
 * the control itself: locks expire mid-transaction, get released early by a
 * retry, and vanish with the Redis process. Double-assigning means two riders
 * in one car, and that guarantee has to come from the only component that can
 * actually serialise the write.
 *
 * **A wave offers several drivers at once.** ARCHITECTURE.md sketched one
 * candidate at a time behind a per-driver lock, which minimises drivers
 * interrupted but multiplies the rider's wait by the offer TTL for every driver
 * who leaves their phone face-down. Offering the best N simultaneously trades a
 * few unnecessary buzzes for a match in one TTL instead of N — and the unique
 * index is what makes a race we deliberately create safe to have.
 *
 * Everything outside those jobs belongs to somebody else: `rides.status` and
 * `ride_events` to the rides state service, socket delivery to the gateway,
 * push to notifications. That is not tidiness — it is the condition for the Go
 * extraction in ARCHITECTURE.md §8 being a port rather than a rewrite.
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  private readonly offerTtlSeconds: number;
  private readonly maxRounds: number;
  private readonly candidatesPerRound: number;
  private readonly ringLadder: readonly number[];
  private readonly radiusLadder: readonly number[];
  private readonly averageSpeedMps: number;
  private readonly locationStaleSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly index: H3DriverIndexService,
    private readonly redis: RedisService,
    private readonly routes: RouteEstimatorService,
    @Inject(RIDE_STATE_PORT) private readonly rideState: RideStatePort,
  ) {
    const env = loadEnv();
    this.offerTtlSeconds = env.DISPATCH_OFFER_TTL_SECONDS;
    this.maxRounds = env.DISPATCH_MAX_ROUNDS;
    this.candidatesPerRound = env.DISPATCH_CANDIDATES_PER_ROUND;
    this.ringLadder = env.DISPATCH_RING_LADDER;
    this.radiusLadder = env.DISPATCH_RADIUS_LADDER_METERS;
    this.averageSpeedMps = (env.DISPATCH_AVERAGE_SPEED_KMH * 1000) / 3600;
    this.locationStaleSeconds = env.DRIVER_LOCATION_STALE_SECONDS;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Run one dispatch wave for a ride.
   *
   * Idempotent and safe to call from anywhere — the worker's tick, the rides
   * module right after a request, a decline that freed the last candidate, an
   * ops "try again". A ride that is already matched, cancelled or mid-wave
   * comes back `skipped` rather than raising: dispatch is a background loop,
   * and a loop that throws when a rider cancels is a loop that fills the error
   * budget with ordinary behaviour.
   */
  async dispatch(rideId: string): Promise<DispatchOutcome> {
    const ride = await this.prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException({ code: 'ride_not_found', message: 'Ride not found.' });
    }
    if (!DISPATCHABLE.includes(ride.status)) {
      return this.outcome(ride.id, ride.dispatchRound, 0, 'skipped');
    }

    // Serialise waves per ride so two instances — or a worker tick racing a
    // decline nudge — cannot each open a round and put six drivers in front of
    // one rider. Correctness does not depend on this: the outstanding-offer
    // check below and the unique indexes absorb a duplicate wave. That is why a
    // lock that cannot be taken degrades dispatch quality instead of stopping
    // it. (A Redis that is down outright does stop the wave, one step later, at
    // the candidate search — and there is deliberately no PostGIS fallback
    // behind it: pings are written to Redis, so during that outage
    // `last_location` stops moving too, and within one staleness window a
    // fallback would find nobody while looking as if it worked.)
    const lock = await this.acquireRideLock(ride.id);
    if (lock.contended) {
      return this.outcome(ride.id, ride.dispatchRound, 0, 'skipped');
    }
    try {
      return await this.runWave(ride);
    } finally {
      await this.releaseRideLock(ride.id, lock.token);
    }
  }

  /** Rides still looking for a driver with nothing outstanding. The worker's queue. */
  async rideIdsAwaitingDispatch(limit: number): Promise<string[]> {
    // The status list is inlined rather than bound, for the reason GeoService
    // inlines `status = 'online'`: `rides_awaiting_dispatch_idx` is a partial
    // index, and the planner can only prove a query qualifies for it when the
    // predicate is constant at plan time. A bound parameter yields a generic
    // plan that scans every ride the platform has ever taken.
    const rows = await this.prisma.$queryRaw<RideIdRow[]>`
      SELECT r."id"
        FROM "rides" r
       WHERE r."status" IN ('requested', 'searching')
         AND NOT EXISTS (
           SELECT 1
             FROM "ride_offers" o
            WHERE o."ride_id" = r."id"
              AND o."status" = 'pending'
         )
       ORDER BY r."requested_at" ASC
       LIMIT ${limit}::int
    `;
    return rows.map((r) => r.id);
  }

  /**
   * One wave: widen the rings, rank what is out there, offer the best N.
   *
   * The ride row was read before the lock was taken, so its status may be one
   * transition stale. That is fine — the state port compare-and-sets on the
   * status we read, and every other write below is conditional too.
   */
  private async runWave(ride: Ride): Promise<DispatchOutcome> {
    // One read answers both pacing questions. A wave only ever opens when
    // nothing is pending, so every offer that could still be outstanding
    // belongs to the ride's current round — which is also the round whose
    // emptiness decides whether the next wave may start yet.
    const currentRound =
      ride.dispatchRound === 0
        ? []
        : await this.prisma.rideOffer.findMany({
            where: { rideId: ride.id, round: ride.dispatchRound },
            select: { status: true },
          });

    // Offers from the current wave are still out. Stacking a second wave would
    // put two cards in front of one driver and burn the ladder while drivers
    // are still deciding.
    if (currentRound.some((offer) => offer.status === 'pending')) {
      return this.outcome(ride.id, ride.dispatchRound, 0, 'waiting');
    }

    // A round that offered nobody has to be paced by hand. Rounds that made
    // offers are paced by the offer TTL — the next wave cannot start until
    // those expire — but a round with no candidates finishes instantly, so at a
    // 2-second tick the whole ladder would elapse in six seconds and the rider
    // would be told "no drivers available" before a driver could plausibly have
    // come online or sent a fresh ping. Holding each empty round for one offer
    // TTL makes the search take about as long as a search that found people.
    //
    // `updated_at` stands in for "when this round opened": while a ride is
    // requested or searching, this loop is the only thing that writes the row.
    if (
      ride.dispatchRound > 0 &&
      currentRound.length === 0 &&
      Date.now() - ride.updatedAt.getTime() < this.offerTtlSeconds * 1000
    ) {
      return this.outcome(ride.id, ride.dispatchRound, 0, 'waiting');
    }

    const round = ride.dispatchRound + 1;
    if (round > this.maxRounds) {
      const closed = await this.giveUp(ride);
      return this.outcome(ride.id, ride.dispatchRound, 0, closed ? 'exhausted' : 'skipped');
    }

    const search = this.searchForRound(round);
    const candidates = await this.selectCandidates(ride, search);
    const expiresAt = new Date(Date.now() + this.offerTtlSeconds * 1000);

    const opened = await this.openRound(ride, round, search, candidates, expiresAt);
    if (!opened) {
      // The ride moved between the read and the wave — the rider cancelled, or
      // an offer from a wave we thought was finished landed. Ordinary in a loop
      // that reads before it writes, so it is a skip and not an incident.
      return this.outcome(ride.id, ride.dispatchRound, 0, 'skipped');
    }

    if (candidates.length === 0) {
      // Burning the round is the point: the next tick searches the wider ring
      // instead of re-asking the same empty handful of hexagons forever.
      this.logger.debug(
        `Ride ${ride.id} round ${round}: no eligible driver within ${describeSearch(search)}.`,
      );
      return this.outcome(ride.id, round, 0, 'waiting');
    }

    // Read back rather than trusting the candidate list: ON CONFLICT DO NOTHING
    // drops rows silently, and telling a driver about an offer that does not
    // exist is how you get an accept that 404s.
    const created = await this.prisma.rideOffer.findMany({
      where: { rideId: ride.id, round, status: 'pending' },
    });
    for (const row of created) {
      await this.publishOffer(ride, row);
    }

    this.logger.log(
      `Ride ${ride.id} round ${round}: offered to ${created.length} driver(s) ` +
        `within ${describeSearch(search)} for ${this.offerTtlSeconds}s.`,
    );
    return this.outcome(
      ride.id,
      round,
      created.length,
      created.length > 0 ? 'offered' : 'waiting',
    );
  }

  /**
   * Open one round: record it on the ride and write the offers, atomically.
   *
   * False means the ride was no longer where we left it and nothing was
   * written. The state service reports that as a conflict, which is the right
   * answer to a driver whose tap lost a race and the wrong one to raise at a
   * background loop — so it is translated to a skip here, at the one place that
   * knows the caller is the dispatcher.
   */
  private async openRound(
    ride: Ride,
    round: number,
    search: WaveSearch,
    candidates: readonly DispatchCandidate[],
    expiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        if (ride.status === 'requested') {
          // First wave: `requested` → `searching`, so the rider's app stops
          // saying "requesting" and starts saying "finding you a driver". The
          // round rides along in the same conditional UPDATE — one statement,
          // and a ride can never be `searching` at round 0.
          await this.rideState.transition(tx, ride, 'searching', {
            actorType: 'system',
            actorId: null,
            metadata: {
              round,
              rings: search.rings,
              radiusMeters: search.capMeters,
              candidates: candidates.length,
            },
            extraData: { dispatchRound: round },
          });
        } else {
          // Later waves are not transitions — the ride is already `searching` —
          // so there is no event to append. The offer rows carry `round` and
          // `distance_meters`, which is what answers "why was a driver 9 km
          // away asked about this ride" months later.
          await tx.ride.update({ where: { id: ride.id }, data: { dispatchRound: round } });
        }

        if (candidates.length > 0) {
          // skipDuplicates compiles to ON CONFLICT DO NOTHING, which covers ANY
          // unique index — including `ride_offers_one_pending_per_driver`. Two
          // rides dispatching to the same driver in the same instant is a real
          // race, and without this the entire wave would roll back because one
          // candidate was claimed elsewhere a millisecond earlier.
          await tx.rideOffer.createMany({
            skipDuplicates: true,
            data: candidates.map((candidate) => ({
              rideId: ride.id,
              driverId: candidate.driverId,
              round,
              status: 'pending',
              distanceMeters: candidate.distanceMeters,
              // Routed seconds when road ranking produced them, the
              // detour-factor estimate otherwise.
              etaSeconds:
                candidate.roadEtaSeconds ?? this.etaSecondsFor(candidate.distanceMeters),
              expiresAt,
            })),
          });
        }
      });
      return true;
    } catch (error) {
      // A 409 from the state service means the compare-and-set matched nothing:
      // the ride is no longer the status we read. Anything else is a real
      // failure and belongs in the worker's error log.
      if (error instanceof ConflictException) {
        this.logger.debug(
          `Ride ${ride.id} moved during round ${round}; wave abandoned: ${describeError(error)}`,
        );
        return false;
      }
      throw error;
    }
  }

  /**
   * Tell the rider nobody is coming.
   *
   * A spinner that never resolves is worse than a no: the rider cannot re-book
   * while the platform is still pretending to look, and every minute spent
   * pretending is a minute they could have spent walking to a taxi.
   *
   * False means the ride was already somewhere else — cancelled a moment ago,
   * most likely — which is a no-op, not a failure.
   */
  private async giveUp(ride: Ride): Promise<boolean> {
    const widest = this.searchForRound(this.maxRounds);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.rideState.transition(tx, ride, 'no_drivers_found', {
          actorType: 'system',
          actorId: null,
          metadata: {
            rounds: ride.dispatchRound,
            widestRings: widest.rings,
            widestRadiusMeters: widest.capMeters,
          },
        });
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.debug(`Ride ${ride.id} moved before it could be given up.`);
        return false;
      }
      throw error;
    }
    this.logger.log(
      `Ride ${ride.id} found no driver after ${ride.dispatchRound} round(s); ` +
        `widest search ${describeSearch(widest)}.`,
    );
    return true;
  }

  /**
   * Rank who should be asked, and rule out who must not be.
   *
   * WHERE. The search reads the live H3 index in Redis, not PostGIS: the
   * pickup's hexagon, then gridDisk rings out to this round's entry in
   * DISPATCH_RING_LADDER. That used to be an ST_DWithin per wave, which is what
   * made every GPS frame a Postgres write — the query needed something current
   * to read. Widening rings replace the widening radius, and the radius ladder
   * stays on as a hard cap on distance. Rings are not circles — ring k reaches
   * noticeably further at its corners than across its edges — and whoever
   * widens DISPATCH_RING_LADDER must not also, silently, widen how far away an
   * offered driver may be. Distance is what the rider waits on; rings are only
   * how the index is read.
   *
   * WHO. The index knows position and status; it does not know whether a driver
   * may take THIS ride. KYC approval, an approved active vehicle and its ride
   * class live in Postgres, so the hits go to {@link eligibleDrivers} as ONE
   * query over their ids. See that method for why it is a query and not a
   * cached set.
   *
   * Five exclusions:
   *
   *  - Drivers mid-trip never appear: the index is asked for `online` entries
   *    only, and the eligibility query re-reads `status = 'online'` from
   *    Postgres, so an entry that missed a status change still cannot draw an
   *    offer. Acceptance moves the winner to `on_trip` in both.
   *  - Ineligible drivers — unapproved, suspended, no approved active car, or a
   *    car of the wrong class — are dropped by the same query.
   *  - Drivers holding a pending offer anywhere are skipped, because
   *    `ride_offers_one_pending_per_driver` would reject the insert anyway and
   *    a rejected insert wastes one of a wave's few slots.
   *  - Drivers who declined or ignored THIS ride in an earlier round are gone
   *    for good. Re-offering a ride somebody already refused is the fastest way
   *    to teach drivers to ignore the app.
   *  - The rider themselves, when they also drive. Rare, but it happens on a
   *    small fleet, and dispatching someone to collect themselves is the kind
   *    of bug that ends up in a screenshot.
   *
   * Every filter runs after the spatial search, so a pool the filters ate is
   * searched again with a larger limit — but only while the index could still
   * be holding someone: it returned a full pool, and the farthest of them is
   * still inside the cap. The index returns the nearest `limit` drivers, so
   * once either stops being true a bigger ask would find nobody new in range.
   * Drivers already cleared or refused are not put to Postgres twice.
   *
   * Ranking is distance, tie-broken by rating. Acceptance-rate weighting needs
   * data this table only starts collecting today, and distance is what the
   * rider actually feels. Distance is the index's haversine from the live
   * position, which differs from the spheroid PostGIS used by well under a
   * percent at city scale — noise beside GPS error.
   */
  /**
   * Re-rank a shortlist by real road time, then take the top `wanted`.
   *
   * Straight-line is the right question for building the POOL — a radius is
   * cheap and indexed, and every driver in it is plausibly close. It is the
   * wrong question for choosing WHO TO ASK.
   *
   * The river case: a driver 5 km away across the water is 10 km by road, while
   * one 6 km away beside the bridge is 7 km. Sorted on straight line, the first
   * driver wins the slice, the second is never asked, the rider waits longer
   * and the winner drives a long dead leg. Sorted on road time, the bridge
   * driver gets the offer — which is simply the correct answer.
   *
   * It runs whenever there is anybody to ask — NOT only when the shortlist is
   * long enough for the order to change hands. An earlier version skipped the
   * call in that case, reasoning that ranking cannot change who is asked when
   * everyone is asked anyway. That saved calls and produced wrong numbers: the
   * ETA and distance on the offer are what a driver reads before accepting, and
   * on the straight-line estimate the far-bank driver is told "4 minutes" for a
   * ten-kilometre drive around the water. A driver deciding on a false number
   * is worse than an extra matrix element.
   *
   * Cost is bounded two ways, because this runs per dispatch round:
   *  - At most ROAD_RANKING_MAX_ORIGINS origins, in ONE batched matrix call,
   *    so a dense neighbourhood costs exactly what a sparse one does.
   *  - Skipped when no routing provider is configured, where the matrix would
   *    return the straight-line arithmetic the caller already has.
   *
   * Never throws. Any origin that fails to route keeps its detour estimate, so
   * the worst case is the ordering dispatch used before this existed.
   */
  private async rankByRoad(
    candidates: DispatchCandidate[],
    ride: Ride,
    wanted: number,
  ): Promise<DispatchCandidate[]> {
    if (candidates.length === 0) return candidates;

    const shortlist = candidates.slice(0, ROAD_RANKING_MAX_ORIGINS);
    const pickup = { lat: ride.pickupLat, lng: ride.pickupLng };

    let legs;
    try {
      legs = await this.routes.estimateMatrix(
        shortlist.map((c) => ({ lat: c.lat, lng: c.lng })),
        pickup,
      );
    } catch (error) {
      this.logger.warn(
        `Road ranking failed for ride ${ride.id}; using straight-line order: ${describeError(error)}`,
      );
      return candidates.slice(0, wanted);
    }

    const ranked = shortlist
      .map((candidate, i) => ({ candidate, leg: legs[i] }))
      .sort((a, b) => {
        const byTime = (a.leg?.durationSeconds ?? Infinity) - (b.leg?.durationSeconds ?? Infinity);
        if (byTime !== 0) return byTime;
        return (b.candidate.ratingAvg ?? 0) - (a.candidate.ratingAvg ?? 0);
      });

    const routedCount = legs.filter((l) => l.routed).length;
    if (routedCount > 0) {
      this.logger.debug(
        `Ride ${ride.id}: ranked ${shortlist.length} candidates on road time ` +
          `(${routedCount} routed).`,
      );
    }

    // Carry the road numbers onto the offer so the driver is told the distance
    // they will actually drive, and so "why was this driver asked" is
    // answerable from the row months later.
    return ranked.slice(0, wanted).map(({ candidate, leg }) =>
      leg && leg.routed
        ? { ...candidate, distanceMeters: leg.distanceMeters, roadEtaSeconds: leg.durationSeconds }
        : candidate,
    );
  }

  private async selectCandidates(ride: Ride, search: WaveSearch): Promise<DispatchCandidate[]> {
    const wanted = this.candidatesPerRound;
    const cleared = new Map<string, EligibleDriver>();
    const asked = new Set<string>();
    let excluded: ReadonlySet<string> | undefined;
    let limit = Math.min(CANDIDATE_POOL_CEILING, wanted * CANDIDATE_OVERFETCH);

    for (;;) {
      const pool = await this.index.searchNearby({
        lat: ride.pickupLat,
        lng: ride.pickupLng,
        maxRings: search.rings,
        limit,
        maxAgeMs: this.locationStaleSeconds * 1000,
        status: 'online',
      });
      const inRange = pool.filter(
        (driver) => driver.distanceMeters <= search.capMeters && driver.driverId !== ride.riderId,
      );

      let candidates: DispatchCandidate[] = [];
      if (inRange.length > 0) {
        // Fetched once per wave, and only when there is somebody to filter: a
        // wave into an empty neighbourhood costs Redis and nothing else.
        const skip = (excluded ??= await this.excludedDrivers(ride.id));
        const unasked = inRange
          .map((driver) => driver.driverId)
          .filter((id) => !skip.has(id) && !asked.has(id));
        if (unasked.length > 0) {
          const verdicts = await this.eligibleDrivers(unasked, ride.rideClass);
          for (const id of unasked) {
            asked.add(id);
            const eligible = verdicts.get(id);
            if (eligible) cleared.set(id, eligible);
          }
        }
        candidates = rankCandidates(inRange, skip, cleared);
      }

      const farthest = pool[pool.length - 1];
      const mayHoldMore =
        pool.length >= limit && farthest !== undefined && farthest.distanceMeters <= search.capMeters;
      if (candidates.length >= wanted || !mayHoldMore || limit >= CANDIDATE_POOL_CEILING) {
        return this.rankByRoad(candidates, ride, wanted);
      }
      limit = Math.min(CANDIDATE_POOL_CEILING, limit * CANDIDATE_OVERFETCH);
    }
  }

  /**
   * Which of these drivers may take a ride of this class, right now — one
   * query for the whole candidate set.
   *
   * Why a query per wave rather than a short-TTL cached set of eligible ids:
   *
   *  - Eligibility changes rarely, but the changes are the ones that matter
   *    most. A suspension after a safety report, or a replaced insurance
   *    certificate sending KYC back to review, has to stop offers on the next
   *    wave. A TTL cache would keep offering that driver rides for the length
   *    of the TTL, and invalidating it properly would mean the admin desk, the
   *    document review and the driver's own profile edits all learning about a
   *    dispatch cache — three modules outside this one, and a Go extraction
   *    that inherits a shared-cache contract.
   *  - Its cost follows demand, not fleet size. It reads the few dozen drivers
   *    around one pickup by primary key, once per wave, and waves run at most
   *    DISPATCH_BATCH_SIZE per tick. A cached set would have to hold the whole
   *    eligible fleet and be rebuilt by a join over every driver on a timer,
   *    whether or not anybody is requesting a ride.
   *  - The load problem this rewrite fixes was never the waves. It was a
   *    Postgres transaction per GPS frame; that is gone, and one indexed read
   *    per wave is not what brings a pooler down.
   *
   * `ANY` over one array parameter rather than an IN-list of placeholders: the
   * SQL text is identical for three candidates or two hundred, so it is one
   * statement to Prisma's query cache and to pg_stat_statements rather than a
   * new one for every pool size a wave happens to find.
   *
   * The `status = 'online'` re-check is not redundant with asking the index for
   * `online` drivers. The index is a cache of this row; the heartbeat sweeper,
   * the admin desk and a KYC re-review all take drivers offline in Postgres, and
   * until the flush worker reconciles the entry this predicate is what keeps
   * them from being offered a ride. `suspended_at` is checked as well as
   * `kyc_status`, matching the rule go-online is gated on.
   */
  private async eligibleDrivers(
    driverIds: readonly string[],
    rideClass: string,
  ): Promise<Map<string, EligibleDriver>> {
    const rows = await this.prisma.$queryRaw<EligibleDriverRow[]>`
      SELECT
        a."driver_id",
        -- Cast to double precision so Prisma hands back a number; a numeric
        -- would arrive as a Decimal object.
        CASE WHEN p."rating_count" > 0
          THEN ROUND(p."rating_sum"::numeric / p."rating_count", 2)::double precision
        END AS "rating_avg"
      FROM "driver_availability" a
      JOIN "vehicles" v
        ON v."id" = a."vehicle_id"
       AND v."driver_id" = a."driver_id"
       AND v."status" = 'approved'
       AND v."is_active"
      JOIN "driver_profiles" p
        ON p."user_id" = a."driver_id"
       AND p."kyc_status" = 'approved'
       AND p."suspended_at" IS NULL
      WHERE a."driver_id" = ANY(${[...driverIds]}::uuid[])
        AND a."status" = 'online'
        AND v."ride_class" = ${rideClass}::text
    `;
    return new Map(
      rows.map((row): [string, EligibleDriver] => [row.driver_id, { ratingAvg: row.rating_avg }]),
    );
  }

  /**
   * Drivers this wave may not touch.
   *
   * A UNION of two index-friendly branches rather than one OR: `WHERE status =
   * 'pending' OR (ride_id = $1 AND status IN (...))` can use neither partial
   * index and degrades into a scan of every offer ever made, while each branch
   * on its own is an index lookup.
   *
   * Expired-but-unswept offers still count as `pending` here. They hold the
   * one-pending-per-driver index until the worker retires them, so treating
   * them as free would only buy a failed insert a moment later.
   *
   * `revoked` is deliberately absent: the platform withdrew those offers — the
   * rider cancelled, or another driver won — the driver refused nothing, and
   * holding it against them would blacklist the drivers who answer fastest.
   */
  private async excludedDrivers(rideId: string): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<DriverIdRow[]>`
      SELECT "driver_id" FROM "ride_offers" WHERE "status" = 'pending'
      UNION
      SELECT "driver_id" FROM "ride_offers"
       WHERE "ride_id" = ${rideId}::uuid
         AND "status" IN ('declined', 'expired')
    `;
    return new Set(rows.map((r) => r.driver_id));
  }

  // -------------------------------------------------------------------------
  // Driver responses
  // -------------------------------------------------------------------------

  /**
   * A driver takes the ride. The one path in the platform where two clients
   * race for the same row.
   *
   * The race is settled by `ride_offers_one_accepted_per_ride`, a partial
   * UNIQUE index: the transaction that commits second raises SQLSTATE 23505,
   * Prisma surfaces it as P2002, and {@link asOfferConflict} turns it into a
   * clean 409 `offer_already_taken` instead of the 500 an uncaught unique
   * violation would be. That index is deliberately the ONLY thing standing
   * between two drivers and one rider: application-level locking cannot make
   * that promise — a lock can expire mid-transaction, be released by a retry,
   * or disappear with the Redis process — and "two riders in one car" is not a
   * failure mode to stake on a cache.
   *
   * One transaction, offer row first so a loser aborts before touching anything
   * else: claim the offer, assign the ride through the state port, take the
   * driver out of the dispatch pool, revoke what the other candidates are still
   * looking at. The live index hears about it only once that has committed.
   */
  async acceptOffer(
    driverId: string,
    offerId: string,
    input: OfferAcceptInput,
  ): Promise<OfferAcceptance> {
    const offer = await this.prisma.rideOffer.findUnique({
      where: { id: offerId },
      include: { ride: true },
    });
    if (!offer) {
      throw new NotFoundException({ code: 'offer_not_found', message: 'That offer is gone.' });
    }
    if (offer.driverId !== driverId) {
      throw new ForbiddenException({
        code: 'not_your_offer',
        message: 'That offer was made to another driver.',
      });
    }
    const ride = offer.ride;

    // A retry of the accept this driver already won must not 409 them out of
    // their own trip. Mobile networks drop responses and the app retries.
    //
    // The index is deliberately not touched here. This branch never checks
    // that the trip is still live, and a retry landing after the trip has
    // ended would put a driver back in the pool into `on_trip`. If the first
    // accept's index write was the thing that failed, the flush worker's
    // reconcile repairs it.
    if (offer.status === 'accepted' && ride.driverId === driverId && ride.vehicleId) {
      return this.acceptanceOf(offer, ride, ride.vehicleId, offer.distanceMeters, offer.etaSeconds);
    }
    if (offer.status !== 'pending') {
      throw new ConflictException({
        code: 'offer_already_taken',
        message: 'This ride is no longer available.',
      });
    }
    if (offer.expiresAt.getTime() <= Date.now()) {
      // Retire it here instead of leaving it to the sweeper: this is the one
      // pending offer the driver is allowed to hold, and leaving it in place
      // keeps them out of the next wave for no reason.
      await this.expireOffer(offerId).catch(() => undefined);
      throw new ConflictException({ code: 'offer_expired', message: 'That offer timed out.' });
    }
    if (!DISPATCHABLE.includes(ride.status)) {
      throw new ConflictException({
        code: 'ride_no_longer_available',
        message: 'This ride is no longer available.',
      });
    }

    // The vehicle comes from the availability row, never from the request: it
    // is the car the driver was approved to go online in, and accept time is
    // not an opportunity to swap in an unapproved one.
    const availability = await this.prisma.driverAvailability.findUnique({
      where: { driverId },
      select: { status: true, vehicleId: true },
    });
    if (availability?.status === 'on_trip') {
      throw new ConflictException({
        code: 'driver_on_trip',
        message: 'Finish your current trip before accepting another.',
      });
    }
    if (!availability || availability.status !== 'online' || !availability.vehicleId) {
      throw new ConflictException({
        code: 'driver_not_online',
        message: 'Go online before accepting a ride.',
      });
    }
    const vehicleId = availability.vehicleId;

    // Recompute from where the driver is NOW. The offer's estimate was made
    // when the wave ran, up to a full TTL ago, and "4 minutes away" should
    // describe the car that is actually coming. Deliberately before the
    // transaction: this is a round trip to PostGIS, and holding row locks
    // across it would serialise every accept in the city.
    const pickup: LatLng = { lat: ride.pickupLat, lng: ride.pickupLng };
    const pickupDistanceMeters = input.location
      ? await this.geo.distanceMeters(input.location, pickup)
      : offer.distanceMeters;

    // The ETA the rider is shown, and the only place in dispatch worth a real
    // route. Candidate SELECTION stays straight-line — a radius is the right
    // question when choosing whom to ask, and routing every candidate of every
    // round would multiply the bill by the whole funnel. But once a driver has
    // accepted, "4 minutes away" is a promise, and a straight line is a bad
    // basis for one: a driver 5 km across a river can be 12 km by road, so the
    // rider is told 5 minutes and waits 15.
    //
    // One route per accepted ride, and the estimator's ~100 m cache usually
    // makes even that free. It never throws and degrades to the same
    // detour-factor arithmetic this used to do, so a routing outage costs
    // accuracy, never an acceptance.
    const pickupEtaSeconds = input.location
      ? (await this.routes.estimate(input.location, pickup)).durationSeconds
      : this.etaSecondsFor(pickupDistanceMeters);

    let losers: { id: string; driverId: string }[] = [];
    try {
      losers = await this.prisma.$transaction(async (tx) => {
        // Offer first. The status guard makes this a conditional claim, so a
        // driver whose offer was concurrently expired or revoked updates
        // nothing; the unique index is what catches another driver winning the
        // RIDE while this transaction is open.
        const claimed = await tx.rideOffer.updateMany({
          where: { id: offerId, status: 'pending' },
          data: { status: 'accepted', respondedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ConflictException({
            code: 'offer_already_taken',
            message: 'This ride is no longer available.',
          });
        }

        await this.rideState.transition(tx, ride, 'accepted', {
          actorType: 'driver',
          actorId: driverId,
          metadata: {
            offerId,
            round: offer.round,
            etaSeconds: pickupEtaSeconds,
            distanceMeters: pickupDistanceMeters,
          },
          extraData: { driverId, vehicleId },
        });

        // `on_trip` + `current_ride_id` is what removes the driver from every
        // future wave, and the trip-consistency CHECK on the table refuses one
        // without the other. Guarded on `online` so a driver who went offline
        // between the read above and here loses the race rather than being
        // dragged into a trip they are no longer available for.
        const engaged = await tx.driverAvailability.updateMany({
          where: { driverId, status: 'online' },
          data: { status: 'on_trip', currentRideId: ride.id },
        });
        if (engaged.count === 0) {
          throw new ConflictException({
            code: 'driver_not_online',
            message: 'Go online before accepting a ride.',
          });
        }

        // The other candidates are still watching a countdown for a ride that
        // is gone. Read them first — updateMany cannot return rows, and their
        // driver ids are what the revoke is addressed to.
        const others = await tx.rideOffer.findMany({
          where: { rideId: ride.id, status: 'pending', NOT: { id: offerId } },
          select: { id: true, driverId: true },
        });
        if (others.length > 0) {
          // `responded_at` stays null on purpose: nobody responded. It is the
          // column acceptance rate is computed from, and filling it in here
          // would count a withdrawn offer as an answered one.
          await tx.rideOffer.updateMany({
            where: { id: { in: others.map((o) => o.id) } },
            data: { status: 'revoked' },
          });
        }
        return others;
      });
    } catch (error) {
      throw this.asOfferConflict(error);
    }

    // Out of the index's `online` set, carrying the ride so live ETA can find
    // the trip from the position. After the commit, never inside it: a status
    // written to the index first would survive a rollback the index never
    // hears about, and the index ranks a status write by when it happened —
    // one made after the commit is what outranks a reconcile that read the row
    // before it. Awaited, but it cannot throw; see syncIndexStatus.
    await this.syncIndexStatus(driverId, 'on_trip', ride.id);

    for (const loser of losers) {
      await this.publishRevoked(loser.id, ride.id, loser.driverId, 'taken_by_another_driver');
    }
    this.logger.log(
      `Driver ${driverId} accepted ride ${ride.id} (offer ${offerId}, round ${offer.round}, ` +
        `${pickupDistanceMeters}m out); ${losers.length} offer(s) revoked.`,
    );

    const accepted: RideOfferRow = { ...offer, status: 'accepted', respondedAt: new Date() };
    return this.acceptanceOf(accepted, ride, vehicleId, pickupDistanceMeters, pickupEtaSeconds);
  }

  /**
   * A driver says no.
   *
   * The decline is recorded rather than deleted: decline reasons feed driver
   * ranking and any later conversation about somebody who refuses everything,
   * and the row is what keeps them out of this ride's remaining rounds.
   */
  async declineOffer(
    driverId: string,
    offerId: string,
    input: OfferDeclineInput,
  ): Promise<RideOffer> {
    const offer = await this.prisma.rideOffer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException({ code: 'offer_not_found', message: 'That offer is gone.' });
    }
    if (offer.driverId !== driverId) {
      throw new ForbiddenException({
        code: 'not_your_offer',
        message: 'That offer was made to another driver.',
      });
    }
    // A repeated decline is the same answer, not an error: the app fires this
    // on tap and again on the retry after a dropped response.
    if (offer.status === 'declined') return toRideOffer(offer);
    if (offer.status !== 'pending') {
      throw new ConflictException({
        code: 'offer_not_pending',
        message: 'That offer is no longer open.',
      });
    }

    const respondedAt = new Date();
    const { count } = await this.prisma.rideOffer.updateMany({
      where: { id: offerId, status: 'pending' },
      data: { status: 'declined', respondedAt, declineReason: input.reason },
    });
    if (count === 0) {
      throw new ConflictException({
        code: 'offer_not_pending',
        message: 'That offer is no longer open.',
      });
    }

    // Move the ride on now rather than at the next tick. When this was the last
    // outstanding offer the rider's wait is otherwise padded by a whole tick
    // for nothing; when it was not, `dispatch` sees the remaining pending
    // offers and returns `waiting`.
    this.nudge(offer.rideId);

    return toRideOffer({ ...offer, status: 'declined', respondedAt, declineReason: input.reason });
  }

  /**
   * Retire one unanswered offer. False means it was already resolved — an
   * expiry racing an accept is normal, and the accept wins.
   */
  async expireOffer(offerId: string): Promise<boolean> {
    const offer = await this.prisma.rideOffer.findUnique({
      where: { id: offerId },
      select: { id: true, rideId: true, driverId: true },
    });
    if (!offer) return false;

    const { count } = await this.prisma.rideOffer.updateMany({
      where: { id: offerId, status: 'pending' },
      data: { status: 'expired' },
    });
    if (count === 0) return false;

    await this.publishRevoked(offer.id, offer.rideId, offer.driverId, 'expired');
    return true;
  }

  /**
   * Retire every offer past its deadline, in one statement. The worker's first
   * job each tick.
   *
   * One `UPDATE ... RETURNING` rather than read-then-write: the read-then-write
   * shape lets two workers both decide an offer is stale and both publish a
   * revoke. `FOR UPDATE SKIP LOCKED` means a second worker walks past the rows
   * this one has claimed instead of blocking behind them.
   */
  async expireDueOffers(limit: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<RetiredOfferRow[]>`
      UPDATE "ride_offers"
         SET "status" = 'expired'
       WHERE "id" IN (
         SELECT "id"
           FROM "ride_offers"
          WHERE "status" = 'pending'
            AND "expires_at" <= now()
          ORDER BY "expires_at" ASC
          LIMIT ${limit}::int
          FOR UPDATE SKIP LOCKED
       )
      RETURNING "id", "ride_id", "driver_id"
    `;

    for (const row of rows) {
      await this.publishRevoked(row.id, row.ride_id, row.driver_id, 'expired');
    }
    if (rows.length > 0) {
      this.logger.debug(`Expired ${rows.length} unanswered offer(s).`);
    }
    return rows.length;
  }

  /**
   * Withdraw every outstanding offer for a ride — the rider cancelled, or ops
   * pulled it. Public because the cancel path lives in the rides module, and
   * that module must not reach into `ride_offers` itself: leaving a pending
   * offer behind means a driver accepting a ride that no longer exists, and a
   * driver blocked from the next wave by an offer nobody will ever answer.
   */
  async revokeOffersForRide(
    rideId: string,
    reason: RtOfferRevokedPayload['reason'],
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<RetiredOfferRow[]>`
      UPDATE "ride_offers"
         SET "status" = 'revoked'
       WHERE "ride_id" = ${rideId}::uuid
         AND "status" = 'pending'
      RETURNING "id", "ride_id", "driver_id"
    `;

    for (const row of rows) {
      await this.publishRevoked(row.id, row.ride_id, row.driver_id, reason);
    }
    if (rows.length > 0) {
      this.logger.log(`Revoked ${rows.length} offer(s) for ride ${rideId}: ${reason}.`);
    }
    return rows.length;
  }

  /**
   * What a driver is currently being asked about. At most one, by
   * `ride_offers_one_pending_per_driver` — returned as a list anyway so a
   * reconnecting app can restore whatever it finds without special-casing the
   * instant an offer is being retired.
   */
  async pendingOffersForDriver(driverId: string): Promise<RideOffer[]> {
    const rows = await this.prisma.rideOffer.findMany({
      where: { driverId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { offeredAt: 'desc' },
    });
    return rows.map(toRideOffer);
  }

  // -------------------------------------------------------------------------
  // Live index status
  // -------------------------------------------------------------------------

  /**
   * Put a driver back into the live index's dispatch pool after their trip
   * ended — completed, or cancelled by either party.
   *
   * The trip-end paths live in the rides module and write `driver_availability`
   * themselves. This is the half they would otherwise have to reach into the
   * geo index for, and it sits here because "who may be offered a ride" is
   * dispatch's question. Call it AFTER the transaction that set the row back to
   * `online` has committed, and only when that guarded write matched a row: a
   * driver already moved onto another trip must stay `on_trip` in the index too.
   *
   * Skipping it is not a correctness bug — the row is the truth — but it leaves
   * the driver invisible to every wave until the flush worker next reconciles
   * them, up to one availability refresh after their next ping. Never throws.
   */
  async returnDriverToPool(driverId: string): Promise<void> {
    await this.syncIndexStatus(driverId, 'online', null);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Where a wave looks and how far it reaches. Rounds past the end of either
   * ladder repeat its last entry, so a DISPATCH_MAX_ROUNDS larger than a ladder
   * means "keep trying at the widest search" rather than a crash — ops tunes
   * the three independently.
   */
  private searchForRound(round: number): WaveSearch {
    return {
      rings: ladderEntry(this.ringLadder, round),
      capMeters: ladderEntry(this.radiusLadder, round),
    };
  }

  /**
   * Mirror a committed availability change into the live index, best-effort.
   *
   * Never throws. By the time this runs Postgres holds the truth and the caller
   * has been promised an outcome; failing a driver's accept over a cache write
   * would turn a Redis blip into a lost trip. What a missed write costs is
   * bounded twice over: every wave re-reads `driver_availability.status` in
   * {@link eligibleDrivers}, so an entry still marked `online` cannot draw an
   * offer, and LocationFlushWorker reconciles the entry from Postgres within
   * one availability refresh of the driver's next ping.
   */
  private async syncIndexStatus(
    driverId: string,
    status: IndexedDriverStatus,
    rideId: string | null,
  ): Promise<void> {
    try {
      await this.index.setStatus(driverId, status, rideId);
    } catch (error) {
      this.logger.warn(
        `Live index not updated for driver ${driverId} (${status}); the flush worker ` +
          `will reconcile it from Postgres: ${describeError(error)}`,
      );
    }
  }

  /**
   * Straight-line metres → an approximate ETA.
   *
   * Still correct for OFFERS: a wave quotes many candidates and must stay
   * cheap, and the number is superseded the moment somebody accepts. The
   * rider-facing ETA is routed in `accept()` instead.
   */
  private etaSecondsFor(distanceMeters: number): number {
    const seconds = Math.round((distanceMeters * ROAD_DETOUR_FACTOR) / this.averageSpeedMps);
    return Math.max(MIN_ETA_SECONDS, seconds);
  }

  private outcome(
    rideId: string,
    round: number,
    offersCreated: number,
    decision: DispatchDecision,
  ): DispatchOutcome {
    return { rideId: rideId as RideId, round, offersCreated, decision };
  }

  private acceptanceOf(
    offer: RideOfferRow,
    ride: Ride,
    vehicleId: string,
    pickupDistanceMeters: number,
    pickupEtaSeconds: number,
  ): OfferAcceptance {
    return {
      offer: toRideOffer(offer),
      rideId: ride.id as RideId,
      driverId: offer.driverId as DriverId,
      vehicleId: vehicleId as VehicleId,
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
      pickupAddress: ride.pickupAddress,
      pickupDistanceMeters,
      pickupEtaSeconds,
    };
  }

  /**
   * Re-dispatch in the background. Failures are logged and dropped: the caller
   * is a driver whose decline already succeeded, and their request must not
   * fail because the next wave could not start. The worker retries every tick.
   */
  private nudge(rideId: string): void {
    void this.dispatch(rideId).catch((error: unknown) => {
      this.logger.warn(`Follow-up dispatch for ride ${rideId} failed: ${describeError(error)}`);
    });
  }

  private async publishOffer(ride: Ride, row: RideOfferRow): Promise<void> {
    const secondsRemaining = Math.max(
      0,
      Math.round((row.expiresAt.getTime() - Date.now()) / 1000),
    );
    const event: DispatchOfferEvent = {
      driverId: row.driverId as DriverId,
      offer: toRideOffer(row),
      ride: {
        rideId: ride.id as RideId,
        rideClass: ride.rideClass as RideClass,
        pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
        pickupAddress: ride.pickupAddress,
        dropoff: { lat: ride.dropoffLat, lng: ride.dropoffLng },
        dropoffAddress: ride.dropoffAddress,
        tripDistanceMeters: ride.distanceMeters,
        tripDurationSeconds: ride.durationSeconds,
        fareCents: ride.fareCents,
      },
      secondsRemaining,
    };
    // `pickup_otp` is not in this payload and must never be: the code is how the
    // rider proves they are the person who booked, and a driver who already
    // knows it can start a trip nobody took.
    await this.publish(DISPATCH_CHANNELS.offerNew, event);
  }

  private async publishRevoked(
    offerId: string,
    rideId: string,
    driverId: string,
    reason: RtOfferRevokedPayload['reason'],
  ): Promise<void> {
    const event: DispatchOfferRevokedEvent = {
      offerId: offerId as UUID,
      rideId: rideId as RideId,
      driverId: driverId as DriverId,
      reason,
    };
    await this.publish(DISPATCH_CHANNELS.offerRevoked, event);
  }

  /**
   * Fan-out is best-effort by design.
   *
   * The offer row is already committed, and that row — not the socket frame —
   * is the truth: an app that missed the push still sees the offer when it
   * reconnects, and an unanswered offer expires on schedule either way. Failing
   * an accept because Redis hiccuped would turn a cosmetic problem into a lost
   * trip.
   */
  private async publish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.redis.client.publish(channel, JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(`Realtime publish to ${channel} failed: ${describeError(error)}`);
    }
  }

  private async acquireRideLock(rideId: string): Promise<RideLock> {
    const token = randomUUID();
    try {
      const acquired = await this.redis.client.set(
        `${RIDE_LOCK_PREFIX}${rideId}`,
        token,
        'EX',
        RIDE_LOCK_TTL_SECONDS,
        'NX',
      );
      return acquired === 'OK' ? { token, contended: false } : { token: null, contended: true };
    } catch (error) {
      // The lock write failed. Dispatch unlocked rather than stopping: the
      // outstanding-offer check and the unique indexes still hold, so the worst
      // case is a duplicate wave — against a wave that never runs at all
      // because one command against a struggling Redis timed out.
      this.logger.warn(
        `Wave lock unavailable for ride ${rideId}; dispatching unlocked: ${describeError(error)}`,
      );
      return { token: null, contended: false };
    }
  }

  private async releaseRideLock(rideId: string, token: string | null): Promise<void> {
    if (!token) return;
    try {
      await this.redis.client.eval(RELEASE_IF_OWNED, 1, `${RIDE_LOCK_PREFIX}${rideId}`, token);
    } catch (error) {
      // The TTL cleans up after us; a release failure must never mask the
      // wave's own result.
      this.logger.debug(`Wave lock release failed for ride ${rideId}: ${describeError(error)}`);
    }
  }

  /**
   * Translate the races this module provokes into answers a driver app can act
   * on.
   *
   * Both spellings of a unique violation are checked: the query builder maps it
   * to P2002, while a raw statement arrives as a generic P2010 carrying
   * SQLSTATE 23505 in `meta.code`. Which one shows up depends on the path the
   * write took, and the driver should get the same 409 either way. Anything
   * else is handed back untouched — a 500 is the honest answer to a bug in a
   * query only we can write.
   */
  private asOfferConflict(error: unknown): unknown {
    // Exceptions thrown inside the transaction body are already the answer.
    if (error instanceof HttpException) return error;
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;

    const meta = error.meta as { code?: unknown } | undefined;
    const sqlState = typeof meta?.code === 'string' ? meta.code : null;
    if (error.code !== 'P2002' && sqlState !== '23505') return error;

    const violated = JSON.stringify(error.meta ?? {});
    if (violated.includes('one_pending_per_driver')) {
      return new ConflictException({
        code: 'driver_has_pending_offer',
        message: 'Answer the offer you already have first.',
      });
    }
    // `ride_offers_one_accepted_per_ride`: another driver's transaction
    // committed first. This is the race the index exists for, and this
    // translation is the difference between a clean 409 and a 500 with a
    // rider's trip on the floor.
    return new ConflictException({
      code: 'offer_already_taken',
      message: 'Another driver got there first.',
    });
  }
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/** The entry for a 1-based round; rounds past the end repeat the last entry. */
function ladderEntry(ladder: readonly number[], round: number): number {
  const index = Math.max(0, Math.min(round, ladder.length) - 1);
  return ladder[index];
}

/**
 * Index hits Postgres cleared and nothing excluded, nearest first, tie-broken
 * by rating. The pool arrives nearest-first already; the sort is what makes the
 * rating tie-break hold.
 */
function rankCandidates(
  pool: readonly NearbyIndexedDriver[],
  excluded: ReadonlySet<string>,
  cleared: ReadonlyMap<string, EligibleDriver>,
): DispatchCandidate[] {
  const candidates: DispatchCandidate[] = [];
  for (const driver of pool) {
    const eligible = cleared.get(driver.driverId);
    if (!eligible || excluded.has(driver.driverId)) continue;
    candidates.push({
      driverId: driver.driverId,
      distanceMeters: driver.distanceMeters,
      ratingAvg: eligible.ratingAvg,
      lat: driver.lat,
      lng: driver.lng,
    });
  }
  return candidates.sort(
    (a, b) => a.distanceMeters - b.distanceMeters || (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0),
  );
}

function describeSearch(search: WaveSearch): string {
  return `${search.rings} ring(s) capped at ${search.capMeters}m`;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Row → wire shape: ISO timestamps, branded ids. */
function toRideOffer(row: RideOfferRow): RideOffer {
  return {
    id: row.id as UUID,
    rideId: row.rideId as RideId,
    driverId: row.driverId as DriverId,
    round: row.round,
    status: row.status as RideOfferStatus,
    distanceMeters: row.distanceMeters,
    etaSeconds: row.etaSeconds,
    offeredAt: row.offeredAt.toISOString() as ISODateTime,
    expiresAt: row.expiresAt.toISOString() as ISODateTime,
    respondedAt: (row.respondedAt ? row.respondedAt.toISOString() : null) as ISODateTime | null,
    declineReason: (row.declineReason ?? null) as RideOfferDeclineReason | null,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
