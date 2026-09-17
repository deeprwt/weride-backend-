import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Ride, type RideOffer as RideOfferRow } from '@prisma/client';
import {
  ADMIN_RIDE_FILTERS,
  RIDE_TRANSITIONS,
  isAdminRideFilter,
  isCancellableRideStatus,
  type AdminRideCandidate,
  type AdminRideCounts,
  type AdminRideDetail,
  type AdminRideDriverContact,
  type AdminRideListItem,
  type AdminRideListPage,
  type AdminRideOffer,
  type Cents,
  type DriverId,
  type ISODateTime,
  type NearbyDriver,
  type RideClass,
  type RideEventActor,
  type RideId,
  type RideOfferDeclineReason,
  type RideOfferStatus,
  type RideStatus,
  type UUID,
  type UserId,
} from '@uride/types';
import type { AdminRideListQueryInput, RideCancelInput, RideReassignInput } from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import type { RequestPrincipal } from '../../common/auth/current-user.decorator';
import { RealtimeService } from '../../realtime/realtime.service';
import { GeoService } from '../geo/geo.service';
import { RideEventsService, isRideStatus } from '../rides/ride-events.service';
import { RIDE_ERRORS, RideStateService, rideNotFoundError } from '../rides/ride-state.service';
import { RidesService } from '../rides/rides.service';
import { AuditService, primaryRole } from './audit.service';

/** Audit verbs written by this service. Centralised so a typo cannot split a ride's history. */
const ACTIONS = {
  rideReassigned: 'ride.reassigned',
  rideCancelled: 'ride.cancelled',
} as const;

const RESOURCE_RIDE = 'ride';

/**
 * Where a ride may still be handed to a different driver.
 *
 * `in_progress` is deliberately absent even though it is not terminal: the
 * rider is in the car, and there is no operation an ops console can perform
 * that moves them into a different one. Everything earlier is fair game —
 * reassignment exists precisely for the driver who accepted and then went
 * quiet, or whose car failed on the way to the pickup.
 *
 * Identical to CANCELLABLE_RIDE_STATUSES today; kept separate because the two
 * answer different questions and will diverge the moment scheduled rides land.
 */
const REASSIGNABLE_STATUSES: readonly RideStatus[] = [
  'requested',
  'searching',
  'accepted',
  'driver_arriving',
  'arrived',
];

/**
 * Candidate search for the reassign picker.
 *
 * Wider than a first dispatch wave and capped short: the operator is looking at
 * a ride that has ALREADY failed to find (or keep) a driver, so the useful
 * answer is "everyone plausibly reachable", and a dozen names is as many as
 * anybody picks from under pressure. Staleness matches the dispatcher's own
 * freshness window — a driver whose app died ten minutes ago is not a rescue.
 */
const CANDIDATE_RADIUS_METERS = 8_000;
const CANDIDATE_LIMIT = 12;
const CANDIDATE_MAX_AGE_SECONDS = 60;

/** Every status, derived from the transition table so a new one cannot be missed. */
const ALL_RIDE_STATUSES = Object.keys(RIDE_TRANSITIONS) as RideStatus[];

/** Raw row shapes from the board queries — snake_case, straight from Postgres. */
interface AdminRideListRow {
  id: string;
  status: string;
  ride_class: string;
  rider_id: string;
  rider_name: string | null;
  driver_id: string | null;
  driver_name: string | null;
  pickup_address: string;
  dropoff_address: string;
  distance_meters: number;
  duration_seconds: number;
  fare_cents: number | null;
  currency: string;
  dispatch_round: number;
  offer_count: number;
  pending_offer_count: number;
  requested_at: Date;
  accepted_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  age_seconds: number;
}

