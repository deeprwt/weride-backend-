import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RIDE_TRANSITIONS,
  type ISODateTime,
  type RideEvent,
  type RideEventActor,
  type RideId,
  type RideStatus,
  type UUID,
  type UserId,
} from '@uride/types';
import { PrismaService } from '../../common/prisma/prisma.module';

/**
 * One row to append to the log.
 *
 * `metadata` is Prisma's JSON input type rather than `Record<string, unknown>`
 * for the same reason AuditService uses it: a value that cannot survive a round
 * trip through JSONB — a Date, a Map, a class instance — is rejected at compile
 * time instead of landing in the column as `{}`.
 */
export interface RideEventInput {
  rideId: string;
  /** Dotted and past tense: `ride.requested`, `offer.accepted`, `ride.completed`. */
  type: string;
  fromStatus: RideStatus | null;
  /** Null for events that annotate a ride without moving it. */
  toStatus: RideStatus | null;
  actorType: RideEventActor;
  actorId: string | null;
  metadata?: Prisma.InputJsonObject | null;
}

/** Raw row shape from ride_events — snake_case, straight from Postgres. */
interface RideEventRow {
  id: string;
  ride_id: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  actor_id: string | null;
  metadata: Prisma.JsonValue | null;
  created_at: Date;
}

/** Just the two columns the fold reads — replay does not need the payloads. */
interface RideStatusEdgeRow {
  from_status: string | null;
  to_status: string | null;
}

/**
 * Runtime membership test for the RideStatus union.
 *
 * Derived from RIDE_TRANSITIONS rather than written out again, so a status
 * added to the contract is recognised here without a second edit. A hand-kept
 * copy of that list is exactly the drift that makes a perfectly legal status
 * read back from the database look like corruption.
 */
export const isRideStatus = (value: string | null): value is RideStatus =>
  value !== null && Object.prototype.hasOwnProperty.call(RIDE_TRANSITIONS, value);

/**
 * RideEventsService — the append-only transition log.
 *
 * `rides.status` is a denormalised cache of the newest row here; this table is
 * the truth. That inversion is deliberate: a ride's status is the field both a
 * rider dispute and a regulator will ask us to justify months later, and one
 * mutable column cannot answer "who moved it, from what, and when". Phase 6
 * asserts `replayStatus(ride) === rides.status` for every row, which is only a
 * meaningful test because every writer goes through {@link append} inside the
 * transaction that made the change.
 *
 * ride_events is PARTITIONED BY RANGE (created_at) and therefore absent from
 * schema.prisma — Prisma cannot model a partitioned parent — so every statement
 * below is raw SQL. See migrations/00000000000005_dispatch.
 */
