import { BadRequestException } from '@nestjs/common';
import { RT_CLIENT_EVENTS, RT_SERVER_EVENTS } from '@uride/types';
import { _resetEnvCache } from '../config/env';
import {
  MAX_PLAUSIBLE_SPEED_MPS,
  MIN_ETA_SPEED_MPS,
  SPEED_HISTORY_STALE_MS,
  effectiveSpeedMps,
  estimateLiveEta,
  foldSpeedSample,
  haversineMeters,
  kmhToMps,
  liveTargetFor,
  type LiveEtaModel,
  type SpeedEstimate,
} from './live-eta';
import { RealtimeGateway, loadLiveTrackingConfig } from './realtime.gateway';
import { createRtAuthMiddleware, driverRoom, extractSocketToken, rideRoom } from './rt-auth';
import type { RtNamespace, RtSocket } from './rt-auth';
import type { RealtimeService } from './realtime.service';
import type { RequestPrincipal } from '../common/auth/current-user.decorator';
import type { IdentityProvider } from '../common/identity/identity-provider.interface';
import type { SessionService } from '../common/session/session.service';
import type { PrismaService } from '../common/prisma/prisma.module';
import type { GeoService } from '../modules/geo/geo.service';

/**
 * The socket namespace is the one entry point into the platform that does not
 * pass through JwtAuthGuard, so everything that makes the REST guard
 * trustworthy has to be reproduced here — and that is what this file checks.
 *
 * Three refusals carry the whole boundary, and each of them fails open if it is
 * wrong:
 *
 *  - an unauthenticated socket never finishes its handshake, and is hung up on
 *    if it somehow reaches a handler anyway;
 *  - a client may send any rideId it likes, so room membership is decided by
 *    the database and never by the claim — granted wrongly, it streams a
 *    stranger's live position and every state change of their trip;
 *  - only a driver may publish a position, and only onto a ride that is theirs
 *    and running right now.
 *
 * Live tracking adds two promises on top: the rider's map is fed at most once
 * per broadcast window whatever the phone sends, and the ride row behind it is
 * read once per window rather than once per GPS fix — without either of those
 * weakening "only while the trip is running".
 *
 * The sockets are hand-built objects rather than a real socket.io client:
 * what is under test is the gateway's decisions, and a live server would only
 * add a transport between the assertion and the thing being asserted.
 */

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface SocketMock {
  id: string;
  data: Partial<RtSocket['data']>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  onAnyOutgoing: jest.Mock;
  handshake: { auth: Record<string, unknown>; headers: Record<string, unknown>; query?: unknown };
}

type OutgoingListener = (event: string, ...args: unknown[]) => void;

interface BroadcastPayload {
  rideId: string;
  driverId: string;
  location: { lat: number; lng: number };
  target: 'pickup' | 'dropoff' | null;
  distanceMeters: number | null;
  etaSeconds: number | null;
  recordedAt: string;
}

const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RIDE_ID = '99999999-9999-4999-8999-999999999999';
const RIDER_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DRIVER_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '55555555-5555-4555-8555-555555555555';

/** Where the driver is. Toronto City Hall. */
const TORONTO = { lat: 43.6532, lng: -79.3832 };
/** ~1.5 km north-west of the driver. */
const PICKUP = { lat: 43.6629, lng: -79.3957 };
/** ~0.9 km south of the driver. Union Station. */
const DROPOFF = { lat: 43.6453, lng: -79.3806 };

const BROADCAST_MS = 2_000;
const CONTEXT_TTL_MS = 15_000;
const DETOUR_FACTOR = 1.35;
const CITY_SPEED_KMH = 28;
const MODEL: LiveEtaModel = { detourFactor: DETOUR_FACTOR, citySpeedMps: kmhToMps(CITY_SPEED_KMH) };