interface TotalRow {
  total: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

/**
 * A ride loaded with its parties and offers.
 *
 * Written out rather than derived with Prisma.RideGetPayload, matching how the
 * rides and KYC modules type their own includes — and because the explicit
 * shape is what makes the selects in {@link AdminRidesService.detail}
 * reviewable: if the two drift apart, every mapper below stops compiling.
 */
interface RideOfferWithDriver extends RideOfferRow {
  driver: { userId: string; user: { fullName: string | null } };
}

type RideWithDetail = Ride & {
  rider: { fullName: string | null; phone: string | null; email: string | null };
  driver: {
    userId: string;
    ratingSum: number;
    ratingCount: number;
    user: { fullName: string | null; phone: string | null; email: string | null };
  } | null;
  vehicle: { make: string; model: string; year: number; color: string; plate: string } | null;
  offers: RideOfferWithDriver[];
};

/** The incoming driver, once they have been proved fit to take the ride. */
interface AssignableDriver {
  driverId: string;
  vehicleId: string;
  fullName: string | null;
}

/** A pending offer that has to be withdrawn, kept so its driver can be told. */
interface RetiredOffer {
  id: string;
  driverId: string;
}

/**
 * AdminRidesService — the live dispatch desk.
 *
 * Two jobs. The first is read-only and is most of the value: show the operator
 * what dispatch is doing right now, and for one ride show the whole trail —
 * every offer, every transition, in order — because "the rider says nobody came"
 * is otherwise unanswerable. The second is the two interventions an operator
 * needs when the loop has failed a rider: hand the ride to a driver who is
 * actually there, or end it.
 *
 * Both mutations follow the rules the rest of the platform is built on rather
 * than working around them. Nothing here writes `rides.status`: every move goes
 * through RideStateService, so an ops override is checked against the same
 * state machine as a driver's tap and lands in `ride_events` with `actor_type =
 * 'admin'` against the operator's id. The decision and its audit row commit in
 * one transaction, exactly as the KYC desk does — an intervention nobody is
 * accountable for is a compliance incident.
 */
@Injectable()
export class AdminRidesService {
  private readonly logger = new Logger(AdminRidesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly rides: RidesService,
    private readonly state: RideStateService,
    private readonly events: RideEventsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // The board
  // -------------------------------------------------------------------------

  /**
   * One page of the board.
   *
   * Ordering is the whole design of this screen. Anything still happening comes
   * first, and within that the ride waiting LONGEST comes first — that is the
   * rider closest to giving up, and the one an operator has to act on. Finished
   * rides sort newest-first underneath, because there they are history and the
   * recent one is the one being asked about. Sorting purely by request time
   * would bury a ride that has been searching for four minutes under thirty
   * completed trips.
   */
  async list(query: AdminRideListQueryInput): Promise<AdminRideListPage> {
    const scope = this.scopeFilters(query);
    const where = this.whereFrom([...scope, ...this.statusFilter(query.status)]);

    // One fragment, interpolated twice: the sort has to agree with itself, and
    // two hand-written copies of the same status list is how a ride ends up
    // "in flight" for the highlight and not for the ordering.
    const inFlight = Prisma.sql`r."status" IN (${Prisma.join([
      ...ADMIN_RIDE_FILTERS.searching,
      ...ADMIN_RIDE_FILTERS.live,
    ])})`;

    // Every COUNT is cast to int. Postgres returns bigint, which Prisma hands
    // back as a JS BigInt — and BigInt throws on JSON.stringify, so the cast is
    // what keeps this endpoint from 500ing during serialisation.
    //
    // The three reads run together: this screen refreshes itself every few
    // seconds, and the badges are as much a part of a frame as the rows, so
    // serialising them would add two round trips to every tick.
    const [rows, totals, counts] = await Promise.all([
      this.prisma.$queryRaw<AdminRideListRow[]>`
        SELECT
          r."id",
          r."status",
          r."ride_class",
          r."rider_id",
          ru."full_name" AS "rider_name",
          r."driver_id",
          du."full_name" AS "driver_name",
          r."pickup_address",
          r."dropoff_address",
          r."distance_meters",
          r."duration_seconds",
          r."fare_cents",
          r."currency",
          r."dispatch_round",
          offers."offer_count",
          offers."pending_offer_count",
          r."requested_at",
          r."accepted_at",
          r."started_at",
          r."completed_at",
          r."cancelled_at",
          -- Age from the SERVER clock. The operator's browser is not a clock we
          -- can quote a wait time from in an escalation.
          EXTRACT(EPOCH FROM (now() - r."requested_at"))::int AS "age_seconds"
        FROM "rides" r
        JOIN "users" ru ON ru."id" = r."rider_id"
        -- driver_id points at driver_profiles, whose PK is the user id, so the
        -- name comes from the same users table as the rider's.
        LEFT JOIN "users" du ON du."id" = r."driver_id"
        -- A LATERAL aggregate rather than GROUP BY: grouping would have to list
        -- every selected ride column, and a ride offered to six drivers would fan
        -- out into six rows before collapsing them again.
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS "offer_count",
            (COUNT(*) FILTER (WHERE o."status" = 'pending'))::int AS "pending_offer_count"
          FROM "ride_offers" o
          WHERE o."ride_id" = r."id"
        ) offers ON TRUE
        ${where}
        ORDER BY
          (${inFlight}) DESC,
          CASE WHEN ${inFlight} THEN r."requested_at" END ASC,
          r."requested_at" DESC,
          r."id" ASC
        LIMIT ${query.limit}::int OFFSET ${query.offset}::int
    `,
      // Counted separately rather than with COUNT(*) OVER (): a window count
      // reports 0 for a page that lands past the end, which breaks the pager
      // the moment an operator clears the last page of a tab.
      this.prisma.$queryRaw<TotalRow[]>`
        SELECT COUNT(*)::int AS "total" FROM "rides" r ${where}
      `,
      this.counts(scope),
    ]);

    return {
      items: rows.map(toListItem),
      total: totals[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
      counts,
    };
  }

  /**
   * The full trail for one ride: parties, every offer with its outcome, and the
   * event log in order.
   *
   * `replayedStatus` is folded from `ride_events` and returned beside the ride's
   * own status on purpose. The log is the truth and the column is a cache of it;
   * showing both means an operator debugging a stuck ride can see instantly
   * whether the state machine or something else moved it, instead of filing a
   * bug against dispatch for a write that came from elsewhere.
   */
  async detail(rideId: string): Promise<AdminRideDetail> {
    const ride: RideWithDetail | null = await this.prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        // Explicit selects, never `rider: true`: the users row carries the
        // password hash and the encrypted TOTP secret, and an ops screen has no
        // business pulling either into process memory where the next spread
        // operator can leak it into a response.
        rider: { select: { fullName: true, phone: true, email: true } },
        driver: {
          select: {
            userId: true,
            ratingSum: true,
            ratingCount: true,
            user: { select: { fullName: true, phone: true, email: true } },
          },
        },
        vehicle: { select: { make: true, model: true, year: true, color: true, plate: true } },
        // Oldest first, id as the tiebreak: this table is read as a narrative
        // ("round 1 went to three drivers, all declined"), and a wave whose
        // rows arrive in planner order tells that story wrong.
        offers: {
          orderBy: [{ offeredAt: 'asc' }, { id: 'asc' }],
          include: { driver: { select: { userId: true, user: { select: { fullName: true } } } } },
        },
      },
    });
    if (!ride) throw rideNotFoundError();

