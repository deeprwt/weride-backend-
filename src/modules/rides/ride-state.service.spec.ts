import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma, Ride } from '@prisma/client';
import { RIDE_TRANSITIONS, type RideStatus } from '@uride/types';
import { INITIAL_RIDE_STATUS, RideStateService } from './ride-state.service';
import type { RideEventInput, RideEventsService } from './ride-events.service';

/**
 * The state machine, checked against the contract rather than against a second
 * copy of it.
 *
 * Every case below is generated from RIDE_TRANSITIONS itself, so an edge added
 * to — or removed from — the shared table is exercised here without anybody
 * remembering to edit this file. A hand-written list of transitions in the
 * tests is exactly the drift that lets a contract change pass a green suite.
 *
 * Two properties are what this service exists for, and they are asserted on
 * every edge rather than on a sample:
 *
 *  - no ride takes an edge the contract does not name (`in_progress ->
 *    cancelled_by_rider` being the one that destroys the fare for a trip that
 *    was actually driven);
 *  - no status change exists without the `ride_events` row explaining it,
 *    written on the SAME client — a log on another connection can commit while
 *    the change rolls back, and then the ride's history disagrees with the ride.
 *
 * The event log is a stub: what belongs here is the state machine's decisions,
 * not Postgres' handling of a partitioned insert. Its transaction client is
 * compared by identity, which is the part this layer can actually promise.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface TxMock {
  ride: { updateMany: Mock; findUnique: Mock; findUniqueOrThrow: Mock };
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

const ALL_STATUSES = Object.keys(RIDE_TRANSITIONS) as RideStatus[];

const LEGAL_EDGES: readonly { readonly from: RideStatus; readonly to: RideStatus }[] =
  ALL_STATUSES.flatMap((from) => RIDE_TRANSITIONS[from].map((to) => ({ from, to })));

/**
 * The lifecycle column each status is expected to stamp. Absent means the
 * status deliberately stamps nothing — `driver_arriving` is covered by
 * `accepted_at`, and the payment states by `updated_at`.
 */
const LIFECYCLE_COLUMN: Partial<Record<RideStatus, keyof Ride>> = {
  searching: 'searchingAt',
  accepted: 'acceptedAt',
  arrived: 'arrivedAt',
  in_progress: 'startedAt',
  completed: 'completedAt',
  cancelled_by_rider: 'cancelledAt',
  cancelled_by_driver: 'cancelledAt',
};

const LIFECYCLE_COLUMNS = new Set(Object.values(LIFECYCLE_COLUMN));