describe('RealtimeGateway', () => {
  let identity: { verifyAccessToken: Mock; isAvailable: jest.Mock };
  let sessions: { isAccessJtiDenied: Mock };
  let prisma: { ride: { findUnique: Mock } };
  let geo: { recordLocation: Mock };
  let realtime: { bindServer: jest.Mock; emitDriverLocation: jest.Mock };
  let gateway: RealtimeGateway;

  beforeAll(() => {
    // The gateway reads its live tracking dials in the constructor, so the
    // environment has to exist before the first instance does. Spelled out so
    // the window, TTL and ETA assertions below read the numbers they assert.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://uride:uride@localhost:5432/uride',
      DIRECT_URL: 'postgresql://uride:uride@localhost:5432/uride',
      REDIS_URL: 'redis://localhost:6379',
      JWT_LOCAL_SECRET: 'a-test-only-secret-of-at-least-32-characters',
      MAPS_PROVIDER: 'none',
      RT_RIDER_BROADCAST_MS: String(BROADCAST_MS),
      RT_RIDE_CONTEXT_TTL_MS: String(CONTEXT_TTL_MS),
      ROUTE_DETOUR_FACTOR: String(DETOUR_FACTOR),
      ROUTE_AVERAGE_SPEED_KMH: String(CITY_SPEED_KMH),
    });
    _resetEnvCache();
  });

  beforeEach(() => {
    identity = {
      verifyAccessToken: jest.fn().mockResolvedValue(principal()),
      isAvailable: jest.fn().mockReturnValue(true),
    };
    sessions = { isAccessJtiDenied: jest.fn().mockResolvedValue(false) };
    prisma = {
      ride: {
        findUnique: jest.fn().mockResolvedValue(rideRow({ status: 'in_progress' })),
      },
    };
    geo = {
      recordLocation: jest.fn().mockResolvedValue({
        pointsRecorded: 1,
        availabilityUpdated: true,
        latestRecordedAt: new Date().toISOString(),
      }),
    };
    realtime = { bindServer: jest.fn(), emitDriverLocation: jest.fn() };

    gateway = new RealtimeGateway(
      identity as unknown as IdentityProvider,
      sessions as unknown as SessionService,
      prisma as unknown as PrismaService,
      geo as unknown as GeoService,
      realtime as unknown as RealtimeService,
    );
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  /** Every location broadcast so far, as the rider received it. */
  const broadcasts = (): BroadcastPayload[] =>
    realtime.emitDriverLocation.mock.calls.map((call) => call[1] as BroadcastPayload);

  /**
   * The gateway's outgoing-packet listener, obtained the way production gets it:
   * by connecting a socket. Call after any jest.useFakeTimers(), so the expiry
   * timer this creates is cleared by the same clock that set it.
   */
  const outgoingListener = (): OutgoingListener => {
    const socket = socketMock({
      id: 'sock-observer',
      data: { principal: principal(), isDriver: false },
    });
    gateway.handleConnection(socket as unknown as RtSocket);
    clearTimeout(socket.data.expiryTimer);
    return socket.onAnyOutgoing.mock.calls[0][0] as OutgoingListener;
  };

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('an unauthenticated socket', () => {
    it('never finishes its handshake', async () => {
      // Refused in middleware rather than in handleConnection: a socket stopped
      // here never joins a room, never reaches a message handler and never
      // appears in namespace.sockets.
      const namespace = { use: jest.fn() };
      gateway.afterInit(namespace as unknown as RtNamespace);
      expect(namespace.use).toHaveBeenCalledTimes(1);
      // The publish API is bound to the same namespace the middleware guards.
      expect(realtime.bindServer).toHaveBeenCalledWith(namespace);

      const middleware = namespace.use.mock.calls[0][0] as (
        socket: RtSocket,
        next: (err?: Error) => void,
      ) => Promise<void>;
      const socket = socketMock({ data: {} });
      const next = jest.fn();

      await middleware(socket as unknown as RtSocket, next);

      expect(identity.verifyAccessToken).not.toHaveBeenCalled();
      expect(socket.data.principal).toBeUndefined();
      const [error] = next.mock.calls[0] as [{ data?: { code?: string } }];
      // `data` is where the machine-readable code rides to the client's
      // connect_error listener, so the apps branch on it as they do on a REST
      // code instead of reconnecting forever with a dead token.
      expect(error.data).toMatchObject({ code: 'auth_required' });
    });

    it('is hung up on if it ever reaches handleConnection', async () => {
      // socket.io initialises `data` to an empty object, so this is a real
      // runtime check: were the middleware ever bypassed, the correct response
      // is to hang up rather than to serve the socket.
      const socket = socketMock({ data: {} });

      gateway.handleConnection(socket as unknown as RtSocket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.onAnyOutgoing).not.toHaveBeenCalled();
    });

    it('is refused when its token is invalid, without saying why', async () => {
      identity.verifyAccessToken.mockRejectedValue(new Error('signature mismatch'));
      const { next, error } = await handshake(identity, sessions, socketMock({ token: 'nope' }));

      expect(next).toHaveBeenCalled();
      expect(error?.data).toMatchObject({ code: 'auth_invalid' });
      // The verifier's message is useful to us and free reconnaissance for
      // whoever is probing the handshake, so it goes to the log, not the wire.
      expect(JSON.stringify(error?.data)).not.toContain('signature mismatch');
    });

    it('is refused when the session has been signed out', async () => {
      // Logout and family revocation have to close live sockets too; otherwise
      // signing out of a stolen session leaves the thief streaming happily
      // until the access token expires.
      sessions.isAccessJtiDenied.mockResolvedValue(true);

      const { error } = await handshake(identity, sessions, socketMock({ token: 'valid' }));

      expect(error?.data).toMatchObject({ code: 'token_revoked' });
    });

    it('is admitted with a valid token, carrying the same principal REST uses', async () => {
      const socket = socketMock({ token: 'valid' });

      const { error } = await handshake(identity, sessions, socket);

      expect(error).toBeUndefined();
      expect(socket.data.principal).toMatchObject({ userId: RIDER_ID });
      expect(socket.data.isDriver).toBe(false);
    });

    it('does not accept a token from the query string', () => {
      // Query strings are copied verbatim into proxy access logs, browser
      // history and error trackers, and socket.io's `auth` payload removes the
      // browser limitation that made the query string tempting.
      const socket = socketMock({});
      socket.handshake.query = { token: 'leaked-in-every-access-log' };

      expect(extractSocketToken(socket.handshake as unknown as RtSocket['handshake'])).toBeNull();
    });
  });

  describe('a socket whose credential runs out', () => {
    it('is closed when the access token expires, not left open for days', async () => {
      // An access token lives 15 minutes but a socket can live for days, so a
      // connection authenticated once would otherwise outlive the credential
      // that opened it — including past a logout.
      jest.useFakeTimers();
      const socket = socketMock({ data: { principal: principal({ ttlSeconds: 5 }), isDriver: false } });

      gateway.handleConnection(socket as unknown as RtSocket);
      expect(socket.disconnect).not.toHaveBeenCalled();

      jest.advanceTimersByTime(6_000);

      expect(socket.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'token_expired',
        message: expect.stringContaining('expired'),
      });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('is closed immediately when the token was already past its expiry', () => {
      const socket = socketMock({
        data: { principal: principal({ ttlSeconds: -1 }), isDriver: false },
      });

      gateway.handleConnection(socket as unknown as RtSocket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('joins a driver to their own room on connect, and clears the timer on disconnect', () => {
      const socket = socketMock({ data: { principal: driverPrincipal(), isDriver: true } });

      gateway.handleConnection(socket as unknown as RtSocket);

      // Joined on connect rather than on going online: the room is only ever
      // addressed by dispatch, so an offline driver's membership costs one map
      // entry — while a driver whose socket reconnected a second before an
      // offer was made would otherwise miss it.
      expect(socket.join).toHaveBeenCalledWith(driverRoom(DRIVER_ID));
      // Every authenticated socket reports the ride:status frames it is sent;
      // that is how live tracking learns a trip ended without a database read.
      expect(socket.onAnyOutgoing).toHaveBeenCalledWith(expect.any(Function));

      gateway.handleDisconnect(socket as unknown as RtSocket);
      expect(socket.data.expiryTimer).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Ride rooms
  // -------------------------------------------------------------------------

  describe('ride:subscribe', () => {
    it('refuses a ride the caller is neither the rider nor the driver of', async () => {
      const socket = connected({ userId: STRANGER_ID });

      await gateway.onRideSubscribe(socket as unknown as RtSocket, { rideId: RIDE_ID });

      // Granted, this subscription would stream that stranger's driver's live
      // position and every state change of the trip.
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'not_your_ride',
        message: expect.any(String),
      });
    });

    it('answers a ride that does not exist exactly as it answers one that is not yours', async () => {
      // Enumerating ride ids must not be possible by watching which refusal
      // comes back.
      const stranger = connected({ userId: STRANGER_ID });
      await gateway.onRideSubscribe(stranger as unknown as RtSocket, { rideId: RIDE_ID });
      const refusedForOwnership = stranger.emit.mock.calls[0];

      prisma.ride.findUnique.mockResolvedValue(null);
      const rider = connected({ userId: RIDER_ID });
      await gateway.onRideSubscribe(rider as unknown as RtSocket, { rideId: OTHER_RIDE_ID });

      expect(rider.emit.mock.calls[0]).toEqual(refusedForOwnership);
      expect(rider.join).not.toHaveBeenCalled();
    });

    it('admits the rider and the assigned driver, and nobody else', async () => {
      const rider = connected({ userId: RIDER_ID });
      await gateway.onRideSubscribe(rider as unknown as RtSocket, { rideId: RIDE_ID });
      expect(rider.join).toHaveBeenCalledWith(rideRoom(RIDE_ID));

      const driver = connected({ userId: DRIVER_ID, isDriver: true });
      await gateway.onRideSubscribe(driver as unknown as RtSocket, { rideId: RIDE_ID });
      expect(driver.join).toHaveBeenCalledWith(rideRoom(RIDE_ID));

      // Re-checked against the database on every subscribe rather than cached:
      // a subscribe happens once per ride per client and is nowhere near hot
      // enough to be worth a stale answer.
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(2);
    });

    it('rejects a malformed payload before it reaches the database', async () => {
      const socket = connected({ userId: RIDER_ID });

      await gateway.onRideSubscribe(socket as unknown as RtSocket, { rideId: 'not-a-uuid' });

      expect(prisma.ride.findUnique).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        RT_SERVER_EVENTS.error,
        expect.objectContaining({ code: 'validation_error' }),
      );
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('lets anyone leave, since leaving needs no authorisation', async () => {
      const socket = connected({ userId: STRANGER_ID });

      await gateway.onRideUnsubscribe(socket as unknown as RtSocket, { rideId: RIDE_ID });

      expect(socket.leave).toHaveBeenCalledWith(rideRoom(RIDE_ID));
      expect(prisma.ride.findUnique).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Location frames
  // -------------------------------------------------------------------------

  describe('driver:location', () => {
    it('refuses a frame from a socket without the driver role', async () => {
      const socket = connected({ userId: RIDER_ID, isDriver: false });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: TORONTO,
        rideId: RIDE_ID,
      });

      expect(socket.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'forbidden',
        message: expect.stringContaining('driver'),
      });
      // Nothing stored and nothing broadcast: a rider's phone must not be able
      // to move the car on somebody's map.
      expect(geo.recordLocation).not.toHaveBeenCalled();
      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('stores a driver position and shows it on their active ride, with distance and ETA', async () => {
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: TORONTO,
        headingDegrees: 270,
        speedMps: 12,
        rideId: RIDE_ID,
      });

      expect(geo.recordLocation).toHaveBeenCalledWith(
        DRIVER_ID,
        { location: TORONTO, headingDegrees: 270, speedMps: 12 },
        RIDE_ID,
      );
      const [rideId] = realtime.emitDriverLocation.mock.calls[0] as [string];
      const [payload] = broadcasts();
      expect(rideId).toBe(RIDE_ID);
      expect(payload?.driverId).toBe(DRIVER_ID);
      // In progress, so the driver is heading for the dropoff. Computed in
      // memory from the live position — straight line times the detour factor
      // at the city speed, since one speed sample only starts the clock.
      expect(payload?.target).toBe('dropoff');
      expect(payload?.distanceMeters).toBe(expectedDistance(TORONTO, DROPOFF));
      expect(payload?.etaSeconds).toBe(expectedCityEta(TORONTO, DROPOFF));
      // Server clock, not the device's: a phone with a skewed clock must not be
      // able to stamp a position into the rider's future.
      expect(Date.parse(payload?.recordedAt ?? '')).toBeLessThanOrEqual(Date.now());
    });

    it('targets the pickup until the trip starts', async () => {
      prisma.ride.findUnique.mockResolvedValue(rideRow({ status: 'driver_arriving' }));
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: TORONTO,
        rideId: RIDE_ID,
      });

      expect(broadcasts()[0]).toMatchObject({
        target: 'pickup',
        distanceMeters: expectedDistance(TORONTO, PICKUP),
        etaSeconds: expectedCityEta(TORONTO, PICKUP),
      });
    });

    it('refuses the ride claim of a driver who is not on that ride, but keeps the ping', async () => {
      prisma.ride.findUnique.mockResolvedValue(rideRow({ driverId: STRANGER_ID }));
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: TORONTO,
        rideId: RIDE_ID,
      });

      expect(socket.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'not_your_ride',
        message: expect.any(String),
      });
      // The position is still legitimate fleet telemetry and dispatch wants it,
      // so it is stored unattributed — the claim is what was refused.
      expect(geo.recordLocation).toHaveBeenCalledWith(
        DRIVER_ID,
        expect.objectContaining({ location: TORONTO }),
        undefined,
      );
      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('does not broadcast on a ride whose row says the trip is over', async () => {
      prisma.ride.findUnique.mockResolvedValue(rideRow({ status: 'completed' }));
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: TORONTO,
        rideId: RIDE_ID,
      });

      expect(geo.recordLocation).toHaveBeenCalled();
      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('stores an unattributed ping with no broadcast when no ride is named', async () => {
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, { location: TORONTO });

      expect(prisma.ride.findUnique).not.toHaveBeenCalled();
      expect(geo.recordLocation).toHaveBeenCalledWith(DRIVER_ID, expect.anything(), undefined);
      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('answers a storage failure on the socket instead of throwing', async () => {
      // An unhandled throw inside a handler takes down the rxjs subscription
      // Nest built for this event, silently deafening the socket to every
      // subsequent frame.
      geo.recordLocation.mockRejectedValue(
        new BadRequestException({ code: 'ping_too_old', message: 'That fix is too old.' }),
      );
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await expect(
        gateway.onDriverLocation(socket as unknown as RtSocket, { location: TORONTO }),
      ).resolves.toBeUndefined();

      // The same { code, message } body the REST ping route would have
      // returned, so a failure reads identically on either transport.
      expect(socket.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'ping_too_old',
        message: 'That fix is too old.',
      });
    });

    it('keeps the ping but shows it to nobody when the ride cannot be read', async () => {
      prisma.ride.findUnique.mockRejectedValue(new Error('connection pool timeout'));
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await expect(
        gateway.onDriverLocation(socket as unknown as RtSocket, {
          location: TORONTO,
          rideId: RIDE_ID,
        }),
      ).resolves.toBeUndefined();

      // Unverified is treated like refused: the position still reaches the live
      // index, and no rider sees a position nobody could vouch for.
      expect(geo.recordLocation).toHaveBeenCalledWith(DRIVER_ID, expect.anything(), undefined);
      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('rejects a malformed frame', async () => {
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location: { lat: 91, lng: -79.38 },
      });

      expect(socket.emit).toHaveBeenCalledWith(
        RT_SERVER_EVENTS.error,
        expect.objectContaining({ code: 'validation_error' }),
      );
      expect(geo.recordLocation).not.toHaveBeenCalled();
    });

    it('throttles a socket that streams faster than any real app does', async () => {
      const socket = connected({ userId: DRIVER_ID, isDriver: true });

      for (let i = 0; i < 20; i += 1) {
        await gateway.onDriverLocation(socket as unknown as RtSocket, { location: TORONTO });
      }

      // The burst allowance absorbs a reconnect flush; a client emitting in a
      // loop is what the limiter exists for.
      expect(geo.recordLocation.mock.calls.length).toBeLessThanOrEqual(9);
      const warnings = socket.emit.mock.calls.filter(
        (call) => (call[1] as { code?: string }).code === 'rate_limited',
      );
      // Replying to every dropped frame would turn a client stuck in a send
      // loop into an amplifier pointed back at us.
      expect(warnings.length).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Live tracking — coalescing, the ride cache, and the privacy edge
  // -------------------------------------------------------------------------

  describe('live tracking', () => {
    const frameAt = async (
      socket: SocketMock,
      location: { lat: number; lng: number },
      extra: { speedMps?: number } = {},
    ): Promise<void> => {
      await gateway.onDriverLocation(socket as unknown as RtSocket, {
        location,
        rideId: RIDE_ID,
        ...extra,
      });
    };

    /** A point `metres` north of the driver's start, so each frame is distinguishable. */
    const north = (metres: number): { lat: number; lng: number } => ({
      lat: TORONTO.lat + metres / 111_195,
      lng: TORONTO.lng,
    });

    it('sends a 2 Hz phone to the rider at most once per window, always the newest frame', async () => {
      jest.useFakeTimers();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, north(0));
      // A quiet window opens immediately: the rider is not made to wait for
      // the first position.
      expect(broadcasts()).toHaveLength(1);

      jest.advanceTimersByTime(500);
      await frameAt(driver, north(10));
      jest.advanceTimersByTime(500);
      await frameAt(driver, north(20));
      jest.advanceTimersByTime(500);
      await frameAt(driver, north(30));

      // Three more frames inside the window, nothing more sent — yet all three
      // were stored: coalescing is a fan-out decision, not a storage one.
      expect(broadcasts()).toHaveLength(1);
      expect(geo.recordLocation).toHaveBeenCalledTimes(4);
      // One trailing timer per ride, however many frames are waiting on it.
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(500);

      expect(broadcasts()).toHaveLength(2);
      expect(broadcasts()[1]?.location).toEqual(north(30));

      // Nothing waiting, so the trailing edge leaves nothing behind.
      jest.advanceTimersByTime(BROADCAST_MS * 3);
      expect(broadcasts()).toHaveLength(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reads the ride row once per cache window, not once per frame', async () => {
      jest.useFakeTimers();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      for (let i = 0; i < 6; i += 1) {
        await frameAt(driver, north(i * 10));
        jest.advanceTimersByTime(2_000);
      }
      // Per-frame reads would put a Postgres round trip back beside every GPS
      // fix, which is the load the Redis ping path exists to remove.
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(CONTEXT_TTL_MS);
      await frameAt(driver, north(100));

      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(2);
    });

    it('shares one read between frames that arrive while it is out', async () => {
      const row = deferred<unknown>();
      prisma.ride.findUnique.mockReturnValueOnce(row.promise);
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      const first = frameAt(driver, north(0));
      const second = frameAt(driver, north(10));
      row.resolve(rideRow({ status: 'in_progress' }));
      await Promise.all([first, second]);

      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);
      expect(geo.recordLocation).toHaveBeenNthCalledWith(1, DRIVER_ID, expect.anything(), RIDE_ID);
      expect(geo.recordLocation).toHaveBeenNthCalledWith(2, DRIVER_ID, expect.anything(), RIDE_ID);
    });

    it('stops the moment the trip ends, dropping the frame waiting for its window', async () => {
      jest.useFakeTimers();
      const observe = outgoingListener();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, north(0));
      jest.advanceTimersByTime(500);
      await frameAt(driver, north(10));
      expect(broadcasts()).toHaveLength(1);

      // The trip service announces completion to the ride room. No grace
      // period: the position queued a moment earlier belongs to a trip that is
      // over and must not reach the rider after it.
      observe(RT_SERVER_EVENTS.rideStatus, rideSummary({ status: 'completed' }));
      // Cleaned up there and then, not left to fire and find nothing to do.
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(driver, north(20));
      jest.advanceTimersByTime(BROADCAST_MS);

      expect(broadcasts()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
      // Learnt from the broadcast itself — no re-read was needed to find out.
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);
      // The ping path is untouched: positions are still stored.
      expect(geo.recordLocation).toHaveBeenCalledTimes(3);
    });

    it('switches the target to the dropoff as soon as the trip starts', async () => {
      jest.useFakeTimers();
      prisma.ride.findUnique.mockResolvedValue(rideRow({ status: 'arrived' }));
      const observe = outgoingListener();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, PICKUP);
      expect(broadcasts()[0]?.target).toBe('pickup');
      expect(broadcasts()[0]?.distanceMeters).toBe(0);

      observe(RT_SERVER_EVENTS.rideStatus, rideSummary({ status: 'in_progress' }));
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(driver, PICKUP);

      expect(broadcasts()[1]).toMatchObject({
        target: 'dropoff',
        distanceMeters: expectedDistance(PICKUP, DROPOFF),
      });
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);
    });

    it('cannot be revived by a read that was already out when the trip ended', async () => {
      const observe = outgoingListener();
      const row = deferred<unknown>();
      prisma.ride.findUnique.mockReturnValueOnce(row.promise);
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      const pending = frameAt(driver, north(0));
      // Completion commits and is announced while the read is in flight; the
      // read then comes back with the row as it was before.
      observe(RT_SERVER_EVENTS.rideStatus, rideSummary({ status: 'completed' }));
      row.resolve(rideRow({ status: 'in_progress' }));
      await pending;

      expect(realtime.emitDriverLocation).not.toHaveBeenCalled();
    });

    it('stops showing a driver who was reassigned off the ride', async () => {
      jest.useFakeTimers();
      const observe = outgoingListener();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, north(0));
      expect(broadcasts()).toHaveLength(1);

      observe(
        RT_SERVER_EVENTS.rideStatus,
        rideSummary({ status: 'accepted', driverId: OTHER_DRIVER_ID }),
      );
      prisma.ride.findUnique.mockResolvedValue(rideRow({ driverId: OTHER_DRIVER_ID }));
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(driver, north(10));

      expect(broadcasts()).toHaveLength(1);
      expect(driver.emit).toHaveBeenCalledWith(RT_SERVER_EVENTS.error, {
        code: 'not_your_ride',
        message: expect.any(String),
      });
    });

    it('re-checks a reassigned driver’s claim within a window even if nobody announced it', async () => {
      jest.useFakeTimers();
      const previous = connected({ userId: DRIVER_ID, isDriver: true, socketId: 'sock-previous' });
      const next = connected({ userId: OTHER_DRIVER_ID, isDriver: true, socketId: 'sock-next' });

      await frameAt(previous, north(0));
      // Reassigned with no ride:status reaching this process.
      prisma.ride.findUnique.mockResolvedValue(rideRow({ driverId: OTHER_DRIVER_ID }));

      // Straight away the cached answer stands: a disagreeing claim does not get
      // to buy a read per frame.
      await frameAt(next, north(5));
      expect(next.emit).toHaveBeenCalledWith(
        RT_SERVER_EVENTS.error,
        expect.objectContaining({ code: 'not_your_ride' }),
      );
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);

      // One window later it is re-checked, and the new driver's trail keeps its
      // ride attribution instead of waiting out the whole TTL.
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(next, north(10));

      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(2);
      expect(geo.recordLocation).toHaveBeenLastCalledWith(OTHER_DRIVER_ID, expect.anything(), RIDE_ID);
      expect(broadcasts().at(-1)).toMatchObject({ driverId: OTHER_DRIVER_ID, location: north(10) });

      // And the previous driver is now the one refused.
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(previous, north(15));
      expect(previous.emit).toHaveBeenCalledWith(
        RT_SERVER_EVENTS.error,
        expect.objectContaining({ code: 'not_your_ride' }),
      );
      expect(broadcasts().at(-1)?.driverId).toBe(OTHER_DRIVER_ID);
    });

    it('ignores every outgoing event that is not a ride status, and never throws into one', async () => {
      jest.useFakeTimers();
      const observe = outgoingListener();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });
      await frameAt(driver, north(0));

      // It runs inside RealtimeService's broadcast loop: a throw would abort
      // that ride:status for the rest of the room.
      expect(() => {
        observe(RT_SERVER_EVENTS.driverLocation, { id: RIDE_ID, status: 'completed' });
        observe(RT_SERVER_EVENTS.rideStatus, 'not a summary');
        observe(RT_SERVER_EVENTS.rideStatus, null);
      }).not.toThrow();

      // The location echo carried a status-shaped field and was still ignored.
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(driver, north(10));
      expect(broadcasts()).toHaveLength(2);
    });

    it('leaves no timer behind when the driver socket disconnects', async () => {
      jest.useFakeTimers();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, north(0));
      jest.advanceTimersByTime(500);
      await frameAt(driver, north(10));
      expect(jest.getTimerCount()).toBe(1);

      gateway.handleDisconnect(driver as unknown as RtSocket);

      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(BROADCAST_MS);
      expect(broadcasts()).toHaveLength(1);
    });

    it('is not ended by the late disconnect of a socket the driver already replaced', async () => {
      jest.useFakeTimers();
      const oldSocket = connected({ userId: DRIVER_ID, isDriver: true, socketId: 'sock-old' });
      const newSocket = connected({ userId: DRIVER_ID, isDriver: true, socketId: 'sock-new' });

      await frameAt(oldSocket, north(0));
      jest.advanceTimersByTime(BROADCAST_MS);
      await frameAt(newSocket, north(10));
      jest.advanceTimersByTime(500);
      await frameAt(newSocket, north(20));

      gateway.handleDisconnect(oldSocket as unknown as RtSocket);
      jest.advanceTimersByTime(BROADCAST_MS);

      expect(broadcasts().map((b) => b.location)).toEqual([north(0), north(10), north(20)]);
      expect(prisma.ride.findUnique).toHaveBeenCalledTimes(1);
    });

    it('ends the stream when the driver stops naming the ride', async () => {
      jest.useFakeTimers();
      const driver = connected({ userId: DRIVER_ID, isDriver: true });

      await frameAt(driver, north(0));
      jest.advanceTimersByTime(500);
      await frameAt(driver, north(10));
      await gateway.onDriverLocation(driver as unknown as RtSocket, { location: north(20) });

      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(BROADCAST_MS);
      expect(broadcasts()).toHaveLength(1);
    });

    it('reads its dials once, taking the ETA model from pricing configuration', () => {
      const { RT_RIDER_BROADCAST_MS: _window, RT_RIDE_CONTEXT_TTL_MS: _ttl, ...unset } = process.env;

      expect(loadLiveTrackingConfig(unset)).toEqual({
        broadcastMs: 2_000,
        rideContextTtlMs: 15_000,
        // The same detour factor and speed the quote's estimate uses, so the map
        // and the quote cannot disagree about one trip.
        eta: { detourFactor: DETOUR_FACTOR, citySpeedMps: kmhToMps(CITY_SPEED_KMH) },
      });
      // A window this short is the uncoalesced firehose by another name.
      expect(() =>
        loadLiveTrackingConfig({ ...process.env, RT_RIDER_BROADCAST_MS: '10' }),
      ).toThrow(/RT_RIDER_BROADCAST_MS/);
    });
  });

  // -------------------------------------------------------------------------
  // Wire names
  // -------------------------------------------------------------------------

  it('listens on the client event names in the shared contract', () => {
    // The handlers are bound by decorator, so a drift between these constants
    // and the apps is a silent no-op rather than an error.
    expect(RT_CLIENT_EVENTS.subscribeRide).toBe('ride:subscribe');
    expect(RT_CLIENT_EVENTS.driverLocation).toBe('driver:location');
  });

  // -------------------------------------------------------------------------
  // Helpers bound to the fixtures above
  // -------------------------------------------------------------------------

  function expectedDistance(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
    return Math.round(haversineMeters(from, to) * DETOUR_FACTOR);
  }

  function expectedCityEta(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
    return Math.round(expectedDistance(from, to) / kmhToMps(CITY_SPEED_KMH));
  }
});

