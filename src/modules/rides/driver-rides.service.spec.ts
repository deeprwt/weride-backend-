import { HttpException, HttpStatus } from '@nestjs/common';
import type { Ride } from '@prisma/client';
import type { RideOffer } from '@uride/types';
import { DriverRidesService } from './driver-rides.service';
import { RideStateService } from './ride-state.service';
import type { RideEventInput, RideEventsService } from './ride-events.service';
import type { PrismaService } from '../../common/prisma/prisma.module';
import type { MatchingService } from '../matching/matching.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * The trip as the driver drives it, tested where it can cost somebody money.
 *
 * Three rules hold on every method in this service, and each of them fails
 * silently if it is wrong, which is why they are asserted rather than assumed:
 *
 *  - **The pickup code is the anti-fraud gate.** Without it a driver can
 *    accept, "arrive", start and complete a trip nobody took, and be paid for
 *    it. Every miss has to survive the refusal it causes — an event appended
 *    inside the failing path would roll back with it and ops would see nothing.
 *  - **Ownership is checked in this service.** The `rides` RLS policies say the
 *    same thing, but Nest connects as the table owner and the owner bypasses
 *    RLS, so these comparisons are what actually runs today.
 *  - **A completion frees the driver.** One that does not leaves them `on_trip`
 *    forever: invisible to dispatch, unable to go offline, locked out of the
 *    platform until somebody edits the database by hand.
 *
 * RideStateService is the REAL one over a stubbed log, so an illegal move is
 * refused here exactly as it would be in production — and the ride row is
 * written through by the transaction mock, honouring the status guard.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface PrismaMock {
  ride: { findUnique: Mock; findFirst: Mock; findMany: Mock };
  $transaction: Mock;
}

interface TxMock {
  ride: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock };
  driverAvailability: { updateMany: Mock };
  driverProfile: { update: Mock };
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DRIVER_ID = '55555555-5555-4555-8555-555555555555';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const OFFER_ID = '77777777-7777-4777-8777-777777777777';

const PICKUP_OTP = '4821';
const WHERE_I_AM = { lat: 43.6532, lng: -79.3832 };