describe('RideStateService', () => {
  let ride: Ride;
  let tx: TxMock;
  let events: { append: Mock };
  let service: RideStateService;

  beforeEach(() => {
    ride = rideFixture();

    tx = {
      ride: { updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    };
    // Write through to the one fixture, honouring the status guard. That guard
    // is the ride's whole lost-update control, and a mock that ignored it would
    // pass a test the database would fail.
    tx.ride.updateMany.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string; status?: string }; data: Partial<Ride> };
      if (arg.where.id !== ride.id) return { count: 0 };
      if (arg.where.status !== undefined && arg.where.status !== ride.status) return { count: 0 };
      Object.assign(ride, arg.data);
      return { count: 1 };
    });
    tx.ride.findUnique.mockImplementation(async () => ride);
    tx.ride.findUniqueOrThrow.mockImplementation(async () => ride);

    events = { append: jest.fn().mockResolvedValue(undefined) };
    service = new RideStateService(events as unknown as RideEventsService);
  });

  // -------------------------------------------------------------------------
  // Every legal edge
  // -------------------------------------------------------------------------

  describe('legal transitions', () => {
    it.each(LEGAL_EDGES)(
      '$from -> $to moves the row and appends the event in one transaction',
      async ({ from, to }: { from: RideStatus; to: RideStatus }) => {
        ride = rideFixture({ status: from });

        const moved = await service.transition(client(tx), ride, to, {
          actorType: 'system',
          actorId: null,
        });

        expect(moved.status).toBe(to);

        // Compare-and-set on the status we read, never a blind write: the loser
        // of a race has to match zero rows rather than overwrite the winner.
        const update = updateArgs(tx);
        expect(update.where).toEqual({ id: RIDE_ID, status: from });
        expect(update.data.status).toBe(to);

        const [appendedOn, entry] = appendCall(events, 0);
        expect(entry).toMatchObject({
          rideId: RIDE_ID,
          type: `ride.${to}`,
          fromStatus: from,
          toStatus: to,
          actorType: 'system',
          actorId: null,
        });
        // The event must be written on the caller's transaction. Anything else
        // can commit while the status change rolls back, leaving a ride whose
        // history and whose state disagree — and the log is the side we would
        // have to defend to a regulator.
        expect(appendedOn).toBe(tx);

        // Row first, then the event describing it: an event appended before the
        // conditional UPDATE would survive a lost race as the record of a
        // transition that never happened.
        expect(tx.ride.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          events.append.mock.invocationCallOrder[0],
        );
      },
    );

    it.each(LEGAL_EDGES)(
      '$from -> $to stamps exactly the lifecycle column that status owns',
      async ({ from, to }: { from: RideStatus; to: RideStatus }) => {
        ride = rideFixture({ status: from });

        await service.transition(client(tx), ride, to, { actorType: 'system', actorId: null });

        const { data } = updateArgs(tx);
        const stamped = [...LIFECYCLE_COLUMNS].filter((column) => column in data);
        const expected = LIFECYCLE_COLUMN[to];
        expect(stamped).toEqual(expected ? [expected] : []);
        if (expected) expect(data[expected]).toBeInstanceOf(Date);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Every illegal edge
  // -------------------------------------------------------------------------

  describe('illegal transitions', () => {
    interface IllegalCase {
      readonly from: RideStatus;
      readonly to: RideStatus;
      readonly why: string;
    }

    const cases: readonly IllegalCase[] = [
      {
        from: 'in_progress',
        to: 'cancelled_by_rider',
        why: 'this is the bug class the service exists for: cancelling a trip the rider is sitting in destroys the fare for a journey that was driven',
      },
      {
        from: 'in_progress',
        to: 'cancelled_by_driver',
        why: 'the same from the other seat — once the wheels turn this is a support case with a refund, not a cancel button',
      },
      {
        from: 'requested',
        to: 'accepted',
        why: 'a driver cannot be assigned to a ride dispatch never searched for',
      },
      {
        from: 'requested',
        to: 'in_progress',
        why: 'a trip with no driver cannot be under way',
      },
      {
        from: 'searching',
        to: 'arrived',
        why: 'nobody has accepted, so nobody can have arrived',
      },
      {
        from: 'accepted',
        to: 'in_progress',
        why: 'starting without arriving skips the pickup code, which is the whole anti-fraud gate',
      },
      {
        from: 'driver_arriving',
        to: 'in_progress',
        why: 'the same skip, one stage later',
      },
      {
        from: 'arrived',
        to: 'completed',
        why: 'a trip that never started cannot finish; that is a fare for a journey nobody took',
      },
      {
        from: 'completed',
        to: 'in_progress',
        why: 'a finished trip cannot reopen and start charging again',
      },
      {
        from: 'cancelled_by_rider',
        to: 'searching',
        why: 'a cancelled ride is terminal — re-dispatching it sends a car to somebody who cancelled',
      },
      {
        from: 'no_drivers_found',
        to: 'accepted',
        why: 'the rider was told nobody is coming, and by now they have rebooked elsewhere',
      },
      {
        from: 'closed',
        to: 'completed',
        why: 'a closed ride is settled, and moving it would reopen the money',
      },
    ];

    it.each(cases)('refuses $from -> $to because $why', async ({ from, to }: IllegalCase) => {
      ride = rideFixture({ status: from });

      const error = await refusal(() =>
        service.transition(client(tx), ride, to, { actorType: 'rider', actorId: RIDER_ID }),
      );

      // 409 rather than 400: the request is well formed and the caller is
      // allowed to make it — it is the ride that is in the wrong state, and the
      // client's correct response is to refetch, not to fix its payload.
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: 'invalid_transition',
        // The apps render their action buttons from this list, so a client that
        // has drifted resynchronises from the refusal instead of guessing.
        allowed: RIDE_TRANSITIONS[from],
      });
      // Nothing written, and — just as important — nothing logged: an event for
      // a refused transition is a lie in the record that replay would then fold
      // into the wrong status.
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
      expect(events.append).not.toHaveBeenCalled();
      expect(ride.status).toBe(from);
    });

    it('refuses every edge the contract does not name', async () => {
      // The named cases above document the ones that hurt; this closes the rest
      // of the 14x14 grid, so an edge nobody thought to list cannot slip
      // through between them.
      const wronglyAllowed: string[] = [];

      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          if (RIDE_TRANSITIONS[from].includes(to)) continue;
          ride = rideFixture({ status: from });
          events.append.mockClear();
          tx.ride.updateMany.mockClear();

          try {
            await service.transition(client(tx), ride, to, {
              actorType: 'admin',
              actorId: ADMIN_ID,
            });
            wronglyAllowed.push(`${from} -> ${to}`);
          } catch {
            if (tx.ride.updateMany.mock.calls.length > 0 || events.append.mock.calls.length > 0) {
              wronglyAllowed.push(`${from} -> ${to} (refused, but wrote something first)`);
            }
          }
        }
      }

      expect(wronglyAllowed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Races and corruption
  // -------------------------------------------------------------------------

  describe('lost races', () => {
    it('turns a status that moved under us into a precise 409, and logs nothing', async () => {
      ride = rideFixture({ status: 'searching' });
      // Another writer got there first: the compare-and-set matches no rows and
      // the row now reads `cancelled_by_rider`.
      tx.ride.updateMany.mockResolvedValue({ count: 0 });
      tx.ride.findUnique.mockResolvedValue({ status: 'cancelled_by_rider' });

      const error = await refusal(() =>
        service.transition(client(tx), ride, 'accepted', {
          actorType: 'driver',
          actorId: DRIVER_ID,
        }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({
        code: 'ride_status_changed',
        // The driver's app needs the status that actually won, not just "no".
        currentStatus: 'cancelled_by_rider',
      });
      expect(events.append).not.toHaveBeenCalled();
    });

    it('answers 404 when the ride has gone entirely', async () => {
      tx.ride.updateMany.mockResolvedValue({ count: 0 });
      tx.ride.findUnique.mockResolvedValue(null);

      const error = await refusal(() =>
        service.transition(client(tx), ride, 'searching', {
          actorType: 'system',
          actorId: null,
        }),
      );

      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({ code: 'ride_not_found' });
    });

    it('refuses a ride holding a status the server does not recognise', async () => {
      // `rides.status` is TEXT so the machine can evolve without a migration,
      // which makes an unknown value representable. Indexing RIDE_TRANSITIONS
      // with one would be a TypeError, and a 500 on an ordinary request.
      ride = rideFixture({ status: 'teleporting' });

      const error = await refusal(() =>
        service.transition(client(tx), ride, 'completed', {
          actorType: 'admin',
          actorId: ADMIN_ID,
        }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_transition' });
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // What the caller can and cannot influence
  // -------------------------------------------------------------------------

  describe('transition options', () => {
    it('stamps cancelled_by from the actor, not from the target status', async () => {
      ride = rideFixture({ status: 'arrived' });

      await service.transition(client(tx), ride, 'cancelled_by_rider', {
        actorType: 'admin',
        actorId: ADMIN_ID,
        type: 'ride.cancelled',
      });

      // A support agent cancelling on a rider's behalf is not the rider doing
      // it, and the refund path has to be able to tell them apart.
      expect(ride.cancelledBy).toBe('admin');
      expect(ride.cancelledAt).toBeInstanceOf(Date);
      expect(appendCall(events, 0)[1]).toMatchObject({
        type: 'ride.cancelled',
        toStatus: 'cancelled_by_rider',
        actorType: 'admin',
      });
    });

    it('writes extraData in the same statement, and lets it override a default', async () => {
      ride = rideFixture({ status: 'searching' });

      await service.transition(client(tx), ride, 'accepted', {
        actorType: 'driver',
        actorId: DRIVER_ID,
        metadata: { offerId: 'offer-1' },
        extraData: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID },
      });

      // One statement: a driver assigned by a second UPDATE could be attached
      // to a ride whose status change had already lost its race.
      expect(tx.ride.updateMany).toHaveBeenCalledTimes(1);
      const { data } = updateArgs(tx);
      expect(data).toMatchObject({
        status: 'accepted',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
      });
      expect(appendCall(events, 0)[1].metadata).toEqual({ offerId: 'offer-1' });
    });

    it('propagates a failure to append, rolling the transition back with it', async () => {
      // Deliberately not fail-safe: an unrecorded transition is worse than a
      // refused one, because only the refusal is recoverable.
      events.append.mockRejectedValue(new Error('ride_events partition missing'));
      ride = rideFixture({ status: 'requested' });

      await expect(
        service.transition(client(tx), ride, 'searching', {
          actorType: 'system',
          actorId: null,
        }),
      ).rejects.toThrow(/partition missing/);
    });
  });

  // -------------------------------------------------------------------------
  // Genesis
  // -------------------------------------------------------------------------

  describe('recordRequested', () => {
    it('writes the first event and touches no row', async () => {
      await service.recordRequested(client(tx), ride, RIDER_ID, { quotedFareCents: 1285 });

      const [appendedOn, entry] = appendCall(events, 0);
      expect(appendedOn).toBe(tx);
      expect(entry).toMatchObject({
        rideId: RIDE_ID,
        type: 'ride.requested',
        // No prior status: creation is not a transition, and replay starts from
        // nothing. Without this row a ride replays as null and every assertion
        // about it fails.
        fromStatus: null,
        toStatus: INITIAL_RIDE_STATUS,
        actorType: 'rider',
        actorId: RIDER_ID,
        metadata: { quotedFareCents: 1285 },
      });
      // The INSERT already wrote `requested`; a second write here would be the
      // state machine racing the statement that created the row.
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The mock as the service's signature wants it, cast in one place. */
function client(tx: TxMock): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

function updateArgs(tx: TxMock): {
  where: { id: string; status?: string };
  data: Record<string, unknown>;
} {
  const call = tx.ride.updateMany.mock.calls.at(-1);
  if (!call) throw new Error('Expected the ride row to have been updated.');
  return call[0] as { where: { id: string; status?: string }; data: Record<string, unknown> };
}

function appendCall(events: { append: Mock }, index: number): [unknown, RideEventInput] {
  const call = events.append.mock.calls[index];
  if (!call) throw new Error(`Expected at least ${index + 1} event(s) to have been appended.`);
  return call as [unknown, RideEventInput];
}

/**
 * Run a call that must be refused and hand the exception back, so each case can
 * assert on the `{ code }` body the apps switch on rather than only on
 * "something threw".
 */
async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('Expected the transition to be refused, but it resolved.');
}

function rideFixture(overrides: Partial<Ride> = {}): Ride {
  const now = new Date('2026-09-12T18:00:00.000Z');
  return {
    id: RIDE_ID,
    riderId: RIDER_ID,
    driverId: null,
    status: 'requested',
    rideClass: 'standard',
    pickupLat: 43.6532,
    pickupLng: -79.3832,
    dropoffLat: 43.6426,
    dropoffLng: -79.3871,
    pickupAddress: '100 Queen St W, Toronto',
    dropoffAddress: '290 Bremner Blvd, Toronto',
    distanceMeters: 2_400,
    durationSeconds: 540,
    fareCents: 1_285,
    currency: 'CAD',
    cancelReason: null,
    // Every lifecycle column starts null, so a case can assert that a status
    // stamped its own column and nobody else's.
    searchingAt: null,
    acceptedAt: null,
    arrivedAt: null,
    startedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    pickupOtp: '4821',
    actualDistanceMeters: null,
    vehicleId: null,
    dispatchRound: 0,
    requestedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