// ---------------------------------------------------------------------------
// live-eta.ts — the arithmetic, without a socket
// ---------------------------------------------------------------------------

describe('live ETA', () => {
  const T0 = 1_800_000_000_000;

  /** Fold `count` samples of `mps`, one every `everyMs`, after the clock-starting first one. */
  const drive = (
    start: SpeedEstimate | null,
    mps: number,
    count: number,
    everyMs: number,
    fromMs: number,
  ): SpeedEstimate | null => {
    let estimate = start;
    for (let i = 0; i < count; i += 1) {
      estimate = foldSpeedSample(estimate, mps, fromMs + i * everyMs, MODEL);
    }
    return estimate;
  };

  it('heads for the pickup until the trip starts, then the dropoff, and nowhere outside a trip', () => {
    expect(liveTargetFor('accepted')).toBe('pickup');
    expect(liveTargetFor('driver_arriving')).toBe('pickup');
    expect(liveTargetFor('arrived')).toBe('pickup');
    expect(liveTargetFor('in_progress')).toBe('dropoff');
    expect(liveTargetFor('searching')).toBeNull();
    expect(liveTargetFor('completed')).toBeNull();
    expect(liveTargetFor('cancelled_by_rider')).toBeNull();
  });

  it('measures road distance as straight line times the detour factor', () => {
    const from = { lat: 43.6532, lng: -79.3832 };
    const to = { lat: 43.6982, lng: -79.3832 };
    // 0.045 degrees of latitude is ~5 km anywhere.
    expect(haversineMeters(from, to)).toBeGreaterThan(4_990);
    expect(haversineMeters(from, to)).toBeLessThan(5_010);

    const eta = estimateLiveEta(
      { driver: from, status: 'in_progress', trip: { pickup: from, dropoff: to }, speed: null, nowMs: T0 },
      MODEL,
    );

    expect(eta).toEqual({
      target: 'dropoff',
      distanceMeters: Math.round(haversineMeters(from, to) * DETOUR_FACTOR),
      // No speed history: the city average, exactly as the quote estimated it.
      etaSeconds: Math.round(Math.round(haversineMeters(from, to) * DETOUR_FACTOR) / MODEL.citySpeedMps),
    });
  });

  it('has no ETA for a ride that is not running', () => {
    expect(
      estimateLiveEta(
        { driver: TORONTO, status: 'completed', trip: { pickup: PICKUP, dropoff: DROPOFF }, speed: null, nowMs: T0 },
        MODEL,
      ),
    ).toBeNull();
  });

  it('starts from the city average and moves towards the driver’s own speed', () => {
    const first = foldSpeedSample(null, 20, T0, MODEL);
    // One reading has no interval to stand for — and might be a red light.
    expect(first).toEqual({ mps: MODEL.citySpeedMps, sampledAtMs: T0 });

    // Three minutes of a steady 20 m/s, a sample every 4 s.
    const cruising = drive(first, 20, 45, 4_000, T0 + 4_000);
    const speed = effectiveSpeedMps(cruising, T0 + 180_000, MODEL);

    expect(speed).toBeGreaterThan(15);
    expect(speed).toBeLessThanOrEqual(20);
  });

  it('weights by time, so a 2 Hz phone does not twitch faster than a 4 s one', () => {
    const start = foldSpeedSample(null, 0, T0, MODEL);
    const slowPhone = drive(start, 20, 15, 4_000, T0 + 4_000); // 60 s
    const fastPhone = drive(start, 20, 120, 500, T0 + 500); // 60 s

    expect(slowPhone?.mps).toBeCloseTo(fastPhone?.mps ?? 0, 6);
  });

  it('does not show a stopped car an ETA of hours', () => {
    // Cruising, then parked at a light for three minutes reporting 0 m/s.
    const cruising = drive(foldSpeedSample(null, 10, T0, MODEL), 10, 30, 4_000, T0 + 4_000);
    const stopped = drive(cruising, 0, 45, 4_000, T0 + 124_000);
    const nowMs = T0 + 304_000;

    const eta = estimateLiveEta(
      {
        driver: TORONTO,
        status: 'driver_arriving',
        trip: { pickup: { lat: 43.6982, lng: -79.3832 }, dropoff: DROPOFF },
        speed: stopped,
        nowMs,
      },
      MODEL,
    );

    const floor = Math.max(MIN_ETA_SPEED_MPS, MODEL.citySpeedMps / 2);
    expect(effectiveSpeedMps(stopped, nowMs, MODEL)).toBe(floor);
    // ~6.75 km of road at the floor is under half an hour; at the stopped
    // car's own average (~1.3 m/s by now) it would read well over an hour,
    // and still climbing for as long as the light stayed red.
    expect(eta?.etaSeconds).toBeLessThan(30 * 60);
  });

  it('drops GPS glitches instead of averaging them in', () => {
    const cruising = drive(foldSpeedSample(null, 12, T0, MODEL), 12, 10, 4_000, T0 + 4_000);

    const afterGlitch = foldSpeedSample(cruising, MAX_PLAUSIBLE_SPEED_MPS + 30, T0 + 44_000, MODEL);
    const afterNaN = foldSpeedSample(cruising, Number.NaN, T0 + 44_000, MODEL);
    const afterMissing = foldSpeedSample(cruising, undefined, T0 + 44_000, MODEL);

    expect(afterGlitch).toBe(cruising);
    expect(afterNaN).toBe(cruising);
    expect(afterMissing).toBe(cruising);
  });

  it('forgets history too old to describe the road ahead', () => {
    const cruising = drive(foldSpeedSample(null, 25, T0, MODEL), 25, 45, 4_000, T0 + 4_000);
    const lastSample = T0 + 180_000;

    expect(effectiveSpeedMps(cruising, lastSample, MODEL)).toBeGreaterThan(MODEL.citySpeedMps);
    expect(effectiveSpeedMps(cruising, lastSample + SPEED_HISTORY_STALE_MS + 1, MODEL)).toBe(
      MODEL.citySpeedMps,
    );
    // And a sample after that long a gap restarts from the city average.
    expect(foldSpeedSample(cruising, 25, lastSample + SPEED_HISTORY_STALE_MS + 1, MODEL)?.mps).toBe(
      MODEL.citySpeedMps,
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function principal(overrides: { userId?: string; roles?: string[]; ttlSeconds?: number } = {}): RequestPrincipal {
  const ttl = overrides.ttlSeconds ?? 3_600;
  return {
    userId: overrides.userId ?? RIDER_ID,
    jti: 'jti-socket',
    roles: overrides.roles ?? ['rider'],
    exp: Math.floor(Date.now() / 1000) + ttl,
    raw: {},
  };
}

function driverPrincipal(): RequestPrincipal {
  return principal({ userId: DRIVER_ID, roles: ['driver'] });
}

/** The columns the gateway reads from `rides`, for RIDE_ID. */
function rideRow(overrides: { status?: string; driverId?: string | null } = {}): Record<string, unknown> {
  return {
    riderId: RIDER_ID,
    driverId: overrides.driverId === undefined ? DRIVER_ID : overrides.driverId,
    status: overrides.status ?? 'in_progress',
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    dropoffLat: DROPOFF.lat,
    dropoffLng: DROPOFF.lng,
  };
}

/** The parts of a ride:status payload the gateway reads, as RealtimeService sends them. */
function rideSummary(overrides: { status: string; driverId?: string }): Record<string, unknown> {
  return {
    id: RIDE_ID,
    riderId: RIDER_ID,
    driverId: overrides.driverId ?? DRIVER_ID,
    status: overrides.status,
    pickup: PICKUP,
    dropoff: DROPOFF,
  };
}

/** A socket that has already been through the middleware. */
function connected(who: { userId: string; isDriver?: boolean; socketId?: string }): SocketMock {
  return socketMock({
    id: who.socketId,
    data: {
      principal: principal({
        userId: who.userId,
        roles: who.isDriver ? ['driver'] : ['rider'],
      }),
      isDriver: who.isDriver ?? false,
    },
  });
}

function socketMock(
  init: { id?: string; token?: string; data?: Partial<RtSocket['data']> } = {},
): SocketMock {
  return {
    id: init.id ?? 'sock-1',
    data: init.data ?? {},
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
    onAnyOutgoing: jest.fn(),
    handshake: {
      auth: init.token ? { token: init.token } : {},
      headers: {},
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Run the handshake middleware and hand back what it told the client. */
async function handshake(
  identity: { verifyAccessToken: Mock },
  sessions: { isAccessJtiDenied: Mock },
  socket: SocketMock,
): Promise<{ next: jest.Mock; error?: { data?: { code?: string } } }> {
  const middleware = createRtAuthMiddleware({
    identity: identity as unknown as IdentityProvider,
    sessions: sessions as unknown as SessionService,
    logger: { debug: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() } as never,
  });
  const next = jest.fn();
  await middleware(socket as unknown as RtSocket, next);
  const call = next.mock.calls[0] as [{ data?: { code?: string } } | undefined] | undefined;
  return { next, error: call?.[0] };
}
