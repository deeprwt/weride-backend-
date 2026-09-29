import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, type Ride, type RideOffer as RideOfferRow } from '@prisma/client';
import { DISPATCH_CHANNELS, MatchingService, RIDE_STATE_PORT } from './matching.service';
import { RideStateService } from '../rides/ride-state.service';
import type { RideEventsService } from '../rides/ride-events.service';
import type { PrismaService } from '../../common/prisma/prisma.module';
import type { RedisService } from '../../common/redis/redis.module';
import type { GeoService } from '../geo/geo.service';
import type { RouteEstimatorService } from '../pricing/route-estimator.service';
import type { H3DriverIndexService, NearbyIndexedDriver } from '../geo/h3-driver-index.service';
import { _resetEnvCache } from '../../config/env';

/**
 * Dispatch, tested at the two points where it can actually hurt somebody.
 *
 * **Acceptance.** This is the only path in the platform where two clients race
 * for the same row, and the race is settled by a partial unique index rather
 * than by anything in TypeScript. What this file can prove about it is the
 * half that lives in the process: that a unique violation becomes a 409 the
 * driver app can act on instead of a 500 with a rider's trip on the floor, that
 * the winner leaves the dispatch pool, and that every loser's countdown is
 * withdrawn.
 *
 * **The wave ladder.** A driver who declined must never see the same ride
 * again, and a ride nobody wants has to be given up on rather than searched for
 * forever — a spinner that never resolves is worse than a no, because the rider
 * cannot re-book while the platform is still pretending to look.
 *
 * RideStateService is the REAL one, wired to a stubbed event log, exactly as
 * MatchingModule wires it: the port binding is what proves the concrete service
 * satisfies RideStatePort, and a stub here would happily allow an edge the
 * contract forbids. The ride row is written through by the transaction mocks,
 * honouring the status guard, so a case can assert on the row dispatch left
 * behind rather than only on the arguments it passed.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface PrismaMock {
  ride: { findUnique: Mock };
  rideOffer: { findUnique: Mock; findMany: Mock; updateMany: Mock };
  driverAvailability: { findUnique: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
}

interface TxMock {
  ride: { updateMany: Mock; update: Mock; findUnique: Mock; findUniqueOrThrow: Mock };
  rideOffer: { createMany: Mock; updateMany: Mock; findMany: Mock };
  driverAvailability: { updateMany: Mock };
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const OFFER_ID = '77777777-7777-4777-8777-777777777777';

/** The driver who said no in round 1, and must not be asked again. */
const DECLINER_ID = '55555555-5555-4555-8555-555555555555';
const DRIVER_B_ID = '66666666-6666-4666-8666-666666666666';
const DRIVER_C_ID = '88888888-8888-4888-8888-888888888888';
const DRIVER_D_ID = '99999999-9999-4999-8999-999999999999';
const LOSER_OFFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOSER_DRIVER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Mirrors the tuning the constructor reads, so the expectations can be exact. */
const OFFER_TTL_SECONDS = 20;
const MAX_ROUNDS = 3;
const CANDIDATES_PER_ROUND = 2;
const RADIUS_LADDER = [2_000, 5_000, 10_000];
const RING_LADDER = [1, 2, 3];

