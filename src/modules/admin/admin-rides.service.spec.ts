import { HttpException, HttpStatus } from '@nestjs/common';
import type { Ride } from '@prisma/client';
import { AdminRidesService } from './admin-rides.service';
import { AuditService } from './audit.service';
import type { PrismaService } from '../../common/prisma/prisma.module';
import type { RequestPrincipal } from '../../common/auth/current-user.decorator';
import type { GeoService } from '../geo/geo.service';
import type { RideEventsService } from '../rides/ride-events.service';
import { RideStateService } from '../rides/ride-state.service';
import type { RidesService } from '../rides/rides.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * The interventions, not the reads.
 *
 * The board and the detail view are raw SQL and mappers; a test that asserted
 * on the SQL string would break on every formatting change without ever proving
 * the query returns the right rows — that belongs in an integration test against
 * a real database. What is worth pinning here is the part that can silently
 * corrupt dispatch: who may be reassigned to, what happens to the offers other
 * drivers are still holding, and whether the driver on either side of an
 * intervention is left claimed by a ride that no longer wants them.
 *
 * RideStateService is the REAL one, wired to a stubbed event log, so every case
 * below is checked against the actual transition table rather than against a
 * stub that would happily allow an illegal edge.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface TxMock {
  ride: { updateMany: Mock; findUnique: Mock; findUniqueOrThrow: Mock };
  rideOffer: { findMany: Mock; updateMany: Mock };
  driverAvailability: { updateMany: Mock };
  auditLog: { create: Mock };
}