@Injectable()
export class RideEventsService {
  private readonly logger = new Logger(RideEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one event. Takes the caller's transaction, never the pool.
   *
   * The transaction client is a required parameter rather than a defaulted one
   * on purpose: an event written on its own connection can commit while the
   * status change that produced it rolls back (or the reverse), and a ride whose
   * history disagrees with its state is a compliance problem, not a logging gap.
   * Demanding the caller's transaction is what makes the two atomic — and makes
   * a caller that has no transaction impossible to write by accident.
   *
   * Like AuditService.record this is deliberately not fail-safe: a failure here
   * propagates and rolls the transition back, because an unrecorded transition
   * is worse than a refused one — only the refusal is recoverable.
   */
  async append(tx: Prisma.TransactionClient, entry: RideEventInput): Promise<void> {
    // Every parameter carries an explicit cast. Prisma sends bind parameters
    // untyped, so Postgres has nothing to infer from when a value is NULL — an
    // uncast null from_status fails the statement with "could not determine
    // data type of parameter" instead of storing a null.
    //
    // created_at is written as clock_timestamp() rather than leaning on the
    // column default of now(): now() is the TRANSACTION start time and is
    // therefore identical for every event appended inside one transaction,
    // which would leave replayStatus folding rows with no defined order.
    // clock_timestamp() advances within the transaction, so the log stays
    // totally ordered even when one transaction writes several events. It is
    // also a server clock, so an event can never be filed under a timestamp
    // outside the seeded partitions for a reason a client controls.
    await tx.$executeRaw`
      INSERT INTO "ride_events" (
        "ride_id", "type", "from_status", "to_status",
        "actor_type", "actor_id", "metadata", "created_at"
      ) VALUES (
        ${entry.rideId}::uuid,
        ${entry.type}::text,
        ${entry.fromStatus}::text,
        ${entry.toStatus}::text,
        ${entry.actorType}::text,
        ${entry.actorId}::uuid,
        ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb,
        clock_timestamp()
      )
    `;

    this.logger.debug(
      `ride_event ${entry.type} ride=${entry.rideId} ` +
        `${entry.fromStatus ?? '-'} -> ${entry.toStatus ?? '-'} ` +
        `actor=${entry.actorType}:${entry.actorId ?? '-'}`,
    );
  }

  /**
   * One ride's history, oldest first — what the support console renders and
   * what a fare dispute is reconstructed from.
   *
   * Unbounded by design: a ride accumulates on the order of a dozen events, and
   * a page boundary in the middle of a trip history is worse than useless to
   * the person reading it. The (ride_id, created_at) index makes this an index
   * scan over one ride's rows. Partition pruning deliberately is not relied on —
   * a ride's events can straddle a month boundary.
   */
  async listForRide(rideId: string): Promise<RideEvent[]> {
    const rows = await this.prisma.$queryRaw<RideEventRow[]>`
      SELECT "id", "ride_id", "type", "from_status", "to_status",
             "actor_type", "actor_id", "metadata", "created_at"
      FROM "ride_events"
      WHERE "ride_id" = ${rideId}::uuid
      -- id is a tiebreak only. clock_timestamp() makes collisions practically
      -- impossible; the second key is there so the order is total rather than
      -- left to the planner if two rows ever do share a microsecond.
      ORDER BY "created_at" ASC, "id" ASC
    `;
    return rows.map(toRideEvent);
  }

  /**
   * Fold the log down to the status it implies, or null for a ride with no
   * events.
   *
   * This is the read side of the invariant the table exists for: Phase 6
   * asserts this equals `rides.status` for every ride, so it is written now to
   * make that test possible rather than later to make it pass. The fold takes
   * the newest non-null `to_status` — an event can record what happened without
   * moving the ride (an offer revoked, a location checkpoint), and those must
   * not reset the status to null.
   *
   * A broken chain — an event whose `from_status` is not where the previous one
   * left the ride — is logged, not thrown. A gap means something wrote
   * `rides.status` outside RideStateService, and the operator investigating that
   * needs this method to still answer for the ride rather than fail on it.
   */
  async replayStatus(rideId: string): Promise<RideStatus | null> {
    const rows = await this.prisma.$queryRaw<RideStatusEdgeRow[]>`
      SELECT "from_status", "to_status"
      FROM "ride_events"
      WHERE "ride_id" = ${rideId}::uuid
      ORDER BY "created_at" ASC, "id" ASC
    `;

    let status: RideStatus | null = null;
    for (const row of rows) {
      if (row.to_status === null) continue;
      if (!isRideStatus(row.to_status)) {
        this.logger.error(
          `ride_events for ride ${rideId} carries unknown to_status "${row.to_status}".`,
        );
        continue;
      }
      if (row.from_status !== status) {
        this.logger.warn(
          `ride_events for ride ${rideId} has a gap: an event starts from ` +
            `"${row.from_status ?? 'null'}" but the log had reached "${status ?? 'null'}".`,
        );
      }
      status = row.to_status;
    }
    return status;
  }
}

/** Map a raw row to the wire-shape RideEvent (ISO timestamps, narrowed unions). */
function toRideEvent(row: RideEventRow): RideEvent {
  return {
    id: row.id as UUID,
    rideId: row.ride_id as RideId,
    type: row.type,
    fromStatus: isRideStatus(row.from_status) ? row.from_status : null,
    toStatus: isRideStatus(row.to_status) ? row.to_status : null,
    actorType: row.actor_type as RideEventActor,
    actorId: (row.actor_id ?? null) as UserId | null,
    metadata: toMetadata(row.metadata),
    createdAt: row.created_at.toISOString() as ISODateTime,
  };
}

/**
 * JSONB legally holds scalars and arrays as well as objects, and nothing at the
 * database level stops a future writer from putting one there. The contract says
 * object-or-null, so anything else reads back as null instead of widening the
 * type every consumer has already been written against.
 */
function toMetadata(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