    const status = this.statusOf(ride.status, ride.id);
    const canReassign = REASSIGNABLE_STATUSES.includes(status);

    // In parallel: three independent reads, and the detail view is the screen
    // an operator refreshes while a rider is on the phone.
    const [events, replayedStatus, candidates] = await Promise.all([
      this.events.listForRide(rideId),
      this.events.replayStatus(rideId),
      // Only for a ride that could still be handed over. A PostGIS radius
      // search for a trip that ended last Tuesday is pure cost.
      canReassign ? this.candidatesFor(ride) : Promise.resolve([]),
    ]);

    const pendingOfferCount = ride.offers.filter((offer) => offer.status === 'pending').length;

    return {
      ride: {
        id: ride.id as RideId,
        status,
        rideClass: ride.rideClass as RideClass,
        rider: { id: ride.riderId as UserId, fullName: ride.rider.fullName },
        driver: ride.driverId
          ? { id: ride.driverId as DriverId, fullName: ride.driver?.user.fullName ?? null }
          : null,
        pickupAddress: ride.pickupAddress,
        dropoffAddress: ride.dropoffAddress,
        distanceMeters: ride.distanceMeters,
        durationSeconds: ride.durationSeconds,
        fareCents: (ride.fareCents ?? null) as Cents | null,
        currency: ride.currency as AdminRideListItem['currency'],
        dispatchRound: ride.dispatchRound,
        offerCount: ride.offers.length,
        pendingOfferCount,
        requestedAt: ride.requestedAt.toISOString() as ISODateTime,
        acceptedAt: isoOrNull(ride.acceptedAt),
        startedAt: isoOrNull(ride.startedAt),
        completedAt: isoOrNull(ride.completedAt),
        cancelledAt: isoOrNull(ride.cancelledAt),
        ageSeconds: ageSecondsSince(ride.requestedAt),
      },
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
      dropoff: { lat: ride.dropoffLat, lng: ride.dropoffLng },
      rider: {
        id: ride.riderId as UserId,
        fullName: ride.rider.fullName,
        phone: ride.rider.phone,
        email: ride.rider.email,
      },
      driver: toDriverContact(ride),
      cancelledBy: (ride.cancelledBy ?? null) as RideEventActor | null,
      cancelReason: ride.cancelReason,
      actualDistanceMeters: ride.actualDistanceMeters,
      replayedStatus,
      events,
      offers: ride.offers.map(toAdminOffer),
      candidates,
      canReassign,
      canCancel: isCancellableRideStatus(status),
    };
  }