interface PrismaMock {
  ride: { findUnique: Mock };
  driverProfile: { findUnique: Mock };
  user: { findMany: Mock };
  auditLog: { create: Mock };
  $transaction: Mock;
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const OLD_DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const NEW_DRIVER_ID = '55555555-5555-4555-8555-555555555555';
const NEW_VEHICLE_ID = '66666666-6666-4666-8666-666666666666';
const OFFER_ID = '77777777-7777-4777-8777-777777777777';
const OFFER_DRIVER_ID = '88888888-8888-4888-8888-888888888888';

/** An admin. Reassignment is admin-only; cancellation is admin or ops. */
const ACTOR: RequestPrincipal = {
  userId: '99999999-9999-4999-8999-999999999999',
  jti: 'jti-dispatch-desk',
  roles: ['admin'],
  exp: Math.floor(Date.now() / 1000) + 3600,
  raw: {},
};

describe('AdminRidesService', () => {
  let ride: Ride;
  let prisma: PrismaMock;
  let tx: TxMock;
  let events: { append: Mock; listForRide: Mock; replayStatus: Mock };
  let realtime: { emitRideStatus: jest.Mock; emitOfferRevoked: jest.Mock };
  let geo: { findNearbyDrivers: Mock };
  let rides: { view: Mock };
  let service: AdminRidesService;

  /** An online, approved driver with a car — the happy path for a reassignment. */
  let targetDriver: {
    kycStatus: string;
    user: { fullName: string | null };
    availability: { status: string; vehicleId: string | null } | null;
  };

  beforeEach(() => {
    ride = rideFixture({ status: 'searching', driverId: null, dispatchRound: 2 });
    targetDriver = {
      kycStatus: 'approved',
      user: { fullName: 'Amélie Roy' },
      availability: { status: 'online', vehicleId: NEW_VEHICLE_ID },
    };

    tx = {
      ride: { updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      rideOffer: { findMany: jest.fn(), updateMany: jest.fn() },
      driverAvailability: { updateMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };

    // Write through to the one fixture, so a case can assert on the row the
    // service left behind — status, driver, cancellation columns — rather than
    // only on the arguments it passed to Prisma. The status guard is honoured
    // too: that compare-and-set is the ride's lost-update control, and a mock
    // that ignored it would pass a test the database would fail.
    tx.ride.updateMany.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string; status?: string }; data: Partial<Ride> };
      if (arg.where.id !== ride.id) return { count: 0 };
      if (arg.where.status !== undefined && arg.where.status !== ride.status) return { count: 0 };
      Object.assign(ride, arg.data);
      return { count: 1 };
    });
    tx.ride.findUnique.mockImplementation(async () => ride);
    tx.ride.findUniqueOrThrow.mockImplementation(async () => ride);
    tx.rideOffer.findMany.mockResolvedValue([{ id: OFFER_ID, driverId: OFFER_DRIVER_ID }]);
    tx.rideOffer.updateMany.mockResolvedValue({ count: 1 });
    tx.driverAvailability.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockResolvedValue({});

    prisma = {
      ride: { findUnique: jest.fn() },
      driverProfile: { findUnique: jest.fn() },
      user: { findMany: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    // One read serves both the pre-flight (`where` only) and the detail view
    // (`include`): the extra relations are harmless to the pre-flight, and one
    // fixture keeps the two halves of every case in agreement.
    prisma.ride.findUnique.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string } };
      return arg.where.id === RIDE_ID ? withRelations(ride) : null;
    });
    prisma.driverProfile.findUnique.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { userId: string } };
      return arg.where.userId === NEW_DRIVER_ID ? targetDriver : null;
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (...args: unknown[]) => {
      const run = args[0] as (client: unknown) => Promise<unknown>;
      return run(tx);
    });

    events = {
      append: jest.fn().mockResolvedValue(undefined),
      listForRide: jest.fn().mockResolvedValue([]),
      replayStatus: jest.fn().mockImplementation(async () => ride.status),
    };
    realtime = { emitRideStatus: jest.fn(), emitOfferRevoked: jest.fn() };
    geo = { findNearbyDrivers: jest.fn().mockResolvedValue([]) };
    rides = { view: jest.fn().mockResolvedValue({ id: RIDE_ID }) };

    service = new AdminRidesService(
      prisma as unknown as PrismaService,
      geo as unknown as GeoService,
      rides as unknown as RidesService,
      // The real state machine over a stubbed log: an illegal edge must fail
      // here exactly as it would in production.
      new RideStateService(events as unknown as RideEventsService),
      events as unknown as RideEventsService,
      realtime as unknown as RealtimeService,
      // The real AuditService, so the assertions cover the row it actually
      // writes and the client it writes it on, not a stubbed port.
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  // -------------------------------------------------------------------------
  // Reassign
  // -------------------------------------------------------------------------

  describe('reassign', () => {
    const input = { driverId: NEW_DRIVER_ID, reason: 'Driver unreachable for six minutes' };

    it('refuses once the rider is in the car', async () => {
      ride.status = 'in_progress';

      const error = await refusal(() => service.reassign(ACTOR, RIDE_ID, input));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'ride_not_reassignable' });
      // Nothing may be written, and nothing may be audited, for a refusal.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses to hand the ride back to the driver who already has it', async () => {
      ride.status = 'accepted';
      ride.driverId = NEW_DRIVER_ID;

      const error = await refusal(() => service.reassign(ACTOR, RIDE_ID, input));

      expect(error.getResponse()).toMatchObject({ code: 'driver_already_assigned' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a driver who is not online, and never touches the ride', async () => {
      targetDriver.availability = { status: 'offline', vehicleId: null };

      const error = await refusal(() => service.reassign(ACTOR, RIDE_ID, input));

      expect(error.getResponse()).toMatchObject({ code: 'driver_not_online' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(ride.driverId).toBeNull();
    });

    it('refuses a driver whose KYC is not approved', async () => {
      targetDriver.kycStatus = 'suspended';

      const error = await refusal(() => service.reassign(ACTOR, RIDE_ID, input));

      expect(error.getResponse()).toMatchObject({ code: 'driver_not_approved' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('assigns a searching ride, withdraws the outstanding offers and claims the driver', async () => {
      await service.reassign(ACTOR, RIDE_ID, input);

      // The ride moves along a legal edge and carries the car the driver went
      // online in — never one named by the request.
      expect(ride.status).toBe('accepted');
      expect(ride.driverId).toBe(NEW_DRIVER_ID);
      expect(ride.vehicleId).toBe(NEW_VEHICLE_ID);

      // A pending offer left behind is a driver who can accept a ride that is
      // already gone, and who holds the one pending offer slot they have.
      expect(tx.rideOffer.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [OFFER_ID] } },
        data: { status: 'revoked' },
      });
      expect(tx.driverAvailability.updateMany).toHaveBeenCalledWith({
        where: { driverId: NEW_DRIVER_ID, status: 'online' },
        data: { status: 'on_trip', currentRideId: RIDE_ID },
      });

      expect(events.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: 'ride.reassigned',
          fromStatus: 'searching',
          toStatus: 'accepted',
          actorType: 'admin',
          actorId: ACTOR.userId,
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ride.reassigned',
          actorId: ACTOR.userId,
          actorRole: 'admin',
          resource: 'ride',
          resourceId: RIDE_ID,
        }),
      });
      // The driver still watching a countdown for this ride is told, and the
      // rider's app is told the ride changed hands.
      expect(realtime.emitOfferRevoked).toHaveBeenCalledWith(OFFER_DRIVER_ID, {
        offerId: OFFER_ID,
        rideId: RIDE_ID,
        reason: 'taken_by_another_driver',
      });
      expect(realtime.emitRideStatus).toHaveBeenCalled();
    });

    it('takes a requested ride through searching rather than inventing an edge', async () => {
      ride.status = 'requested';

      await service.reassign(ACTOR, RIDE_ID, input);

      expect(ride.status).toBe('accepted');
      // Two events, in order: the hop the state machine allows, then the
      // assignment. A synthesised requested -> accepted edge would leave the
      // log unreplayable.
      const transitions = events.append.mock.calls.map(
        ([, entry]) => (entry as { fromStatus: string | null; toStatus: string | null }),
      );
      expect(transitions).toEqual([
        expect.objectContaining({ fromStatus: 'requested', toStatus: 'searching' }),
        expect.objectContaining({ fromStatus: 'searching', toStatus: 'accepted' }),
      ]);
    });

    it('swaps the driver on an accepted ride without moving its status', async () => {
      ride.status = 'driver_arriving';
      ride.driverId = OLD_DRIVER_ID;
      const acceptedAt = ride.acceptedAt;

      await service.reassign(ACTOR, RIDE_ID, input);

      // `driver_arriving -> accepted` is not a legal edge, and the ride has not
      // stopped being under way just because the car changed.
      expect(ride.status).toBe('driver_arriving');
      expect(ride.driverId).toBe(NEW_DRIVER_ID);
      // The original acceptance time is what a wait-time dispute is argued
      // from, so an intervention must not rewrite it.
      expect(ride.acceptedAt).toBe(acceptedAt);

      // The outgoing driver goes back into the pool; the incoming one leaves it.
      expect(tx.driverAvailability.updateMany).toHaveBeenNthCalledWith(1, {
        where: { driverId: OLD_DRIVER_ID, currentRideId: RIDE_ID },
        data: { status: 'online', currentRideId: null },
      });
      expect(tx.driverAvailability.updateMany).toHaveBeenNthCalledWith(2, {
        where: { driverId: NEW_DRIVER_ID, status: 'online' },
        data: { status: 'on_trip', currentRideId: RIDE_ID },
      });

      // A null to_status is the log's shape for "this happened and the ride did
      // not move" — it is what the replay fold skips over.
      expect(events.append).toHaveBeenCalledTimes(1);
      expect(events.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: 'ride.reassigned',
          fromStatus: 'driver_arriving',
          toStatus: null,
          actorType: 'admin',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    const input = { reason: 'driver_too_far' as const, note: 'Rider called in; nobody came.' };

    it('refuses once the trip has started', async () => {
      ride.status = 'in_progress';

      const error = await refusal(() => service.cancel(ACTOR, RIDE_ID, input));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'ride_not_cancellable' });
      expect(ride.status).toBe('in_progress');
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('cancels as admin, releases the driver and withdraws the offers', async () => {
      ride.status = 'arrived';
      ride.driverId = OLD_DRIVER_ID;

      await service.cancel(ACTOR, RIDE_ID, input);

      // The state machine has no admin-cancelled status; the actor column is
      // where the difference between this and a rider's own cancellation lives.
      expect(ride.status).toBe('cancelled_by_rider');
      expect(ride.cancelledBy).toBe('admin');
      expect(ride.cancelReason).toBe('driver_too_far');

      // A driver left on_trip on a ride that no longer exists silently stops
      // earning until somebody notices.
      expect(tx.driverAvailability.updateMany).toHaveBeenCalledWith({
        where: { driverId: OLD_DRIVER_ID, currentRideId: RIDE_ID },
        data: { status: 'online', currentRideId: null },
      });
      expect(tx.rideOffer.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [OFFER_ID] } },
        data: { status: 'revoked' },
      });

      expect(events.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: 'ride.cancelled',
          fromStatus: 'arrived',
          toStatus: 'cancelled_by_rider',
          actorType: 'admin',
          actorId: ACTOR.userId,
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ride.cancelled',
          actorRole: 'admin',
          resource: 'ride',
          resourceId: RIDE_ID,
        }),
      });
      expect(realtime.emitOfferRevoked).toHaveBeenCalledWith(OFFER_DRIVER_ID, {
        offerId: OFFER_ID,
        rideId: RIDE_ID,
        reason: 'rider_cancelled',
      });
    });

    it('still cancels a ride nobody has accepted', async () => {
      await service.cancel(ACTOR, RIDE_ID, { reason: 'other' });

      expect(ride.status).toBe('cancelled_by_rider');
      // No driver, so nothing to release — and no stray availability write that
      // would strand somebody else's trip.
      expect(tx.driverAvailability.updateMany).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the service to refuse');
}

function rideFixture(overrides: Partial<Ride>): Ride {
  const now = new Date('2026-09-12T18:00:00.000Z');
  return {
    id: RIDE_ID,
    riderId: RIDER_ID,
    driverId: null,
    status: 'searching',
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
    routePolyline: null,
    fareBreakdown: null,
    searchingAt: now,
    acceptedAt: now,
    arrivedAt: null,
    startedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    pickupOtp: '4821',
    actualDistanceMeters: null,
    vehicleId: null,
    dispatchRound: 1,
    requestedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The ride as the detail read returns it — parties and offers attached. */
function withRelations(row: Ride): unknown {
  return {
    ...row,
    rider: { fullName: 'Sam Okafor', phone: '+14165550100', email: 'sam@example.ca' },
    driver: row.driverId
      ? {
          userId: row.driverId,
          ratingSum: 96,
          ratingCount: 20,
          user: { fullName: 'Amélie Roy', phone: '+15195550142', email: 'amelie@example.ca' },
        }
      : null,
    vehicle: null,
    offers: [
      {
        id: OFFER_ID,
        rideId: row.id,
        driverId: OFFER_DRIVER_ID,
        round: 1,
        status: 'revoked',
        distanceMeters: 900,
        etaSeconds: 120,
        offeredAt: row.requestedAt,
        expiresAt: row.requestedAt,
        respondedAt: null,
        declineReason: null,
        driver: { userId: OFFER_DRIVER_ID, user: { fullName: 'Priya Nair' } },
      },
    ],
  };
}
