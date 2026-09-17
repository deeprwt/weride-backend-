import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RideStatus } from '@uride/types';
import { RideEventsService, isRideStatus } from './ride-events.service';
import type { PrismaService } from '../../common/prisma/prisma.module';

/**
 * The append-only log, and the fold that is the reason it exists.
 *
 * `rides.status` is a denormalised cache of the newest row in this table, and
 * Phase 6 asserts `replayStatus(ride) === rides.status` for every ride on the
 * platform. That assertion is only worth making if the fold is correct about
 * the awkward rows — the events that annotate a ride without moving it, the
 * status a future release added, the gap left behind by a writer that bypassed
 * RideStateService — so those are what this file is mostly about.
 *
 * Everything here is raw SQL against a partitioned table Prisma cannot model,
 * so the client is a mock and the rows are handed to the service the way
 * Postgres would hand them over: snake_case, oldest first.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface PrismaMock {
  $queryRaw: Mock;
  $executeRaw: Mock;
}

interface TxMock {
  $executeRaw: Mock;
}

/** One row as `replayStatus` reads it. */
interface EdgeRow {
  from_status: string | null;
  to_status: string | null;
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A trip that happened: requested, searched, matched, driven, finished — with
 * the two kinds of annotation a real ride picks up along the way. This is the
 * sequence the fold has to survive, not a two-row sketch.
 */
const COMPLETED_TRIP: readonly EdgeRow[] = [
  edge(null, 'requested'), //                 ride.requested — the genesis row
  edge('requested', 'searching'), //          dispatch opened round 1
  edge('searching', 'accepted'), //           offer.accepted
  edge('accepted', 'driver_arriving'), //     driver set off
  edge('driver_arriving', null), //           ride.reassigned — a swap, not a move
  edge('driver_arriving', 'arrived'), //      driver at the kerb
  edge('arrived', null), //                   ride.pickup_code_rejected — a miss
  edge('arrived', 'in_progress'), //          the right code, second time
  edge('in_progress', 'completed'), //        fare earned
];

describe('RideEventsService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: RideEventsService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn() };
    tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    service = new RideEventsService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // replayStatus — the Phase 6 invariant
  // -------------------------------------------------------------------------

  describe('replayStatus', () => {
    it('folds a real trip down to the status the rides row holds', async () => {
      prisma.$queryRaw.mockResolvedValue([...COMPLETED_TRIP]);
      // What `rides.status` would say for this ride. The whole point of the log
      // is that these two agree without anyone keeping them in step by hand.
      const cachedStatus: RideStatus = 'completed';

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe(cachedStatus);
    });

    it('folds a ride that was cancelled while a driver was on the way', async () => {
      prisma.$queryRaw.mockResolvedValue([
        edge(null, 'requested'),
        edge('requested', 'searching'),
        edge('searching', 'accepted'),
        edge('accepted', 'cancelled_by_rider'),
      ]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe('cancelled_by_rider');
    });

    it('folds a search that found nobody', async () => {
      prisma.$queryRaw.mockResolvedValue([
        edge(null, 'requested'),
        edge('requested', 'searching'),
        edge('searching', 'no_drivers_found'),
      ]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe('no_drivers_found');
    });

    it('is not reset by an event that annotates the ride without moving it', async () => {
      // A pickup-code miss, an offer revoked, a reassignment: all real rows,
      // all with a null to_status. Folding one of those into the answer would
      // report an active trip as having no status at all.
      prisma.$queryRaw.mockResolvedValue([
        edge(null, 'requested'),
        edge('requested', 'searching'),
        edge('searching', 'accepted'),
        edge('accepted', null),
        edge('accepted', null),
      ]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe('accepted');
    });

    it('answers null for a ride with no events at all', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBeNull();
    });

    it('skips a status this build does not know and keeps the last one it does', async () => {
      // `to_status` is TEXT, so a row written by a newer release is readable
      // here. Trusting it would put a value outside RideStatus into a return
      // type every caller has been written against.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.$queryRaw.mockResolvedValue([
        edge(null, 'requested'),
        edge('requested', 'searching'),
        edge('searching', 'teleporting'),
      ]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe('searching');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('teleporting'));
    });

    it('still answers for a ride whose log has a gap, and says so', async () => {
      // A gap means something wrote `rides.status` outside RideStateService.
      // The operator investigating that needs this method to answer for the
      // ride rather than fail on it — a thrown replay would take the support
      // console down for exactly the rides somebody is trying to explain.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.$queryRaw.mockResolvedValue([
        edge(null, 'requested'),
        edge('requested', 'searching'),
        // Nothing recorded searching -> accepted; this row starts from a status
        // the log never reached.
        edge('accepted', 'arrived'),
      ]);

      await expect(service.replayStatus(RIDE_ID)).resolves.toBe('arrived');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('gap'));
    });