describe('MatchingService', () => {
  let ride: Ride;
  let prisma: PrismaMock;
  let tx: TxMock;
  let redis: { client: { set: jest.Mock; eval: jest.Mock; publish: jest.Mock } };
  let geo: { distanceMeters: Mock };
  let index: { searchNearby: Mock; setStatus: Mock };
  let events: { append: Mock };
  let routes: { estimate: Mock; estimateMatrix: Mock };
  let service: MatchingService;

  /** What the pacing read sees; each case sets the round it is simulating. */
  let currentRoundOffers: { status: string }[];
  /** What the read-back after a wave returns — the offers that survived ON CONFLICT. */
  let createdOffers: RideOfferRow[];
  /** Drivers the exclusion query reports as unavailable to this ride. */
  let excludedDriverIds: string[];
  /** Drivers the eligibility query refuses to clear (KYC, vehicle, class, status). */
  let ineligibleDriverIds: string[];
  /** The availability row the accepting driver holds. */
  let availability: { status: string; vehicleId: string | null } | null;

  beforeAll(() => {
    // MatchingService reads its tuning in the constructor, so the environment
    // has to be in place before the first instance exists. Spelled out rather
    // than left to the defaults so the radius and round assertions below are
    // reading the same numbers the test author was.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://uride:uride@localhost:5432/uride',
      DIRECT_URL: 'postgresql://uride:uride@localhost:5432/uride',
      REDIS_URL: 'redis://localhost:6379',
      JWT_LOCAL_SECRET: 'a-test-only-secret-of-at-least-32-characters',
      DISPATCH_OFFER_TTL_SECONDS: String(OFFER_TTL_SECONDS),
      DISPATCH_MAX_ROUNDS: String(MAX_ROUNDS),
      DISPATCH_CANDIDATES_PER_ROUND: String(CANDIDATES_PER_ROUND),
      DISPATCH_RADIUS_LADDER_METERS: RADIUS_LADDER.join(','),
      DISPATCH_RING_LADDER: RING_LADDER.join(','),
      DISPATCH_AVERAGE_SPEED_KMH: '30',
    });
    _resetEnvCache();
  });

  beforeEach(() => {
    ride = rideFixture({ status: 'searching', dispatchRound: 1 });
    currentRoundOffers = [];
    createdOffers = [];
    excludedDriverIds = [];
    ineligibleDriverIds = [];
    availability = { status: 'online', vehicleId: VEHICLE_ID };

    tx = {
      ride: {
        updateMany: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      rideOffer: { createMany: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
      driverAvailability: { updateMany: jest.fn() },
    };

    // Write through to the one ride fixture, honouring the status guard: that
    // compare-and-set is the ride's lost-update control, and a mock that ignored
    // it would pass a test the database would fail.
    tx.ride.updateMany.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string; status?: string }; data: Partial<Ride> };
      if (arg.where.id !== ride.id) return { count: 0 };
      if (arg.where.status !== undefined && arg.where.status !== ride.status) return { count: 0 };
      Object.assign(ride, arg.data);
      return { count: 1 };
    });
    tx.ride.update.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { data: Partial<Ride> };
      Object.assign(ride, arg.data);
      return ride;
    });
    tx.ride.findUnique.mockImplementation(async () => ride);
    tx.ride.findUniqueOrThrow.mockImplementation(async () => ride);
    tx.rideOffer.createMany.mockResolvedValue({ count: 0 });
    tx.rideOffer.updateMany.mockResolvedValue({ count: 1 });
    tx.rideOffer.findMany.mockResolvedValue([]);
    tx.driverAvailability.updateMany.mockResolvedValue({ count: 1 });

    prisma = {
      ride: { findUnique: jest.fn().mockImplementation(async () => ride) },
      rideOffer: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      driverAvailability: {
        findUnique: jest.fn().mockImplementation(async () => availability),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    // Two different reads share this method: the pacing read (`select`) asks
    // what the current round is doing, the read-back asks which offers actually
    // landed after ON CONFLICT DO NOTHING dropped the contended ones.
    prisma.rideOffer.findMany.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { select?: unknown };
      return arg.select ? currentRoundOffers : createdOffers;
    });
    prisma.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[0] as unknown as readonly string[]).join('?');
      // Two raw reads on these paths: the exclusion query, and the eligibility
      // query that clears the index's hits against Postgres in one statement.
      if (sql.includes('declined')) return excludedDriverIds.map((id) => ({ driver_id: id }));
      if (sql.includes('kyc_status')) {
        return eligibilityIds(args)
          .filter((id) => !ineligibleDriverIds.includes(id))
          .map((id) => ({ driver_id: id, rating_avg: 4.9 }));
      }
      return [];
    });
    prisma.$transaction.mockImplementation(async (...args: unknown[]) => {
      const run = args[0] as (client: unknown) => Promise<unknown>;
      return run(tx);
    });

    redis = {
      client: {
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn().mockResolvedValue(1),
        publish: jest.fn().mockResolvedValue(1),
      },
    };
    geo = { distanceMeters: jest.fn().mockResolvedValue(0) };
    index = {
      searchNearby: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockResolvedValue(undefined),
    };
    events = { append: jest.fn().mockResolvedValue(undefined) };
    // Stubbed to the detour-factor arithmetic the service used before routing
    // existed, so these tests keep asserting dispatch behaviour rather than
    // Google's answer. `estimate` never throws in production either.
    routes = {
      // Default: road time tracks straight-line order, so every existing test
      // keeps the ranking it was written against. The river test overrides it.
      estimateMatrix: jest.fn().mockImplementation((origins: { lat: number }[]) =>
        Promise.resolve(
          origins.map((_, originIndex) => ({
            originIndex,
            distanceMeters: 1000,
            durationSeconds: 100 + originIndex,
            routed: true,
          })),
        ),
      ),
      estimate: jest.fn().mockImplementation(() =>
        Promise.resolve({
          distanceMeters: 0,
          durationSeconds: 60,
          source: 'estimate' as const,
          cached: false,
          polyline: null,
        }),
      ),
    };

    service = new MatchingService(
      prisma as unknown as PrismaService,
      geo as unknown as GeoService,
      index as unknown as H3DriverIndexService,
      redis as unknown as RedisService,
      routes as unknown as RouteEstimatorService,
      // The real state machine over a stubbed log, exactly as MatchingModule
      // binds RIDE_STATE_PORT: an illegal edge has to fail here as it would in
      // production.
      new RideStateService(events as unknown as RideEventsService),
    );
  });

  /** The port is a symbol, so a rename would silently orphan the binding. */
  it('exposes the ride-state port as a symbol the module can bind', () => {
    expect(typeof RIDE_STATE_PORT).toBe('symbol');
  });

  // -------------------------------------------------------------------------
  // Acceptance — the race
  // -------------------------------------------------------------------------

  describe('acceptOffer', () => {
    beforeEach(() => {
      prisma.rideOffer.findUnique.mockImplementation(async (...args: unknown[]) => {
        const arg = args[0] as { where: { id: string } };
        return arg.where.id === OFFER_ID ? { ...offerFixture(), ride } : null;
      });
    });

    it('turns a P2002 unique violation into 409 offer_already_taken, never a 500', async () => {
      // `ride_offers_one_accepted_per_ride` is a partial UNIQUE index, so the
      // transaction that commits second raises SQLSTATE 23505 no matter how the
      // two requests interleave. Left untranslated that is a 500, and the
      // driver app has nothing to branch on but a stack trace.
      tx.rideOffer.updateMany.mockRejectedValueOnce(
        uniqueViolation('P2002', { target: ['ride_offers_one_accepted_per_ride'] }),
      );

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'offer_already_taken' });
    });

    it('translates the raw-statement spelling of the same violation identically', async () => {
      // A raw statement arrives as a generic P2010 carrying the SQLSTATE in
      // `meta.code`. Which spelling shows up depends on the path the write
      // took, and the driver must get the same answer either way.
      tx.rideOffer.updateMany.mockRejectedValueOnce(
        uniqueViolation('P2010', { code: '23505', message: 'ride_offers_one_accepted_per_ride' }),
      );

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'offer_already_taken' });
    });

    it('names the one-pending-per-driver index separately, because the fix differs', async () => {
      // "Another driver got there first" and "answer the offer you are already
      // holding" are different instructions to the person holding the phone.
      tx.rideOffer.updateMany.mockRejectedValueOnce(
        uniqueViolation('P2002', { target: ['ride_offers_one_pending_per_driver'] }),
      );

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getResponse()).toMatchObject({ code: 'driver_has_pending_offer' });
    });

    it('does not dress an unrelated database failure up as a lost race', async () => {
      // A 500 is the honest answer to a bug in a query only we can write.
      // Swallowing everything into 409 would hide it behind a message telling
      // the driver somebody else won.
      tx.rideOffer.updateMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('FK violation', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );

      await expect(service.acceptOffer(DRIVER_ID, OFFER_ID, {})).rejects.not.toBeInstanceOf(
        HttpException,
      );
    });

    it('claims the ride, takes the driver out of the pool and revokes every other offer', async () => {
      tx.rideOffer.findMany.mockResolvedValue([
        { id: LOSER_OFFER_ID, driverId: LOSER_DRIVER_ID },
      ]);
      geo.distanceMeters.mockResolvedValue(640);

      const acceptance = await service.acceptOffer(DRIVER_ID, OFFER_ID, {
        location: { lat: 43.65, lng: -79.38 },
      });

      // The offer is claimed conditionally, so a driver whose offer was
      // concurrently expired or revoked updates nothing.
      expect(tx.rideOffer.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: OFFER_ID, status: 'pending' },
        data: { status: 'accepted', respondedAt: expect.any(Date) },
      });

      // The ride moves along a legal edge and carries the car the driver went
      // online in — never one named by the request.
      expect(ride.status).toBe('accepted');
      expect(ride.driverId).toBe(DRIVER_ID);
      expect(ride.vehicleId).toBe(VEHICLE_ID);

      // `on_trip` + `current_ride_id` is what removes the driver from every
      // future wave, and the trip-consistency CHECK refuses one without the
      // other. Guarded on `online` so a driver who went offline in between
      // loses the race instead of being dragged into a trip.
      expect(tx.driverAvailability.updateMany).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID, status: 'online' },
        data: { status: 'on_trip', currentRideId: RIDE_ID },
      });

      // The live index follows, carrying the ride — and only after the last
      // write of the transaction, so a rollback can never leave the index
      // believing in a trip Postgres does not have.
      expect(index.setStatus).toHaveBeenCalledWith(DRIVER_ID, 'on_trip', RIDE_ID);
      const lastTxWrite = Math.max(
        ...tx.rideOffer.updateMany.mock.invocationCallOrder,
        ...tx.driverAvailability.updateMany.mock.invocationCallOrder,
      );
      expect(index.setStatus.mock.invocationCallOrder[0]).toBeGreaterThan(lastTxWrite);

      // The other candidates are watching a countdown for a ride that is gone.
      const revoke = tx.rideOffer.updateMany.mock.calls.at(-1)?.[0] as {
        where: { id: { in: string[] } };
        data: Record<string, unknown>;
      };
      expect(revoke.where).toEqual({ id: { in: [LOSER_OFFER_ID] } });
      expect(revoke.data).toEqual({ status: 'revoked' });
      // `responded_at` stays null on purpose: nobody responded. It is the
      // column acceptance rate is computed from, and filling it in here would
      // count a withdrawn offer as an answered one.
      expect(revoke.data).not.toHaveProperty('respondedAt');

      const revoked = publishedOn(redis, DISPATCH_CHANNELS.offerRevoked);
      expect(revoked).toEqual([
        {
          offerId: LOSER_OFFER_ID,
          rideId: RIDE_ID,
          driverId: LOSER_DRIVER_ID,
          reason: 'taken_by_another_driver',
        },
      ]);

      // The ETA the rider is shown is recomputed from where the driver was when
      // they tapped accept, not from the estimate the wave made a whole TTL ago
      // — and it is a ROUTED duration, not straight-line arithmetic, because
      // "4 minutes away" is a promise and a driver across a river is not four
      // minutes away however short the crow's flight is.
      expect(routes.estimate).toHaveBeenCalledWith(
        { lat: 43.65, lng: -79.38 },
        { lat: 43.6532, lng: -79.3832 },
      );
      expect(acceptance.pickupDistanceMeters).toBe(640);
      expect(acceptance.pickupEtaSeconds).toBe(60);
      expect(acceptance.vehicleId).toBe(VEHICLE_ID);
    });

    it('keeps the offer estimate when the app sent no position', async () => {
      const acceptance = await service.acceptOffer(DRIVER_ID, OFFER_ID, {});

      expect(geo.distanceMeters).not.toHaveBeenCalled();
      expect(acceptance.pickupDistanceMeters).toBe(offerFixture().distanceMeters);
    });

    it('never quotes an ETA shorter than finding the car takes', async () => {
      // Nobody is 20 seconds away once the walk to the vehicle and the door are
      // counted, and an ETA that expires before the driver moves reads as a lie.
      geo.distanceMeters.mockResolvedValue(80);

      const acceptance = await service.acceptOffer(DRIVER_ID, OFFER_ID, {
        location: { lat: 43.65, lng: -79.38 },
      });

      expect(acceptance.pickupEtaSeconds).toBe(60);
    });

    it('refuses an offer that belongs to another driver', async () => {
      const error = await refusal(() => service.acceptOffer(DRIVER_B_ID, OFFER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'not_your_offer' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses an offer whose countdown has run out, and retires it', async () => {
      prisma.rideOffer.findUnique.mockResolvedValue({
        ...offerFixture({ expiresAt: new Date(Date.now() - 1_000) }),
        ride,
      });

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getResponse()).toMatchObject({ code: 'offer_expired' });
      // Retired here rather than left to the sweeper: this is the one pending
      // offer the driver may hold, and leaving it in place keeps them out of
      // the next wave for no reason.
      expect(prisma.rideOffer.updateMany).toHaveBeenCalledWith({
        where: { id: OFFER_ID, status: 'pending' },
        data: { status: 'expired' },
      });
      expect(publishedOn(redis, DISPATCH_CHANNELS.offerRevoked)).toEqual([
        { offerId: OFFER_ID, rideId: RIDE_ID, driverId: DRIVER_ID, reason: 'expired' },
      ]);
      // The ride itself is untouched — an offer timing out is not a transition.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses when the ride has already moved on', async () => {
      ride.status = 'cancelled_by_rider';

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getResponse()).toMatchObject({ code: 'ride_no_longer_available' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a driver who is mid-trip, and one who is not online at all', async () => {
      availability = { status: 'on_trip', vehicleId: VEHICLE_ID };
      const onTrip = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));
      expect(onTrip.getResponse()).toMatchObject({ code: 'driver_on_trip' });

      availability = null;
      const offline = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));
      expect(offline.getResponse()).toMatchObject({ code: 'driver_not_online' });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('loses the race cleanly when the driver went offline mid-transaction', async () => {
      tx.driverAvailability.updateMany.mockResolvedValue({ count: 0 });

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'driver_not_online' });
      // Nothing committed, so the live index must not hear about a trip.
      expect(index.setStatus).not.toHaveBeenCalled();
    });

    it('lets a retry of the accept this driver already won through', async () => {
      // Mobile networks drop responses and the app retries. A 409 here would
      // throw a driver out of their own trip.
      ride.status = 'accepted';
      ride.driverId = DRIVER_ID;
      ride.vehicleId = VEHICLE_ID;
      prisma.rideOffer.findUnique.mockResolvedValue({
        ...offerFixture({ status: 'accepted', respondedAt: new Date() }),
        ride,
      });

      const acceptance = await service.acceptOffer(DRIVER_ID, OFFER_ID, {});

      expect(acceptance.rideId).toBe(RIDE_ID);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // The retry branch never checks the trip is still live, so it must not
      // push a driver who has since finished back into `on_trip`.
      expect(index.setStatus).not.toHaveBeenCalled();
    });

    it('refuses an offer another driver already took', async () => {
      prisma.rideOffer.findUnique.mockResolvedValue({
        ...offerFixture({ status: 'revoked' }),
        ride,
      });

      const error = await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'offer_already_taken' });
    });

    it('does not fail an accept because the realtime publish did', async () => {
      // The offer row is already committed and is the truth; the socket frame
      // is a convenience. Failing here would turn a cosmetic problem into a
      // lost trip.
      redis.client.publish.mockRejectedValue(new Error('redis is down'));
      tx.rideOffer.findMany.mockResolvedValue([
        { id: LOSER_OFFER_ID, driverId: LOSER_DRIVER_ID },
      ]);

      await expect(service.acceptOffer(DRIVER_ID, OFFER_ID, {})).resolves.toMatchObject({
        rideId: RIDE_ID,
      });
    });

    it('does not fail an accept because the live index write did', async () => {
      // Same reasoning as the publish: Postgres already has the trip. The wave
      // eligibility query re-reads the availability row, so a stale `online`
      // entry cannot draw an offer, and the flush worker reconciles it.
      index.setStatus.mockRejectedValue(new Error('redis is down'));
      tx.rideOffer.findMany.mockResolvedValue([
        { id: LOSER_OFFER_ID, driverId: LOSER_DRIVER_ID },
      ]);

      await expect(service.acceptOffer(DRIVER_ID, OFFER_ID, {})).resolves.toMatchObject({
        rideId: RIDE_ID,
      });
      // The losers still hear about it: an index failure must not swallow the
      // revokes that follow it.
      expect(publishedOn(redis, DISPATCH_CHANNELS.offerRevoked)).toHaveLength(1);
    });
  });

  describe('returnDriverToPool', () => {
    it('puts the driver back in the index as online with no ride', async () => {
      await service.returnDriverToPool(DRIVER_ID);

      expect(index.setStatus).toHaveBeenCalledWith(DRIVER_ID, 'online', null);
    });

    it('never throws, because the trip end it follows has already committed', async () => {
      index.setStatus.mockRejectedValue(new Error('redis is down'));

      await expect(service.returnDriverToPool(DRIVER_ID)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The wave ladder
  // -------------------------------------------------------------------------

  describe('dispatch', () => {
    it('does not re-offer a ride to the driver who declined it in round 1', async () => {
      // Round 1 is finished — the decline is what ended it — so round 2 opens.
      currentRoundOffers = [{ status: 'declined' }];
      excludedDriverIds = [DECLINER_ID];
      index.searchNearby.mockResolvedValue([
        nearbyDriver(DECLINER_ID, 400),
        nearbyDriver(DRIVER_B_ID, 900),
        nearbyDriver(DRIVER_C_ID, 1_500),
      ]);
      createdOffers = [
        offerFixture({ id: 'offer-b', driverId: DRIVER_B_ID, round: 2, distanceMeters: 900 }),
      ];

      const outcome = await service.dispatch(RIDE_ID);

      const created = createManyArgs(tx);
      expect(created.map((row) => row.driverId)).toEqual([DRIVER_B_ID, DRIVER_C_ID]);
      // Re-offering a ride somebody already refused is the fastest way to teach
      // drivers to ignore the app — and the decline row is what remembers it
      // across rounds.
      expect(created.map((row) => row.driverId)).not.toContain(DECLINER_ID);
      expect(created.every((row) => row.round === 2)).toBe(true);
      expect(ride.dispatchRound).toBe(2);
      expect(outcome.decision).toBe('offered');

      // The exclusion is a database question, not an in-memory one: the offers
      // this ride has already burned live in `ride_offers`, and a wave running
      // on another instance has to see the same answer.
      const exclusionSql = prisma.$queryRaw.mock.calls
        .map((call) => (call[0] as unknown as readonly string[]).join('?'))
        .find((sql) => sql.includes('declined'));
      expect(exclusionSql).toBeDefined();
      expect(exclusionSql).toContain('expired');
      expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.anything(), RIDE_ID);
      // A driver already ruled out is not put to the eligibility query as well.
      expect(eligibilityCalls(prisma)).toEqual([[DRIVER_B_ID, DRIVER_C_ID]]);
    });

    it('widens the search each round, and never dispatches the rider to themselves', async () => {
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([
        // Rare, but it happens on a small fleet, and sending somebody to
        // collect themselves is the kind of bug that ends up in a screenshot.
        nearbyDriver(RIDER_ID, 100),
        nearbyDriver(DRIVER_B_ID, 900),
        // Inside ring 2's corners but past round 2's radius: the radius ladder
        // is a hard cap, so a wide ring can never offer a driver from further
        // out than ops agreed a pickup may be.
        nearbyDriver(DRIVER_C_ID, RADIUS_LADDER[1] + 1),
      ]);

      await service.dispatch(RIDE_ID);

      expect(index.searchNearby).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: ride.pickupLat,
          lng: ride.pickupLng,
          // Round 2 of a 1/2/3 ring ladder.
          maxRings: RING_LADDER[1],
          // A driver mid-trip is never a candidate.
          status: 'online',
          maxAgeMs: 60_000,
        }),
      );
      expect(createManyArgs(tx).map((row) => row.driverId)).toEqual([DRIVER_B_ID]);
      // Round 2 of a 2000/5000/10000 radius ladder is the cap applied.
      expect(createManyArgs(tx).every((row) => row.distanceMeters <= RADIUS_LADDER[1])).toBe(true);

      // The ride class is Postgres' question now — the index does not know
      // what anybody drives — and neither the rider nor the capped driver is
      // put to it.
      const eligibility = prisma.$queryRaw.mock.calls.find((call) =>
        (call[0] as unknown as readonly string[]).join('?').includes('kyc_status'),
      );
      expect(eligibility).toContain('standard');
      expect(eligibilityCalls(prisma)).toEqual([[DRIVER_B_ID]]);
    });

    it('offers only drivers Postgres clears, asking about the whole pool in one query', async () => {
      // The index knows position and status; KYC, an approved active car and
      // its class live in Postgres. One query for the set, never one a driver.
      currentRoundOffers = [{ status: 'expired' }];
      ineligibleDriverIds = [DRIVER_B_ID];
      index.searchNearby.mockResolvedValue([
        nearbyDriver(DRIVER_B_ID, 300),
        nearbyDriver(DRIVER_C_ID, 700),
      ]);

      await service.dispatch(RIDE_ID);

      expect(createManyArgs(tx).map((row) => row.driverId)).toEqual([DRIVER_C_ID]);
      expect(eligibilityCalls(prisma)).toEqual([[DRIVER_B_ID, DRIVER_C_ID]]);

      // The same predicates the PostGIS search enforced, plus the row's own
      // status: the index is a cache of `driver_availability`, and a driver
      // swept offline must not be offered a ride before it catches up.
      const sql = prisma.$queryRaw.mock.calls
        .map((call) => (call[0] as unknown as readonly string[]).join('?'))
        .find((text) => text.includes('kyc_status'));
      expect(sql).toContain(`"kyc_status" = 'approved'`);
      expect(sql).toContain(`v."status" = 'approved'`);
      expect(sql).toContain('"is_active"');
      expect(sql).toContain(`a."status" = 'online'`);
      expect(sql).toContain('ANY(');
    });

    it('offers the drivers who are closest by ROAD, not by straight line', async () => {
      // The river case, with one more candidate than the wave can ask, so the
      // ordering actually decides who is left out:
      //
      //   DRIVER_B  3.0 km straight, wrong bank    -> 900 s by road
      //   DRIVER_C  3.5 km straight, by the bridge  -> 400 s by road
      //   DRIVER_D  4.0 km straight                 -> 500 s by road
      //
      // Straight-line takes the two nearest, B and C, and the rider may end up
      // with B — ten minutes of driving around the water. On road time the wave
      // asks C and D, and B is correctly dropped despite being nearest.
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([
        nearbyDriver(DRIVER_B_ID, 3_000),
        nearbyDriver(DRIVER_C_ID, 3_500),
        nearbyDriver(DRIVER_D_ID, 4_000),
      ]);
      routes.estimateMatrix.mockResolvedValue([
        { originIndex: 0, distanceMeters: 10_000, durationSeconds: 900, routed: true },
        { originIndex: 1, distanceMeters: 7_000, durationSeconds: 400, routed: true },
        { originIndex: 2, distanceMeters: 7_500, durationSeconds: 500, routed: true },
      ]);

      await service.dispatch(RIDE_ID);

      const rows = createManyArgs(tx);
      expect(rows.map((row) => row.driverId)).toEqual([DRIVER_C_ID, DRIVER_D_ID]);
      // The offer carries the ROAD numbers, so a driver is told the distance
      // they will actually drive rather than the crow's flight.
      expect(rows[0].distanceMeters).toBe(7_000);
      expect(rows[0].etaSeconds).toBe(400);
    });

    it('routes the ETA even when every candidate will be asked anyway', async () => {
      // Two drivers, two slots: ranking cannot change WHO is asked. The numbers
      // on the offer still must be road numbers, because that is what a driver
      // reads before accepting — told "4 minutes" for a drive around a river,
      // they accept a job they would have declined.
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([
        nearbyDriver(DRIVER_B_ID, 3_000),
        nearbyDriver(DRIVER_C_ID, 3_500),
      ]);
      routes.estimateMatrix.mockResolvedValue([
        { originIndex: 0, distanceMeters: 10_000, durationSeconds: 900, routed: true },
        { originIndex: 1, distanceMeters: 4_100, durationSeconds: 300, routed: true },
      ]);

      await service.dispatch(RIDE_ID);

      expect(routes.estimateMatrix).toHaveBeenCalled();
      const rows = createManyArgs(tx);
      // Both asked, but ordered and described by road, not crow's flight.
      expect(rows.map((row) => row.driverId)).toEqual([DRIVER_C_ID, DRIVER_B_ID]);
      expect(rows.map((row) => row.etaSeconds)).toEqual([300, 900]);
      expect(rows.map((row) => row.distanceMeters)).toEqual([4_100, 10_000]);
    });

    it('keeps the straight-line order when nothing routes', async () => {
      // A maps outage must cost accuracy, never a dispatch: the wave still goes
      // out, ordered the way it was before road ranking existed.
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([
        nearbyDriver(DRIVER_B_ID, 3_000),
        nearbyDriver(DRIVER_C_ID, 3_500),
        nearbyDriver(DRIVER_D_ID, 4_000),
      ]);
      routes.estimateMatrix.mockResolvedValue([
        { originIndex: 0, distanceMeters: 6_500, durationSeconds: 780, routed: false },
        { originIndex: 1, distanceMeters: 7_800, durationSeconds: 936, routed: false },
        { originIndex: 2, distanceMeters: 9_100, durationSeconds: 1_092, routed: false },
      ]);

      await service.dispatch(RIDE_ID);

      expect(createManyArgs(tx).map((row) => row.driverId)).toEqual([
        DRIVER_B_ID,
        DRIVER_C_ID,
      ]);
    });

    it('searches a larger pool when the filters leave the wave short', async () => {
      // Downtown, the nearest handful can all be holding other offers or drive
      // the wrong class of car while an eligible driver sits one block further.
      currentRoundOffers = [{ status: 'expired' }];
      const firstLimit = CANDIDATES_PER_ROUND * 4;
      const crowd = Array.from({ length: firstLimit }, (_, i) =>
        nearbyDriver(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 100 + i),
      );
      ineligibleDriverIds = crowd.map((driver) => driver.driverId);
      index.searchNearby
        .mockResolvedValueOnce(crowd)
        .mockResolvedValueOnce([...crowd, nearbyDriver(DRIVER_C_ID, 1_200)]);

      await service.dispatch(RIDE_ID);

      expect(index.searchNearby).toHaveBeenCalledTimes(2);
      expect(index.searchNearby).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ limit: firstLimit * 4 }),
      );
      expect(createManyArgs(tx).map((row) => row.driverId)).toEqual([DRIVER_C_ID]);
      // Drivers already refused are not asked about twice.
      expect(eligibilityCalls(prisma)).toEqual([
        crowd.map((driver) => driver.driverId),
        [DRIVER_C_ID],
      ]);
    });

    it('does not search again when the pool already reaches past the cap', async () => {
      // The index returns the nearest drivers first, so once the farthest of a
      // full pool is out of range a larger pool cannot hold anyone in range.
      currentRoundOffers = [{ status: 'expired' }];
      const firstLimit = CANDIDATES_PER_ROUND * 4;
      const crowd = Array.from({ length: firstLimit }, (_, i) =>
        nearbyDriver(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 100 + i),
      );
      crowd[firstLimit - 1] = nearbyDriver(DRIVER_C_ID, RADIUS_LADDER[1] + 1);
      ineligibleDriverIds = crowd.slice(0, -1).map((driver) => driver.driverId);
      index.searchNearby.mockResolvedValue(crowd);

      const outcome = await service.dispatch(RIDE_ID);

      expect(index.searchNearby).toHaveBeenCalledTimes(1);
      expect(outcome.decision).toBe('waiting');
      expect(tx.rideOffer.createMany).not.toHaveBeenCalled();
    });

    it('opens the first wave by moving the ride to searching in one statement', async () => {
      ride = rideFixture({ status: 'requested', dispatchRound: 0 });
      index.searchNearby.mockResolvedValue([nearbyDriver(DRIVER_B_ID, 300)]);

      await service.dispatch(RIDE_ID);

      // The round rides along in the same conditional UPDATE as the status, so
      // a ride can never be `searching` at round 0 — or `requested` at round 1.
      const update = tx.ride.updateMany.mock.calls[0]?.[0] as {
        where: { status: string };
        data: Record<string, unknown>;
      };
      expect(update.where.status).toBe('requested');
      expect(update.data).toMatchObject({ status: 'searching', dispatchRound: 1 });
      expect(ride.status).toBe('searching');
      expect(events.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ fromStatus: 'requested', toStatus: 'searching' }),
      );
    });

    it('tells the rider nobody is coming once the ladder runs out', async () => {
      // A spinner that never resolves is worse than a no: the rider cannot
      // re-book while the platform is still pretending to look.
      ride = rideFixture({ status: 'searching', dispatchRound: MAX_ROUNDS });
      currentRoundOffers = [{ status: 'expired' }];

      const outcome = await service.dispatch(RIDE_ID);

      expect(ride.status).toBe('no_drivers_found');
      expect(outcome.decision).toBe('exhausted');
      expect(events.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          fromStatus: 'searching',
          toStatus: 'no_drivers_found',
          actorType: 'system',
          actorId: null,
        }),
      );
      // Nothing is searched for and nothing is offered after giving up.
      expect(index.searchNearby).not.toHaveBeenCalled();
      expect(tx.rideOffer.createMany).not.toHaveBeenCalled();
    });

    it('stands down while the current wave is still out', async () => {
      // Stacking a second wave would put two cards in front of one driver and
      // burn the ladder while drivers are still deciding.
      currentRoundOffers = [{ status: 'pending' }];

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('waiting');
      expect(index.searchNearby).not.toHaveBeenCalled();
      expect(ride.dispatchRound).toBe(1);
    });

    it('holds an empty round for one offer TTL instead of burning the ladder in seconds', async () => {
      // A round that offered nobody finishes instantly, so at a 2-second tick
      // the whole ladder would elapse before a driver could plausibly have come
      // online — and the rider would be told "no drivers" in six seconds.
      ride = rideFixture({ status: 'searching', dispatchRound: 1, updatedAt: new Date() });
      currentRoundOffers = [];

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('waiting');
      expect(index.searchNearby).not.toHaveBeenCalled();

      // Once that TTL has passed, the next wave goes out.
      ride.updatedAt = new Date(Date.now() - (OFFER_TTL_SECONDS + 1) * 1_000);
      index.searchNearby.mockResolvedValue([nearbyDriver(DRIVER_B_ID, 300)]);

      await service.dispatch(RIDE_ID);

      expect(index.searchNearby).toHaveBeenCalledTimes(1);
    });

    it('burns the round when a wave finds nobody, so the next one searches wider', async () => {
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([]);

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('waiting');
      expect(ride.dispatchRound).toBe(2);
      expect(tx.rideOffer.createMany).not.toHaveBeenCalled();
    });

    it('publishes one offer frame per row that actually landed', async () => {
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([nearbyDriver(DRIVER_B_ID, 900)]);
      // ON CONFLICT DO NOTHING drops rows silently, which is why the wave reads
      // back rather than trusting its candidate list: telling a driver about an
      // offer that does not exist is how you get an accept that 404s.
      createdOffers = [
        offerFixture({ id: 'offer-b', driverId: DRIVER_B_ID, round: 2, distanceMeters: 900 }),
      ];

      await service.dispatch(RIDE_ID);

      const [frame] = publishedOn(redis, DISPATCH_CHANNELS.offerNew) as {
        driverId: string;
        offer: { id: string };
        ride: Record<string, unknown>;
        secondsRemaining: number;
      }[];
      expect(frame.driverId).toBe(DRIVER_B_ID);
      expect(frame.offer.id).toBe('offer-b');
      expect(frame.secondsRemaining).toBeGreaterThan(0);
      // The pickup code is how the rider proves they are the person who booked.
      // A driver who already knows it can start a trip nobody took.
      expect(JSON.stringify(frame)).not.toContain(ride.pickupOtp ?? 'no-code');
      expect(frame.ride).not.toHaveProperty('pickupOtp');
    });

    it('skips a ride that is no longer dispatchable without raising', async () => {
      // Dispatch is a background loop, and a loop that throws when a rider
      // cancels is a loop that fills the error budget with ordinary behaviour.
      ride.status = 'accepted';

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('skipped');
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('stands down when another instance holds the wave lock', async () => {
      redis.client.set.mockResolvedValue(null);

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('skipped');
      expect(index.searchNearby).not.toHaveBeenCalled();
      // Nothing to release: we never held it.
      expect(redis.client.eval).not.toHaveBeenCalled();
    });

    it('keeps dispatching when Redis is down rather than matching nobody', async () => {
      // Correctness does not depend on the lock — the outstanding-offer check
      // and the unique indexes absorb a duplicate wave — so a Redis outage
      // degrades dispatch quality instead of stopping matching.
      redis.client.set.mockRejectedValue(new Error('connection refused'));
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([nearbyDriver(DRIVER_B_ID, 900)]);

      await service.dispatch(RIDE_ID);

      expect(tx.rideOffer.createMany).toHaveBeenCalled();
    });

    it('abandons the wave, without raising, when the ride moves under it', async () => {
      currentRoundOffers = [{ status: 'expired' }];
      index.searchNearby.mockResolvedValue([nearbyDriver(DRIVER_B_ID, 900)]);
      // The rider cancelled between the read and the write: the conditional
      // UPDATE matches nothing and the state service reports a conflict, which
      // is the right answer to a driver and the wrong one to raise at a loop.
      ride = rideFixture({ status: 'requested', dispatchRound: 0 });
      tx.ride.updateMany.mockResolvedValue({ count: 0 });
      tx.ride.findUnique.mockResolvedValue({ status: 'cancelled_by_rider' });

      const outcome = await service.dispatch(RIDE_ID);

      expect(outcome.decision).toBe('skipped');
      expect(redis.client.eval).toHaveBeenCalled();
    });

    it('404s for a ride that does not exist', async () => {
      prisma.ride.findUnique.mockResolvedValue(null);

      const error = await refusal(() => service.dispatch(RIDE_ID));

      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({ code: 'ride_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Declines and expiry
  // -------------------------------------------------------------------------

  describe('declineOffer', () => {
    beforeEach(() => {
      prisma.rideOffer.findUnique.mockImplementation(async () => offerFixture());
      // The decline nudges the next wave in the background; this ride is not
      // dispatchable in these cases, so the nudge is a no-op skip.
      ride.status = 'accepted';
    });

    it('records the refusal with its reason rather than deleting the row', async () => {
      const offer = await service.declineOffer(DRIVER_ID, OFFER_ID, { reason: 'too_far' });

      expect(prisma.rideOffer.updateMany).toHaveBeenCalledWith({
        where: { id: OFFER_ID, status: 'pending' },
        data: { status: 'declined', respondedAt: expect.any(Date), declineReason: 'too_far' },
      });
      // The row is what keeps this driver out of the ride's remaining rounds,
      // and what a later conversation about somebody who refuses everything is
      // argued from.
      expect(offer.status).toBe('declined');
      expect(offer.declineReason).toBe('too_far');
    });

    it('treats a repeated decline as the same answer, not an error', async () => {
      // The app fires this on tap and again on the retry after a dropped
      // response.
      prisma.rideOffer.findUnique.mockResolvedValue(
        offerFixture({ status: 'declined', declineReason: 'too_far', respondedAt: new Date() }),
      );

      const offer = await service.declineOffer(DRIVER_ID, OFFER_ID, { reason: 'too_far' });

      expect(offer.status).toBe('declined');
      expect(prisma.rideOffer.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to decline somebody else offer', async () => {
      const error = await refusal(() =>
        service.declineOffer(DRIVER_B_ID, OFFER_ID, { reason: 'other' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'not_your_offer' });
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the unique violation as Prisma raises it. Both spellings matter: the
 * query builder maps it to P2002, a raw statement to P2010 with SQLSTATE 23505
 * in `meta.code`.
 */
function uniqueViolation(
  code: string,
  meta: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint violated', {
    code,
    clientVersion: 'test',
    meta,
  });
}

/** Payloads published on one dispatch channel, parsed back from the wire. */
function publishedOn(
  redis: { client: { publish: jest.Mock } },
  channel: string,
): Record<string, unknown>[] {
  return redis.client.publish.mock.calls
    .filter((call) => call[0] === channel)
    .map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
}

interface OfferInsert {
  driverId: string;
  round: number;
  status: string;
  distanceMeters: number;
  /** Routed when road ranking produced it, detour-factor estimate otherwise. */
  etaSeconds: number;
}

function createManyArgs(tx: TxMock): OfferInsert[] {
  const call = tx.rideOffer.createMany.mock.calls.at(-1);
  if (!call) throw new Error('Expected the wave to have written offers.');
  const arg = call[0] as { data: OfferInsert[] };
  return arg.data;
}

/** The driver-id array bound into one eligibility query — its one array parameter. */
function eligibilityIds(args: readonly unknown[]): string[] {
  const ids = args.slice(1).find((value): value is string[] => Array.isArray(value));
  return ids ?? [];
}

/** Every eligibility query a case ran, as the driver ids each one asked about. */
function eligibilityCalls(prisma: PrismaMock): string[][] {
  return prisma.$queryRaw.mock.calls
    .filter((call) => (call[0] as unknown as readonly string[]).join('?').includes('kyc_status'))
    .map((call) => eligibilityIds(call));
}

async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused, but it resolved.');
}

/** A live index hit. Position and status only — eligibility is Postgres' answer. */
function nearbyDriver(driverId: string, distanceMeters: number): NearbyIndexedDriver {
  return {
    driverId,
    lat: 43.65,
    lng: -79.38,
    headingDegrees: null,
    speedMps: null,
    recordedAtMs: Date.now(),
    rideId: null,
    status: 'online',
    // latLngToCell(43.6532, -79.3832, 8) — the pickup's own res-8 hexagon.
    cell: '882b9bc46dfffff',
    distanceMeters,
    ring: 0,
  };
}

function offerFixture(overrides: Partial<RideOfferRow> = {}): RideOfferRow {
  return {
    id: OFFER_ID,
    rideId: RIDE_ID,
    driverId: DRIVER_ID,
    round: 1,
    status: 'pending',
    distanceMeters: 1_200,
    etaSeconds: 187,
    offeredAt: new Date(Date.now() - 2_000),
    expiresAt: new Date(Date.now() + OFFER_TTL_SECONDS * 1_000),
    respondedAt: null,
    declineReason: null,
    ...overrides,
  };
}

function rideFixture(overrides: Partial<Ride> = {}): Ride {
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
    acceptedAt: null,
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
    // Old enough that the empty-round pacing guard never fires by accident; the
    // case that cares about it sets its own.
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