  // -------------------------------------------------------------------------
  // Interventions
  // -------------------------------------------------------------------------

  /**
   * Hand a ride to a different driver.
   *
   * The three writes that make this safe happen in one transaction: the offers
   * other drivers are still looking at are withdrawn, the outgoing driver is
   * released back into the dispatch pool, and the incoming one is claimed out
   * of it. Any of those left half-applied is a driver who can never take
   * another ride because the platform thinks they are still on this one.
   *
   * What the status does depends on where the ride is, and both branches stay
   * inside RIDE_TRANSITIONS rather than teaching this service a private edge:
   *
   *  - Still looking (`requested` / `searching`) — the ride becomes `accepted`,
   *    exactly as if the driver had tapped accept. A `requested` ride takes the
   *    legal hop through `searching` first; it costs one extra event and keeps
   *    the log replayable, which a synthesised `requested -> accepted` edge
   *    would not.
   *  - Already matched (`accepted` / `driver_arriving` / `arrived`) — the status
   *    does not change at all, because only the driver did. The event is
   *    appended with a null `to_status`, which is the shape the log already
   *    defines for "something happened that did not move the ride".
   *
   * Offer rows are NOT rewritten. An offer that was accepted is a fact about
   * what a driver did at a moment in time, and acceptance rate is computed from
   * those rows; retroactively marking it revoked would make a driver look like
   * they never answered a ride they did answer. The assignment lives on the
   * ride, and the takeover lives in the event log.
   */
  async reassign(
    actor: RequestPrincipal,
    rideId: string,
    input: RideReassignInput,
  ): Promise<AdminRideDetail> {
    const ride = await this.prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) throw rideNotFoundError();

    const status = this.statusOf(ride.status, ride.id);
    if (!REASSIGNABLE_STATUSES.includes(status)) {
      throw new ConflictException({
        code: 'ride_not_reassignable',
        message:
          status === 'in_progress'
            ? 'This trip is under way — the rider is already in the car.'
            : `A ride that is ${status} can no longer be reassigned.`,
      });
    }
    if (ride.driverId === input.driverId) {
      throw new ConflictException({
        code: 'driver_already_assigned',
        message: 'That driver already has this ride.',
      });
    }

    const target = await this.loadAssignableDriver(input.driverId);
    const previousDriverId = ride.driverId;