    it('asks for the log in insertion order', async () => {
      // The fold takes the last row that moved the ride, so the ordering is the
      // semantics, not a presentation choice. created_at is written with
      // clock_timestamp() precisely so several events appended inside one
      // transaction still order totally; id is the tiebreak.
      await service.replayStatus(RIDE_ID);

      const sql = sqlOf(prisma.$queryRaw, 0);
      expect(sql).toMatch(/ORDER BY\s+"created_at"\s+ASC,\s+"id"\s+ASC/);
    });
  });

  // -------------------------------------------------------------------------
  // append
  // -------------------------------------------------------------------------

  describe('append', () => {
    it('writes on the caller transaction, never on the pool', async () => {
      await service.append(txClient(tx), {
        rideId: RIDE_ID,
        type: 'ride.accepted',
        fromStatus: 'searching',
        toStatus: 'accepted',
        actorType: 'driver',
        actorId: DRIVER_ID,
        metadata: { offerId: 'offer-1', round: 2 },
      });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      // An event written on its own connection can commit while the status
      // change that produced it rolls back. A ride whose history disagrees with
      // its state is a compliance problem, not a logging gap.
      expect(prisma.$executeRaw).not.toHaveBeenCalled();

      expect(boundValues(tx.$executeRaw, 0)).toEqual([
        RIDE_ID,
        'ride.accepted',
        'searching',
        'accepted',
        'driver',
        DRIVER_ID,
        JSON.stringify({ offerId: 'offer-1', round: 2 }),
      ]);
    });

    it('binds nulls rather than omitting them, with the casts Postgres needs', async () => {
      await service.append(txClient(tx), {
        rideId: RIDE_ID,
        type: 'ride.requested',
        fromStatus: null,
        toStatus: 'requested',
        actorType: 'rider',
        actorId: RIDER_ID,
      });

      const [, , fromStatus, , , , metadata] = boundValues(tx.$executeRaw, 0);
      expect(fromStatus).toBeNull();
      expect(metadata).toBeNull();
      // Prisma sends bind parameters untyped, so an uncast NULL fails the
      // statement with "could not determine data type of parameter" instead of
      // storing a null. Every parameter carries its cast for that reason.
      const sql = sqlOf(tx.$executeRaw, 0);
      expect(sql).toContain('::uuid');
      expect(sql).toContain('::jsonb');
      // The server clock, not the transaction's: now() is identical for every
      // event in one transaction, which would leave the fold with no order.
      expect(sql).toContain('clock_timestamp()');
    });

    it('lets a failed insert reach the caller', async () => {
      tx.$executeRaw.mockRejectedValue(new Error('no partition of relation ride_events found'));

      await expect(
        service.append(txClient(tx), {
          rideId: RIDE_ID,
          type: 'ride.completed',
          fromStatus: 'in_progress',
          toStatus: 'completed',
          actorType: 'driver',
          actorId: DRIVER_ID,
        }),
      ).rejects.toThrow(/no partition/);
    });
  });

  // -------------------------------------------------------------------------
  // listForRide — what the support console reads
  // -------------------------------------------------------------------------

  describe('listForRide', () => {
    it('maps rows to the wire shape and narrows what it cannot trust', async () => {
      const createdAt = new Date('2026-09-12T18:04:05.678Z');
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'event-1',
          ride_id: RIDE_ID,
          type: 'ride.accepted',
          from_status: 'searching',
          to_status: 'accepted',
          actor_type: 'driver',
          actor_id: DRIVER_ID,
          metadata: { offerId: 'offer-1' },
          created_at: createdAt,
        },
        {
          id: 'event-2',
          ride_id: RIDE_ID,
          type: 'ride.annotated',
          from_status: 'teleporting',
          to_status: null,
          actor_type: 'system',
          actor_id: null,
          // JSONB legally holds arrays and scalars, and nothing at the database
          // level stops a future writer from putting one here. The contract says
          // object-or-null, so anything else reads back as null rather than
          // widening a type every consumer is already written against.
          metadata: ['not', 'an', 'object'],
          created_at: createdAt,
        },
      ]);

      const [accepted, annotated] = await service.listForRide(RIDE_ID);

      expect(accepted).toEqual({
        id: 'event-1',
        rideId: RIDE_ID,
        type: 'ride.accepted',
        fromStatus: 'searching',
        toStatus: 'accepted',
        actorType: 'driver',
        actorId: DRIVER_ID,
        metadata: { offerId: 'offer-1' },
        createdAt: createdAt.toISOString(),
      });
      expect(annotated.fromStatus).toBeNull();
      expect(annotated.toStatus).toBeNull();
      expect(annotated.metadata).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // isRideStatus — the guard both of the above lean on
  // -------------------------------------------------------------------------

  describe('isRideStatus', () => {
    it('accepts every status in the contract and nothing else', () => {
      expect(isRideStatus('in_progress')).toBe(true);
      expect(isRideStatus('no_drivers_found')).toBe(true);
      expect(isRideStatus(null)).toBe(false);
      expect(isRideStatus('')).toBe(false);
      expect(isRideStatus('teleporting')).toBe(false);
      // Derived from RIDE_TRANSITIONS with hasOwnProperty rather than `in`, so
      // an inherited Object property cannot pass for a ride status.
      expect(isRideStatus('constructor')).toBe(false);
      expect(isRideStatus('toString')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edge(from: string | null, to: string | null): EdgeRow {
  return { from_status: from, to_status: to };
}

function txClient(tx: TxMock): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

/**
 * The SQL of a tagged-template call, with the bind parameters collapsed to `?`.
 * These statements are raw because ride_events is partitioned and therefore
 * absent from schema.prisma, so the text is the only place the ordering and the
 * casts can be checked at this level.
 */
function sqlOf(mock: Mock, index: number): string {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Expected at least ${index + 1} raw statement(s).`);
  return (call[0] as unknown as readonly string[]).join('?');
}

/** The values bound into a tagged-template call, in statement order. */
function boundValues(mock: Mock, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Expected at least ${index + 1} raw statement(s).`);
  return call.slice(1);
}