describe('DriverRidesService', () => {
  let ride: Ride;
  let prisma: PrismaMock;
  let tx: TxMock;
  let events: { append: Mock; listForRide: Mock; replayStatus: Mock };
  let matching: {
    acceptOffer: Mock;
    declineOffer: Mock;
    pendingOffersForDriver: Mock;
  };
  let realtime: { emitRideStatus: jest.Mock };
  let service: DriverRidesService;

  beforeEach(() => {
    ride = rideFixture({ status: 'arrived', driverId: DRIVER_ID, vehicleId: VEHICLE_ID });

    tx = {
      ride: { findUnique: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      driverAvailability: { updateMany: jest.fn() },
      driverProfile: { update: jest.fn() },
    };
    // Write through to the one fixture, honouring the status guard — that
    // compare-and-set is the ride's lost-update control, and a mock that
    // ignored it would pass a test the database would fail.
    tx.ride.updateMany.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string; status?: string }; data: Partial<Ride> };
      if (arg.where.id !== ride.id) return { count: 0 };
      if (arg.where.status !== undefined && arg.where.status !== ride.status) return { count: 0 };
      Object.assign(ride, arg.data);
      return { count: 1 };
    });
    tx.ride.findUnique.mockImplementation(async () => ride);
    tx.ride.findUniqueOrThrow.mockImplementation(async () => ride);
    tx.driverAvailability.updateMany.mockResolvedValue({ count: 1 });
    tx.driverProfile.update.mockResolvedValue({});

    prisma = {
      ride: {
        // One read serves the ownership check (`where` only) and the view
        // (`include`); one fixture keeps the two halves of a case in agreement.
        findUnique: jest.fn().mockImplementation(async (...args: unknown[]) => {
          const arg = args[0] as { where: { id: string }; include?: unknown };
          if (arg.where.id !== RIDE_ID) return null;
          return arg.include ? withParties(ride) : ride;
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (...args: unknown[]) => {
      const run = args[0] as (client: unknown) => Promise<unknown>;
      return run(tx);
    });

    events = {
      append: jest.fn().mockResolvedValue(undefined),
      listForRide: jest.fn().mockResolvedValue([]),
      replayStatus: jest.fn().mockResolvedValue(null),
    };
    matching = {
      acceptOffer: jest.fn(),
      declineOffer: jest.fn(),
      pendingOffersForDriver: jest.fn().mockResolvedValue([]),
    };
    realtime = { emitRideStatus: jest.fn() };

    service = new DriverRidesService(
      prisma as unknown as PrismaService,
      new RideStateService(events as unknown as RideEventsService),
      events as unknown as RideEventsService,
      matching as unknown as MatchingService,
      realtime as unknown as RealtimeService,
    );
  });

  // -------------------------------------------------------------------------
  // The pickup code
  // -------------------------------------------------------------------------

  describe('startTrip', () => {
    it('refuses a wrong code, moves nothing, and records the miss anyway', async () => {
      const error = await refusal(() =>
        service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: '1234', location: WHERE_I_AM }),
      );

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_pickup_code' });
      // An error that narrows a 10,000-value space is a worse error than a
      // vague one, so the real code must not travel back with the refusal.
      expect(JSON.stringify(error.getResponse())).not.toContain(PICKUP_OTP);

      // The trip has not started and the rider has not been told it has.
      expect(ride.status).toBe('arrived');
      expect(ride.startedAt).toBeNull();
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
      expect(realtime.emitRideStatus).not.toHaveBeenCalled();

      // The miss is written on a transaction of its own, precisely because it
      // has to survive the refusal that follows: appended inside the failing
      // path it would roll back and ops would see nothing at all. A driver
      // guessing at codes is the earliest visible signal of fake-ride fraud.
      const [, entry] = appendCall(events, 0);
      expect(entry).toMatchObject({
        rideId: RIDE_ID,
        type: 'ride.pickup_code_rejected',
        fromStatus: 'arrived',
        // Null: this records something that happened TO the ride without moving
        // it, and replayStatus folds past those rather than resetting.
        toStatus: null,
        actorType: 'driver',
        actorId: DRIVER_ID,
      });
      expect(entry.metadata).toEqual({ attempt: 1, location: WHERE_I_AM });
      // The digits that were guessed are deliberately not kept: storing them
      // would build a table of near-misses against live codes for whoever reads
      // the log later, and the fact of the miss is the entire signal.
      expect(JSON.stringify(entry.metadata)).not.toContain('1234');
    });

    it('counts the attempt by replaying the ride log, so it cannot drift', async () => {
      events.listForRide.mockResolvedValue([
        { type: 'ride.arrived' },
        { type: 'ride.pickup_code_rejected' },
        { type: 'ride.pickup_code_rejected' },
      ]);

      await refusal(() => service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: '0000' }));

      expect(appendCall(events, 0)[1].metadata).toMatchObject({ attempt: 3 });
    });

    it('still refuses — with the same code — when the miss could not be logged', async () => {
      // A logging failure must not turn a wrong 4-digit code into a 500: that
      // tells the guesser nothing useful while hiding the miss from the only
      // people who need to see it.
      events.listForRide.mockRejectedValue(new Error('ride_events unreachable'));

      const error = await refusal(() =>
        service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: '1234' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_pickup_code' });
    });

    it('starts the trip on the right code', async () => {
      const view = await service.startTrip(DRIVER_ID, RIDE_ID, {
        pickupOtp: PICKUP_OTP,
        location: WHERE_I_AM,
      });

      expect(ride.status).toBe('in_progress');
      expect(ride.startedAt).toBeInstanceOf(Date);
      expect(view.status).toBe('in_progress');
      // The driver's own response must not echo the code back: this endpoint is
      // reached by whoever is holding the phone.
      expect(view.pickupOtp).toBeNull();

      const [, entry] = appendCall(events, 0);
      expect(entry).toMatchObject({
        type: 'ride.in_progress',
        fromStatus: 'arrived',
        toStatus: 'in_progress',
        actorType: 'driver',
        actorId: DRIVER_ID,
      });
      expect(entry.metadata).toMatchObject({ pickupCodeVerified: true, location: WHERE_I_AM });
      // The rider's screen is driven by these frames, not by polling.
      expect(realtime.emitRideStatus).toHaveBeenCalledWith(RIDE_ID, view);
    });

    it('refuses to start a ride with no code on file', async () => {
      // Letting it through would make the gate optional for any ride that lost
      // its code, which is exactly the ride an attacker would arrange to hold.
      ride.pickupOtp = null;

      const error = await refusal(() =>
        service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: '4821' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'pickup_code_unavailable' });
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to start a trip the driver has not arrived at, even with the right code', async () => {
      // The code is not a bypass for the state machine: `accepted ->
      // in_progress` is not an edge, and the rider is not in the car yet.
      ride.status = 'accepted';

      const error = await refusal(() =>
        service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: PICKUP_OTP }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_transition' });
      expect(ride.status).toBe('accepted');
    });

    it('re-reads inside the transaction so a cancelled ride wins the race', async () => {
      // The code check ran against a row the rider could have cancelled since;
      // the conditional UPDATE settles that, and it has to be given the row the
      // transaction will actually compete with.
      tx.ride.findUnique.mockImplementation(async () => ({
        ...ride,
        status: 'cancelled_by_rider',
      }));

      const error = await refusal(() =>
        service.startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: PICKUP_OTP }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(realtime.emitRideStatus).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  describe('a ride that is not this driver', () => {
    interface ActionCase {
      readonly name: string;
      readonly invoke: () => Promise<unknown>;
    }

    const actions = (svc: () => DriverRidesService): readonly ActionCase[] => [
      { name: 'markArrived', invoke: () => svc().markArrived(DRIVER_ID, RIDE_ID, {}) },
      {
        name: 'startTrip',
        invoke: () => svc().startTrip(DRIVER_ID, RIDE_ID, { pickupOtp: PICKUP_OTP }),
      },
      { name: 'complete', invoke: () => svc().complete(DRIVER_ID, RIDE_ID, {}) },
      {
        name: 'cancel',
        invoke: () => svc().cancel(DRIVER_ID, RIDE_ID, { reason: 'rider_no_show' }),
      },
    ];

    it.each(actions(() => service))('$name is refused with 403', async ({ invoke }: ActionCase) => {
      ride.driverId = OTHER_DRIVER_ID;

      const error = await refusal(invoke);

      // 403 and not 404: the id came from the driver's own trip list or from an
      // offer addressed to them, so "not yours" tells them nothing they could
      // not already work out — and a 404 would send an app holding a stale id
      // into a retry loop against a ride that is perfectly real.
      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'not_your_ride' });

      expect(ride.status).toBe('arrived');
      expect(tx.ride.updateMany).not.toHaveBeenCalled();
      expect(tx.driverAvailability.updateMany).not.toHaveBeenCalled();
      expect(realtime.emitRideStatus).not.toHaveBeenCalled();
      // Not even the pickup-code miss: a stranger must not be able to write
      // into somebody else's ride history by guessing at their code.
      expect(events.append).not.toHaveBeenCalled();
    });

    it.each(actions(() => service))('$name 404s for a ride that does not exist', async ({
      invoke,
    }: ActionCase) => {
      prisma.ride.findUnique.mockResolvedValue(null);
      tx.ride.findUnique.mockResolvedValue(null);

      const error = await refusal(invoke);

      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({ code: 'ride_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  describe('complete', () => {
    beforeEach(() => {
      ride.status = 'in_progress';
      ride.startedAt = new Date('2026-09-12T18:10:00.000Z');
    });

    it('ends the trip, frees the driver and counts the ride', async () => {
      const view = await service.complete(DRIVER_ID, RIDE_ID, {
        location: WHERE_I_AM,
        actualDistanceMeters: 2_650,
      });

      expect(ride.status).toBe('completed');
      expect(ride.completedAt).toBeInstanceOf(Date);
      // Written beside the quoted estimate, never over it: a fare dispute needs
      // both numbers, what the rider was quoted and what the car actually drove.
      expect(ride.actualDistanceMeters).toBe(2_650);
      expect(ride.distanceMeters).toBe(2_400);

      // Straight back into the pool, guarded on THIS ride so a replayed request
      // cannot unassign a trip the driver has since accepted.
      expect(tx.driverAvailability.updateMany).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID, currentRideId: RIDE_ID },
        // `online`, not `offline`: they were online to have been dispatched at
        // all, and a driver finishing a fare expects the next one.
        data: { status: 'online', currentRideId: null },
      });

      // Incremented rather than recomputed: a COUNT over every ride they have
      // ever driven, on the hot path of every completion, to produce a number
      // that only ever goes up by one.
      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: { totalRides: { increment: 1 } },
      });

      expect(appendCall(events, 0)[1]).toMatchObject({
        type: 'ride.completed',
        fromStatus: 'in_progress',
        toStatus: 'completed',
        actorType: 'driver',
      });
      expect(appendCall(events, 0)[1].metadata).toMatchObject({
        actualDistanceMeters: 2_650,
        quotedDistanceMeters: 2_400,
      });
      expect(realtime.emitRideStatus).toHaveBeenCalledWith(RIDE_ID, view);
    });

    it('leaves the measurement column null when the app never tracked one', async () => {
      // Defaulting to the quote would put an estimate in the column reserved
      // for the measurement, and nothing downstream could tell them apart again.
      await service.complete(DRIVER_ID, RIDE_ID, {});

      const { data } = updateArgs(tx);
      expect(data).not.toHaveProperty('actualDistanceMeters');
      expect(ride.actualDistanceMeters).toBeNull();
    });

    it('frees nobody when the completion itself is refused', async () => {
      // The transition runs first on purpose: a release that happened anyway
      // would put a driver back in the pool with a passenger in the car.
      ride.status = 'arrived';

      const error = await refusal(() => service.complete(DRIVER_ID, RIDE_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_transition' });
      expect(tx.driverAvailability.updateMany).not.toHaveBeenCalled();
      expect(tx.driverProfile.update).not.toHaveBeenCalled();
    });

    it('does not roll a finished trip back because the driver was already released', async () => {
      // Ops may have force-released the driver, or the row may have been
      // reassigned. Worth a log line, never worth undoing a completed fare.
      tx.driverAvailability.updateMany.mockResolvedValue({ count: 0 });

      const view = await service.complete(DRIVER_ID, RIDE_ID, {});

      expect(view.status).toBe('completed');
      expect(tx.driverProfile.update).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Arrival and driver cancellation
  // -------------------------------------------------------------------------

  describe('markArrived', () => {
    it('walks both edges when the driver never reported setting off', async () => {
      // `accepted -> arrived` is absent from RIDE_TRANSITIONS, and a two-block
      // pickup (or an app that was backgrounded) is ordinary rather than
      // exotic. Rather than widen the contract, the ride is walked over both
      // edges inside one transaction.
      ride.status = 'accepted';

      const view = await service.markArrived(DRIVER_ID, RIDE_ID, { location: WHERE_I_AM });

      expect(view.status).toBe('arrived');
      expect(events.append).toHaveBeenCalledTimes(2);
      expect(appendCall(events, 0)[1]).toMatchObject({
        fromStatus: 'accepted',
        toStatus: 'driver_arriving',
      });
      // Marked as inferred, so a later look at pickup times can tell an
      // observation from bookkeeping.
      expect(appendCall(events, 0)[1].metadata).toMatchObject({ inferred: true });
      expect(appendCall(events, 1)[1]).toMatchObject({
        fromStatus: 'driver_arriving',
        toStatus: 'arrived',
      });
      // One transaction: a history that stops halfway is worse than no history.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('records where the driver said they were without fencing them out', async () => {
      // A geofence on "arrived" sounds right and is not: GPS in a downtown
      // canyon is routinely 100m out, and refusing a real arrival strands a
      // driver who has done nothing wrong. Keeping the claim is what makes the
      // dispute answerable afterwards.
      ride.status = 'driver_arriving';

      await service.markArrived(DRIVER_ID, RIDE_ID, { location: { lat: 1, lng: 2 } });

      expect(appendCall(events, 0)[1].metadata).toEqual({ location: { lat: 1, lng: 2 } });
      expect(ride.status).toBe('arrived');
    });
  });

  describe('cancel', () => {
    it('ends the ride, releases the driver and records the stage they bailed at', async () => {
      ride.status = 'driver_arriving';

      await service.cancel(DRIVER_ID, RIDE_ID, { reason: 'rider_no_show', note: 'Waited 8 min.' });

      expect(ride.status).toBe('cancelled_by_driver');
      expect(ride.cancelledBy).toBe('driver');
      expect(ride.cancelReason).toBe('rider_no_show');

      const [, entry] = appendCall(events, 0);
      // Same event name as the rider's cancellation: who did it is already on
      // the row in `cancelled_by`, and one name means one query answers "how
      // many trips were cancelled".
      expect(entry.type).toBe('ride.cancelled');
      expect(entry.metadata).toMatchObject({
        reason: 'rider_no_show',
        note: 'Waited 8 min.',
        // The stage is what a cancellation-rate policy is written against, and
        // `status` stops being able to tell you once the row has moved on.
        cancelledFrom: 'driver_arriving',
      });

      // A driver whose rider never showed up is available again immediately;
      // leaving them `on_trip` would charge them for the no-show.
      expect(tx.driverAvailability.updateMany).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID, currentRideId: RIDE_ID },
        data: { status: 'online', currentRideId: null },
      });
    });

    it('refuses once the rider is in the car', async () => {
      // Once the wheels are turning the trip either completes or becomes a
      // support case with a refund attached. It is not a driver-side undo.
      ride.status = 'in_progress';

      const error = await refusal(() =>
        service.cancel(DRIVER_ID, RIDE_ID, { reason: 'vehicle_issue' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'invalid_transition' });
      expect(ride.status).toBe('in_progress');
      expect(tx.driverAvailability.updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The offer card
  // -------------------------------------------------------------------------

  describe('currentOffer', () => {
    beforeEach(() => {
      ride = rideFixture({ status: 'searching', driverId: null });
      matching.pendingOffersForDriver.mockResolvedValue([offerWire()]);
    });

    it('renders the card with earnings that add back up to the fare', async () => {
      const card = await service.currentOffer(DRIVER_ID);

      expect(card).not.toBeNull();
      const commission = (ride.fareCents ?? 0) - (card?.driverEarningsCents ?? 0);
      // The commission is rounded and then subtracted, rather than multiplying
      // the fare by (1 - rate): the two halves then always add back up exactly,
      // with no half-cent appearing between the driver's statement and the
      // platform's ledger.
      expect(card?.driverEarningsCents).toBe(1_028);
      expect((card?.driverEarningsCents ?? 0) + commission).toBe(ride.fareCents);
      // Computed server-side from expires_at, so a device with a slow clock —
      // or one deliberately holding its countdown open — cannot show a timer
      // for an offer the server has already let go.
      expect(card?.secondsRemaining).toBeGreaterThan(0);
      expect(card?.secondsRemaining).toBeLessThanOrEqual(20);
    });

    it('does not render an offer whose ride another driver is already on', async () => {
      // A pending row whose ride has moved on: the revoke that should have
      // retired it was lost and the sweeper has not caught up. Rendering it
      // would put a countdown in front of a driver for somebody else's trip.
      ride.driverId = OTHER_DRIVER_ID;
      ride.status = 'accepted';

      await expect(service.currentOffer(DRIVER_ID)).resolves.toBeNull();
    });

    it('does not render an offer for a ride that has ended', async () => {
      ride.status = 'cancelled_by_rider';

      await expect(service.currentOffer(DRIVER_ID)).resolves.toBeNull();
    });

    it('answers null rather than raising when there is nothing to answer', async () => {
      // The app calls this on launch and after every reconnect; null is the
      // ordinary answer, not an error.
      matching.pendingOffersForDriver.mockResolvedValue([]);

      await expect(service.currentOffer(DRIVER_ID)).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Accept — delegated, but the rider still has to be told
  // -------------------------------------------------------------------------

  describe('acceptOffer', () => {
    it('delegates the claim and announces the match to the rider', async () => {
      // Accept is where two drivers race for one row, and that race is settled
      // by a unique index inside the matcher's transaction. A second claim
      // here — even a well-meaning pre-check — would be a second place that can
      // get it wrong.
      ride = rideFixture({ status: 'accepted', driverId: DRIVER_ID, vehicleId: VEHICLE_ID });
      matching.acceptOffer.mockResolvedValue({
        offer: offerWire({ status: 'accepted' }),
        rideId: RIDE_ID,
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
        pickupAddress: ride.pickupAddress,
        pickupDistanceMeters: 640,
        pickupEtaSeconds: 100,
      });

      const trip = await service.acceptOffer(DRIVER_ID, OFFER_ID, { location: WHERE_I_AM });

      expect(matching.acceptOffer).toHaveBeenCalledWith(DRIVER_ID, OFFER_ID, {
        location: WHERE_I_AM,
      });
      // The navigation screen opens on the pickup and needs the approach the
      // matcher recomputed — numbers that exist nowhere on the ride row.
      expect(trip.pickupDistanceMeters).toBe(640);
      expect(trip.pickupEtaSeconds).toBe(100);
      // The rider has been watching a spinner.
      expect(realtime.emitRideStatus).toHaveBeenCalledWith(RIDE_ID, trip.ride);
      expect(trip.ride.pickupOtp).toBeNull();
    });

    it('tells the rider nothing when the claim was refused', async () => {
      matching.acceptOffer.mockRejectedValue(
        new HttpException({ code: 'offer_already_taken', message: 'Gone.' }, HttpStatus.CONFLICT),
      );

      await refusal(() => service.acceptOffer(DRIVER_ID, OFFER_ID, {}));

      expect(realtime.emitRideStatus).not.toHaveBeenCalled();
    });

    it('says nothing to the rider about a decline', async () => {
      // From the rider's side a decline is not an event, it is the absence of
      // one: the ride stays `searching` and the next wave goes out. Telling
      // them "a driver said no" is an anxiety generator with no action attached.
      matching.declineOffer.mockResolvedValue(offerWire({ status: 'declined' }));

      await service.declineOffer(DRIVER_ID, OFFER_ID, { reason: 'too_far' });

      expect(realtime.emitRideStatus).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateArgs(tx: TxMock): { where: Record<string, unknown>; data: Record<string, unknown> } {
  const call = tx.ride.updateMany.mock.calls.at(-1);
  if (!call) throw new Error('Expected the ride row to have been updated.');
  return call[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

function appendCall(
  events: { append: Mock },
  index: number,
): [unknown, RideEventInput & { metadata?: Record<string, unknown> | null }] {
  const call = events.append.mock.calls[index];
  if (!call) throw new Error(`Expected at least ${index + 1} event(s) to have been appended.`);
  return call as [unknown, RideEventInput];
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

function offerWire(overrides: Partial<RideOffer> = {}): RideOffer {
  return {
    id: OFFER_ID as RideOffer['id'],
    rideId: RIDE_ID as RideOffer['rideId'],
    driverId: DRIVER_ID as RideOffer['driverId'],
    round: 1,
    status: 'pending',
    distanceMeters: 1_200,
    etaSeconds: 187,
    offeredAt: new Date().toISOString() as RideOffer['offeredAt'],
    expiresAt: new Date(Date.now() + 20_000).toISOString() as RideOffer['expiresAt'],
    respondedAt: null,
    declineReason: null,
    ...overrides,
  };
}

/** The ride as the view read returns it — the driver's name and car are joins. */
function withParties(row: Ride): unknown {
  return {
    ...row,
    driver: row.driverId
      ? {
          userId: row.driverId,
          ratingSum: 96,
          ratingCount: 20,
          user: { fullName: 'Amélie Roy' },
        }
      : null,
    vehicle: row.vehicleId
      ? {
          id: row.vehicleId,
          make: 'Toyota',
          model: 'Corolla',
          year: 2021,
          color: 'white',
          plate: 'CGBC 123',
        }
      : null,
  };
}

function rideFixture(overrides: Partial<Ride> = {}): Ride {
  const now = new Date('2026-09-12T18:00:00.000Z');
  return {
    id: RIDE_ID,
    riderId: RIDER_ID,
    driverId: DRIVER_ID,
    status: 'accepted',
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
    pickupOtp: PICKUP_OTP,
    actualDistanceMeters: null,
    vehicleId: VEHICLE_ID,
    dispatchRound: 1,
    requestedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