    const retired = await this.prisma.$transaction(async (tx) => {
      // Read before write: updateMany cannot return rows, and these driver ids
      // are what the revocation notice is addressed to. Withdrawing them first
      // also closes the race where a candidate accepts the ride we are in the
      // middle of giving to somebody else — their accept then loses the
      // compare-and-set on `rides.status` and comes back as a clean 409.
      const pending = await tx.rideOffer.findMany({
        where: { rideId, status: 'pending' },
        select: { id: true, driverId: true },
      });
      if (pending.length > 0) {
        // `responded_at` stays null: nobody responded. It is the column
        // acceptance rate is computed from, and filling it in here would count
        // a withdrawn offer as an answered one.
        await tx.rideOffer.updateMany({
          where: { id: { in: pending.map((offer) => offer.id) } },
          data: { status: 'revoked' },
        });
      }

      if (previousDriverId) {
        // Guarded on `current_ride_id`: if they have somehow already been moved
        // onto another trip, releasing them here would strand that one instead.
        await tx.driverAvailability.updateMany({
          where: { driverId: previousDriverId, currentRideId: rideId },
          data: { status: 'online', currentRideId: null },
        });
      }

      // `on_trip` + `current_ride_id` is what takes the incoming driver out of
      // every future wave, and the trip-consistency CHECK on the table refuses
      // one without the other. Guarded on `online` so a driver who went offline
      // between the eligibility read and here loses the race rather than being
      // dragged into a trip they are no longer available for.
      const engaged = await tx.driverAvailability.updateMany({
        where: { driverId: target.driverId, status: 'online' },
        data: { status: 'on_trip', currentRideId: rideId },
      });
      if (engaged.count === 0) {
        throw new ConflictException({
          code: 'driver_not_online',
          message: 'That driver just went offline. Pick another.',
        });
      }

      const metadata: Prisma.InputJsonObject = {
        fromDriverId: previousDriverId,
        toDriverId: target.driverId,
        vehicleId: target.vehicleId,
        reason: input.reason,
        reassignedFrom: status,
        offersRevoked: pending.length,
      };

      if (status === 'requested' || status === 'searching') {
        const searching =
          status === 'requested'
            ? await this.state.transition(tx, ride, 'searching', {
                actorType: 'admin',
                actorId: actor.userId,
                metadata: { reason: 'admin_reassign' },
              })
            : ride;
        await this.state.transition(tx, searching, 'accepted', {
          actorType: 'admin',
          actorId: actor.userId,
          type: ACTIONS.rideReassigned,
          metadata,
          extraData: { driverId: target.driverId, vehicleId: target.vehicleId },
        });
      } else {
        // The ride keeps its status — only the assignment changed. `accepted_at`
        // is deliberately left alone: it records when this ride first got a
        // driver, and a fare dispute about the wait is argued from that.
        const moved = await tx.ride.updateMany({
          where: { id: rideId, status },
          data: { driverId: target.driverId, vehicleId: target.vehicleId },
        });
        if (moved.count !== 1) {
          throw new ConflictException({
            code: RIDE_ERRORS.statusChanged,
            message: 'This ride moved while you were reassigning it. Refresh and try again.',
          });
        }
        await this.events.append(tx, {
          rideId,
          type: ACTIONS.rideReassigned,
          fromStatus: status,
          // Null because nothing moved. The replay fold skips these rows, which
          // is what keeps `replay(events) === rides.status` true for a ride an
          // operator has intervened on.
          toStatus: null,
          actorType: 'admin',
          actorId: actor.userId,
          metadata,
        });
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.rideReassigned,
          resource: RESOURCE_RIDE,
          resourceId: rideId,
          metadata,
        },
        tx,
      );

      return pending;
    });

    await this.announce(rideId, retired, 'taken_by_another_driver');
    this.logger.log(
      `Ride ${rideId} reassigned from ${previousDriverId ?? 'nobody'} to ${target.driverId} ` +
        `by ${actor.userId} (${retired.length} offer(s) revoked).`,
    );
    return this.detail(rideId);
  }

  /**
   * End a ride on the platform's behalf.
   *
   * The target status is `cancelled_by_rider` with `cancelled_by = 'admin'`,
   * which is not a fudge: the state machine has no admin-cancelled state, and
   * the actor column is exactly where it expects the difference to be recorded.
   * The refund path needs to tell an operator's cancellation apart from a
   * rider's own, and reading that off `cancelled_by` is what RideStateService
   * already does for every cancellation.
   *
   * Releasing the driver matters as much as the status. A driver left `on_trip`
   * on a ride that no longer exists receives no further offers and cannot go
   * offline cleanly — they simply stop earning, silently, until somebody
   * notices.
   */
  async cancel(
    actor: RequestPrincipal,
    rideId: string,
    input: RideCancelInput,
  ): Promise<AdminRideDetail> {
    const retired = await this.prisma.$transaction(async (tx) => {
      // Read inside the transaction: a ride read before it opened could have
      // been accepted, started or cancelled in between, and the cancellability
      // gate has to be applied to the status this write will race against.
      const ride = await tx.ride.findUnique({ where: { id: rideId } });
      if (!ride) throw rideNotFoundError();

      const status = this.statusOf(ride.status, ride.id);
      if (!isCancellableRideStatus(status)) {
        // 409 rather than 400: the payload is fine and the operator is allowed
        // to send it — the ride moved. Their correct next step is to refresh
        // the board, not to fix the request.
        throw new ConflictException({
          code: RIDE_ERRORS.notCancellable,
          message:
            status === 'in_progress'
              ? 'This trip is under way. It has to be completed, then refunded.'
              : `A ride that is ${status} can no longer be cancelled.`,
        });
      }

      const pending = await tx.rideOffer.findMany({
        where: { rideId, status: 'pending' },
        select: { id: true, driverId: true },
      });
      if (pending.length > 0) {
        await tx.rideOffer.updateMany({
          where: { id: { in: pending.map((offer) => offer.id) } },
          data: { status: 'revoked' },
        });
      }

      const released = ride.driverId
        ? await tx.driverAvailability.updateMany({
            where: { driverId: ride.driverId, currentRideId: rideId },
            data: { status: 'online', currentRideId: null },
          })
        : { count: 0 };

      const metadata: Prisma.InputJsonObject = {
        reason: input.reason,
        note: input.note ?? null,
        // The stage the ride was at is what a no-fault-cancellation policy is
        // written against; `status` alone stops telling you once the row moves.
        cancelledFrom: status,
        driverId: ride.driverId,
        driverReleased: released.count === 1,
        offersRevoked: pending.length,
      };

      await this.state.transition(tx, ride, 'cancelled_by_rider', {
        actorType: 'admin',
        actorId: actor.userId,
        type: ACTIONS.rideCancelled,
        metadata,
        extraData: { cancelReason: input.reason },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.rideCancelled,
          resource: RESOURCE_RIDE,
          resourceId: rideId,
          metadata,
        },
        tx,
      );

      return pending;
    });

    await this.announce(rideId, retired, 'rider_cancelled');
    this.logger.log(
      `Ride ${rideId} cancelled by ${actor.userId} (${retired.length} offer(s) revoked).`,
    );
    return this.detail(rideId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Tell the phones, after the database has committed.
   *
   * Deliberately outside the transaction and deliberately unable to fail the
   * request: the intervention has already happened, and a socket layer that is
   * down must not turn a completed cancellation into a 500 the operator retries
   * against a ride that is already cancelled. RealtimeService swallows its own
   * errors, and the apps reconcile with `GET /v1/rides/:id` on reconnect.
   */
  private async announce(
    rideId: string,
    retired: readonly RetiredOffer[],
    reason: 'taken_by_another_driver' | 'rider_cancelled',
  ): Promise<void> {
    try {
      for (const offer of retired) {
        this.realtime.emitOfferRevoked(offer.driverId, {
          offerId: offer.id as UUID,
          rideId: rideId as RideId,
          reason,
        });
      }
      // Rendered by the rides module rather than from the row here, so the
      // redaction rules — above all, which audience may see the pickup code —
      // stay in the one place that owns them.
      const view = await this.rides.view(rideId, 'admin');
      this.realtime.emitRideStatus(rideId, view);
    } catch (error) {
      // RealtimeService already swallows its own failures; this catch is for the
      // read that builds the payload. A database hiccup there must not turn a
      // committed cancellation into a 500 the operator would retry against a
      // ride that is already cancelled.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Ride ${rideId} changed but could not be announced: ${detail}`);
    }
  }

  /**
   * Prove the incoming driver can actually take the ride.
   *
   * Checked here rather than trusting the picker: the dashboard offers drivers
   * the API said were nearby a few seconds ago, and "a few seconds ago" is long
   * enough for somebody to end their shift. The vehicle comes from the
   * availability row — the car they were approved to go online in — never from
   * the request, so a reassignment cannot slip an unapproved vehicle onto a trip.
   */
  private async loadAssignableDriver(driverId: string): Promise<AssignableDriver> {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: {
        kycStatus: true,
        user: { select: { fullName: true } },
        availability: { select: { status: true, vehicleId: true } },
      },
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'driver_not_found',
        message: 'No driver profile exists for that id.',
      });
    }
    if (profile.kycStatus !== 'approved') {
      throw new ConflictException({
        code: 'driver_not_approved',
        message: `That driver is ${profile.kycStatus.replace(/_/g, ' ')} and may not carry passengers.`,
      });
    }

    const availability = profile.availability;
    if (availability?.status === 'on_trip') {
      throw new ConflictException({
        code: 'driver_on_trip',
        message: 'That driver is already on another trip.',
      });
    }
    if (!availability || availability.status !== 'online' || !availability.vehicleId) {
      throw new ConflictException({
        code: 'driver_not_online',
        message: 'That driver is not online, so they cannot be given a ride.',
      });
    }

    return {
      driverId,
      vehicleId: availability.vehicleId,
      fullName: profile.user.fullName,
    };
  }

  /**
   * Who the operator can hand this ride to.
   *
   * GeoService owns every spatial query — `last_location` is a PostGIS column
   * the Prisma client cannot read — and its search already applies the rules
   * that matter: approved driver, approved and active vehicle, online, and a
   * recent ping. Names are fetched separately because the nearby-driver
   * contract is deliberately identity-free; an operator picking a driver needs
   * to see a person, not a UUID.
   */
  private async candidatesFor(ride: {
    pickupLat: number;
    pickupLng: number;
    rideClass: string;
    driverId: string | null;
  }): Promise<AdminRideCandidate[]> {
    const nearby = await this.geo.findNearbyDrivers({
      lat: ride.pickupLat,
      lng: ride.pickupLng,
      radiusMeters: CANDIDATE_RADIUS_METERS,
      rideClass: ride.rideClass as RideClass,
      limit: CANDIDATE_LIMIT,
      maxAgeSeconds: CANDIDATE_MAX_AGE_SECONDS,
    });

    // The assigned driver is `on_trip` and therefore already excluded by the
    // spatial query; the filter is here for the window where availability has
    // not caught up, so the picker can never offer "reassign to the same person".
    const candidates: NearbyDriver[] = nearby.filter(
      (driver) => driver.driverId !== ride.driverId,
    );
    if (candidates.length === 0) return [];

    const names = await this.prisma.user.findMany({
      where: { id: { in: candidates.map((driver) => driver.driverId) } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(names.map((row) => [row.id, row.fullName]));

    return candidates.map((driver) => ({
      driver: {
        id: driver.driverId,
        fullName: nameById.get(driver.driverId) ?? null,
      },
      distanceMeters: Math.round(driver.distanceMeters),
      ratingAvg: driver.ratingAvg,
      lastPingAt: driver.lastPingAt,
    }));
  }

  /**
   * Per-status totals for the tab badges.
   *
   * One grouped query, not fourteen counts, and scoped by the rider/driver
   * filters but never by the status filter — a badge that only counted the tab
   * you are already on would tell an operator nothing about where the work is.
   */
  private async counts(scope: readonly Prisma.Sql[]): Promise<AdminRideCounts> {
    const rows = await this.prisma.$queryRaw<StatusCountRow[]>`
      SELECT r."status", COUNT(*)::int AS "count"
      FROM "rides" r
      ${this.whereFrom([...scope])}
      GROUP BY r."status"
    `;

    const counts = Object.fromEntries(
      ALL_RIDE_STATUSES.map((status) => [status, 0]),
    ) as AdminRideCounts;
    for (const row of rows) {
      // A status the contract does not know about is a data problem, not a
      // reason to drop the whole badge set: log it and keep counting.
      if (isRideStatus(row.status)) counts[row.status] = row.count;
      else this.logger.error(`rides holds unknown status "${row.status}".`);
    }
    return counts;
  }

  /** Rider/driver narrowing, shared by the page query and the badge counts. */
  private scopeFilters(query: AdminRideListQueryInput): Prisma.Sql[] {
    const filters: Prisma.Sql[] = [];
    if (query.riderId) filters.push(Prisma.sql`r."rider_id" = ${query.riderId}::uuid`);
    if (query.driverId) filters.push(Prisma.sql`r."driver_id" = ${query.driverId}::uuid`);
    return filters;
  }

  /**
   * The status filter, which accepts either a tab name or one exact status.
   *
   * `adminRideListQuerySchema` types this as a plain string precisely so the
   * vocabulary is defined here rather than frozen into the shared schema. An
   * unrecognised value is refused instead of quietly returning everything: an
   * operator who mistypes a filter must not be shown the whole table and told
   * it is the one they asked for.
   */
  private statusFilter(status: string | undefined): Prisma.Sql[] {
    if (!status) return [];
    if (isAdminRideFilter(status)) {
      return [Prisma.sql`r."status" IN (${Prisma.join([...ADMIN_RIDE_FILTERS[status]])})`];
    }
    if (isRideStatus(status)) {
      return [Prisma.sql`r."status" = ${status}`];
    }
    throw new BadRequestException({
      code: 'unknown_ride_filter',
      message: `"${status}" is not a ride status or a board filter.`,
      allowed: [...Object.keys(ADMIN_RIDE_FILTERS), ...ALL_RIDE_STATUSES],
    });
  }

  private whereFrom(filters: Prisma.Sql[]): Prisma.Sql {
    return filters.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;
  }

  /**
   * Narrow `rides.status` to the contract's union.
   *
   * The column is TEXT so the state machine can evolve without a migration,
   * which means a value outside the union is representable. An ops screen is
   * the worst place to discover that with a TypeError, so it surfaces as a
   * refusal naming the ride instead.
   */
  private statusOf(status: string, rideId: string): RideStatus {
    if (!isRideStatus(status)) {
      this.logger.error(`Ride ${rideId} holds unknown status "${status}".`);
      throw new ConflictException({
        code: RIDE_ERRORS.invalidTransition,
        message: 'This ride is in a state the server does not recognise.',
      });
    }
    return status;
  }
}

// ---------------------------------------------------------------------------
// Row -> wire
// ---------------------------------------------------------------------------

function toListItem(row: AdminRideListRow): AdminRideListItem {
  return {
    id: row.id as RideId,
    status: row.status as RideStatus,
    rideClass: row.ride_class as RideClass,
    rider: { id: row.rider_id as UserId, fullName: row.rider_name },
    driver: row.driver_id
      ? { id: row.driver_id as DriverId, fullName: row.driver_name }
      : null,
    pickupAddress: row.pickup_address,
    dropoffAddress: row.dropoff_address,
    distanceMeters: row.distance_meters,
    durationSeconds: row.duration_seconds,
    fareCents: (row.fare_cents ?? null) as Cents | null,
    currency: row.currency as AdminRideListItem['currency'],
    dispatchRound: row.dispatch_round,
    offerCount: row.offer_count,
    pendingOfferCount: row.pending_offer_count,
    requestedAt: row.requested_at.toISOString() as ISODateTime,
    acceptedAt: isoOrNull(row.accepted_at),
    startedAt: isoOrNull(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    cancelledAt: isoOrNull(row.cancelled_at),
    // Clamped: a ride requested by a server whose clock is a second ahead of
    // the database's should read as "just now", never as a negative wait.
    ageSeconds: Math.max(0, row.age_seconds),
  };
}

function toAdminOffer(offer: RideWithDetail['offers'][number]): AdminRideOffer {
  return {
    id: offer.id as UUID,
    rideId: offer.rideId as RideId,
    driverId: offer.driverId as DriverId,
    round: offer.round,
    status: offer.status as RideOfferStatus,
    distanceMeters: offer.distanceMeters,
    etaSeconds: offer.etaSeconds,
    offeredAt: offer.offeredAt.toISOString() as ISODateTime,
    expiresAt: offer.expiresAt.toISOString() as ISODateTime,
    respondedAt: isoOrNull(offer.respondedAt),
    declineReason: (offer.declineReason ?? null) as RideOfferDeclineReason | null,
    driver: {
      id: offer.driverId as DriverId,
      fullName: offer.driver.user.fullName,
    },
  };
}

/**
 * The assigned driver, with the car.
 *
 * Wider than the rider-facing RideDriverInfo — an operator dealing with a
 * stranded rider needs to phone the driver, and a first name is no use for
 * that. It is narrower than the drivers table for the same reason the KYC desk
 * is: nothing here reaches into licence numbers or KYC history.
 */
function toDriverContact(ride: RideWithDetail): AdminRideDriverContact | null {
  const driver = ride.driver;
  if (!driver) return null;
  const vehicle = ride.vehicle;
  return {
    id: driver.userId as DriverId,
    fullName: driver.user.fullName,
    phone: driver.user.phone,
    email: driver.user.email,
    // The table stores the running sum and count; the wire carries the mean,
    // rounded to the two decimals every surface displays.
    ratingAvg:
      driver.ratingCount > 0
        ? Math.round((driver.ratingSum / driver.ratingCount) * 100) / 100
        : null,
    ratingCount: driver.ratingCount,
    vehicleDescription: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
    vehiclePlate: vehicle?.plate ?? null,
    vehicleColor: vehicle?.color ?? null,
  };
}

function ageSecondsSince(at: Date): number {
  return Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
}

function isoOrNull(value: Date | null): ISODateTime | null {
  return value ? (value.toISOString() as ISODateTime) : null;
}
