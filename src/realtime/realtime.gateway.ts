import { HttpException, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { z, type ZodError } from 'zod';
import {
  RT_CLIENT_EVENTS,
  RT_SERVER_EVENTS,
  isActiveTripStatus,
  type DriverId,
  type ISODateTime,
  type LatLng,
  type RideId,
  type RideStatus,
  type RtErrorPayload,
} from '@uride/types';
import {
  rideSubscribeSchema,
  rtDriverLocationSchema,
  type LocationPingInput,
  type RtDriverLocationInput,
} from '@uride/validation';
import { IdentityProvider } from '../common/identity/identity-provider.interface';
import { PrismaService } from '../common/prisma/prisma.module';
import { SessionService } from '../common/session/session.service';
import { GeoService } from '../modules/geo/geo.service';
import { loadPricingConfig } from '../modules/pricing/pricing.module';
import {
  estimateLiveEta,
  foldSpeedSample,
  kmhToMps,
  type LiveEtaModel,
  type SpeedEstimate,
  type TripEndpoints,
} from './live-eta';
import { RealtimeService } from './realtime.service';
import {
  createRtAuthMiddleware,
  driverRoom,
  msUntilExpiry,
  rideRoom,
  type RtNamespace,
  type RtSocket,
} from './rt-auth';
import { loadEnv } from '../config/env';

/**
 * The `/rt` gateway: every inbound socket message in the platform lands here.
 *
 * Three responsibilities, in order of how much damage getting them wrong does:
 *
 *  1. **Authentication.** Handled by the namespace middleware in rt-auth.ts, so
 *     no handler below ever runs for an anonymous socket.
 *  2. **Authorisation per room.** A ride room is joined only after the database
 *     confirms the caller is that ride's rider or its assigned driver. A client
 *     may send any rideId it likes; being told one proves nothing.
 *  3. **Ingest.** Location frames are rate-limited, validated, persisted through
 *     GeoService, and re-broadcast — with a live distance and ETA, coalesced to
 *     one frame per ride per window — only while the ride is actually running.
 *
 * Outbound traffic is not this class's job — that is RealtimeService, which the
 * rest of the backend calls so that no domain module ever imports socket.io.
 */

/** Namespace kept separable from any future one (e.g. an ops firehose). */
const RT_NAMESPACE = '/rt';

/**
 * Largest inbound packet accepted, down from socket.io's 1 MB default.
 *
 * The biggest legitimate client message on this namespace is a location frame —
 * a few hundred bytes. Leaving the megabyte default in place hands every
 * authenticated socket a cheap way to make the server allocate, which at 100k
 * connections is a memory-exhaustion vector rather than a nuisance.
 */
const MAX_INBOUND_BYTES = 16 * 1024;

/** Sustained location frames accepted from one socket, per second. */
const LOCATION_FRAMES_PER_SECOND = 2;

/**
 * Burst allowance on top of that rate.
 *
 * The driver app emits every 3–5 s, so the sustained rate above is already ~8×
 * what a healthy client needs, and this burst absorbs the handful of frames a
 * reconnect flushes at once. Neither is anywhere near enough for a client
 * emitting in a loop, which is the case this limiter exists for.
 */
const LOCATION_BURST = 8;

/** How often a throttled socket is told it is being throttled. */
const LOCATION_WARN_INTERVAL_MS = 10_000;

/** Longest delay `setTimeout` can hold (2^31 - 1 ms, ~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Live tracking configuration
// ---------------------------------------------------------------------------

/**
 * Live trip tracking dials, read once when the gateway is constructed.
 *
 * Parsed here rather than in config/env.ts for now — the arrangement
 * PricingModule uses for its own dials — because this file is where both are
 * consumed and where their trade-offs are explained.
 */
const LiveTrackingEnvSchema = z.object({
  // Most often a ride room receives ride:driver_location, in ms. Always the
  // NEWEST position when the window opens; frames in between are folded into
  // the speed estimate and then dropped. This is a fan-out dial, not a
  // smoothness one: a driver phone emitting at 2 Hz must not become 2 Hz of
  // socket traffic to every rider. Every broadcast is encoded and written to
  // each socket in the room — at 10,000 live trips an uncoalesced 2 Hz fleet is
  // 20,000+ writes a second, paid again in every rider's battery and data plan,
  // for positions the rider's map animates between anyway. Coalescing caps
  // outbound position traffic at (live trips x sockets per room) / window,
  // whatever the phones do.
  RT_RIDER_BROADCAST_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
  // How long the gateway trusts its cached copy of a ride's driver, status and
  // endpoints before the next frame re-reads the row. Transitions reach that
  // cache the instant they are announced (see RealtimeGateway.observeOutgoing),
  // so this is a backstop and mostly a Postgres dial: one primary-key read per
  // live trip per window instead of one per GPS frame.
  RT_RIDE_CONTEXT_TTL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
});

export interface LiveTrackingConfig {
  /** Minimum gap between position broadcasts to one ride room, ms. */
  broadcastMs: number;
  /** How long a cached ride row is trusted before a frame re-reads it, ms. */
  rideContextTtlMs: number;
  /** Detour factor and city speed the live ETA is computed with. */
  eta: LiveEtaModel;
}

/**
 * Parse live tracking settings. Throws with every problem listed, like
 * loadEnv(), so a bad value fails the boot rather than a trip.
 *
 * The ETA model comes through PricingModule's own loader, not a second parse of
 * ROUTE_DETOUR_FACTOR and ROUTE_AVERAGE_SPEED_KMH: the live ETA is that same
 * estimate applied to a moving origin, and two definitions of one dial is how
 * the quote and the map come to disagree about the same trip.
 */
export function loadLiveTrackingConfig(source: NodeJS.ProcessEnv = process.env): LiveTrackingConfig {
  const parsed = LiveTrackingEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[uride-api] Invalid live tracking configuration:\n${issues}`);
  }
  const { route } = loadPricingConfig(source);
  return {
    broadcastMs: parsed.data.RT_RIDER_BROADCAST_MS,
    rideContextTtlMs: parsed.data.RT_RIDE_CONTEXT_TTL_MS,
    eta: { detourFactor: route.detourFactor, citySpeedMps: kmhToMps(route.averageSpeedKmh) },
  };
}

// ---------------------------------------------------------------------------
// Live tracking state
// ---------------------------------------------------------------------------

/**
 * What the gateway holds for one ride whose driver it is streaming: the slice
 * of the ride row live tracking needs, the driver's running speed, and the
 * broadcast window.
 *
 * One per ride and, because a driver socket feeds at most one ride, at most one
 * per driver socket — so the map can never outgrow the connections it serves.
 */
interface RideStream {
  rideId: string;
  driverId: string;
  /** The socket whose frames feed this stream; its disconnect ends the stream. */
  socketId: string;
  status: RideStatus;
  trip: TripEndpoints;
  /** Start time of the read the context came from; re-read once older than the TTL. */
  loadedAtMs: number;
  speed: SpeedEstimate | null;
  /** Server clock of the last broadcast; 0 before the first. */
  lastSentAtMs: number;
  /** The newest frame not yet broadcast. Replaced by each frame, never queued. */
  pending: PendingFrame | null;
  /** The trailing edge of the current window, when a frame is waiting for it. */
  timer: NodeJS.Timeout | null;
}

interface PendingFrame {
  location: LatLng;
  headingDegrees: number | null;
  /** Server clock when the frame arrived — what the broadcast is stamped with. */
  receivedAtMs: number;
}

/** The columns of `rides` live tracking reads. */
interface RideContextRow {
  driverId: string | null;
  status: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
}

/** A ride:status this process delivered, reduced to what the cache needs. */
interface ObservedRide {
  rideId: string;
  status: RideStatus;
  driverId: string | null;
}

/** One ride read in flight, shared by every frame waiting on it. */
interface ContextLoad {
  promise: Promise<RideContextRow | null>;
  startedAtMs: number;
  /**
   * A ride:status delivered while the read was out. It committed no earlier
   * than anything the read could have seen, so where they differ it wins.
   */
  observed: ObservedRide | null;
}

@WebSocketGateway({
  namespace: RT_NAMESPACE,
  cors: {
    // A function, not the parsed array, because this decorator is evaluated at
    // import time — before main.ts has loaded .env — so an eager loadEnv() here
    // would throw on a missing DATABASE_URL before the process ever read its
    // configuration. The callback runs per handshake, by which point the env is
    // loaded and memoised.
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void => callback(null, isOriginAllowed(requestOrigin)),
    credentials: true,
  },
  maxHttpBufferSize: MAX_INBOUND_BYTES,
})
export class RealtimeGateway
  implements
    OnGatewayInit<RtNamespace>,
    OnGatewayConnection<RtSocket>,
    OnGatewayDisconnect<RtSocket>,
    OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  private readonly tracking: LiveTrackingConfig;

  /** Rides whose driver this process is streaming, by ride id. */
  private readonly streams = new Map<string, RideStream>();

  /** The one ride each driver socket is feeding, by socket id. */
  private readonly socketRides = new Map<string, string>();

  /** Ride reads in flight, by ride id — one per ride however many frames wait on it. */
  private readonly contextLoads = new Map<string, ContextLoad>();

  constructor(
    private readonly identity: IdentityProvider,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly realtime: RealtimeService,
  ) {
    this.tracking = loadLiveTrackingConfig();
  }

  afterInit(server: RtNamespace): void {
    // Registered before the HTTP server starts listening, so there is no window
    // in which a socket can connect ahead of the authentication middleware.
    server.use(
      createRtAuthMiddleware({
        identity: this.identity,
        sessions: this.sessions,
        logger: this.logger,
      }),
    );
    this.realtime.bindServer(server);
    this.logger.log(`Realtime gateway initialized at ${RT_NAMESPACE} (authenticated).`);
  }

  handleConnection(client: RtSocket): void {
    // socket.io initialises `data` to an empty object, so this is a real
    // runtime check and not a redundant one: if the middleware were ever
    // bypassed, an unauthenticated socket would arrive here with no principal,
    // and the correct response is to hang up rather than to serve it.
    const principal = client.data?.principal;
    if (!principal) {
      this.logger.warn(`Socket ${client.id} reached handleConnection unauthenticated; closing.`);
      client.disconnect(true);
      return;
    }

    // An access token lives 15 minutes but a socket can live for days, so a
    // connection authenticated once would otherwise outlive the credential that
    // opened it — including past a logout, which only denylists the jti. Close
    // the socket when the token expires; the client reconnects with a fresh one
    // through the same middleware.
    const ttlMs = msUntilExpiry(principal);
    if (ttlMs <= 0) {
      this.expire(client);
      return;
    }
    // Clamped because Node's timer takes a 32-bit delay and fires *immediately*
    // on anything larger — an operator who set a month-long access TTL would
    // otherwise find every socket dropping the instant it connected, which is
    // the opposite of what a longer token is meant to do.
    const timer = setTimeout(() => this.expire(client), Math.min(ttlMs, MAX_TIMEOUT_MS));
    // Never hold the event loop open for a socket's expiry during shutdown.
    timer.unref();
    client.data.expiryTimer = timer;

    // Every authenticated socket, rider or driver, reports the ride:status
    // frames it is sent. That is how a cached ride context learns a trip ended
    // without a Postgres read — see observeOutgoing for why every socket and
    // not just the driver's.
    client.onAnyOutgoing(this.observeOutgoing);

    // Drivers are joined to their own room on connect, not on going online:
    // the room is only ever addressed by dispatch, which picks its candidates
    // from driver_availability, so an offline driver's membership costs one map
    // entry and nothing else — while a driver whose socket reconnected a second
    // before an offer was made would otherwise miss it.
    if (client.data.isDriver) {
      void client.join(driverRoom(principal.userId));
    }

    this.logger.debug(
      `ws connect ${client.id} user=${principal.userId} roles=[${principal.roles.join(',')}]`,
    );
  }

  handleDisconnect(client: RtSocket): void {
    const timer = client.data?.expiryTimer;
    if (timer) clearTimeout(timer);
    // socket.io removes the socket from every room it joined, so there is no
    // membership to clean up here. Live tracking state is ours, though: a
    // driver whose socket is gone feeds nothing, and a broadcast timer left
    // behind would fire into a room for a frame nobody is updating.
    this.releaseSocket(client.id);
    this.logger.debug(`ws disconnect ${client.id}`);
  }

  onModuleDestroy(): void {
    // Timers are unref'd, so none of them holds shutdown open; clearing them
    // stops a trailing broadcast firing into a namespace that is closing.
    for (const stream of this.streams.values()) this.cancelPending(stream);
    this.streams.clear();
    this.socketRides.clear();
    this.contextLoads.clear();
  }

  // -------------------------------------------------------------------------
  // Client → server
  // -------------------------------------------------------------------------

  /**
   * Join a ride's room.
   *
   * The whole security boundary of this namespace is in the lookup below. The
   * rideId is client-supplied, and a rider asking for a stranger's ride is the
   * obvious attack: granted, it would stream that stranger's driver's live
   * position and every state change for the trip. So membership is decided by
   * the database — rider or assigned driver, nobody else — and it is re-checked
   * on every subscribe rather than cached, because a subscribe happens once per
   * ride per client and is nowhere near hot enough to be worth a stale answer.
   *
   * Deliberately no state snapshot in reply: the current ride is a REST read
   * (`GET /v1/rides/:id`), and mapping the row to a RideSummary here as well
   * would give the platform two answers to the same question. The socket
   * carries transitions from this point forward.
   */
  @SubscribeMessage(RT_CLIENT_EVENTS.subscribeRide)
  async onRideSubscribe(
    @ConnectedSocket() socket: RtSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const parsed = rideSubscribeSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(
        socket,
        'validation_error',
        `Invalid subscribe: ${describeIssue(parsed.error)}`,
      );
      return;
    }

    const { rideId } = parsed.data;
    const { userId } = socket.data.principal;
    const ride = await this.prisma.ride.findUnique({
      where: { id: rideId },
      select: { riderId: true, driverId: true },
    });

    // A ride that does not exist and a ride that is not yours are answered the
    // same way — enumerating ride ids should not be possible by watching which
    // refusal comes back.
    if (!ride || (ride.riderId !== userId && ride.driverId !== userId)) {
      this.logger.warn(`User ${userId} was refused a subscription to ride ${rideId}.`);
      this.sendError(socket, 'not_your_ride', 'That ride is not yours.');
      return;
    }

    await socket.join(rideRoom(rideId));
    this.logger.debug(`Socket ${socket.id} joined ride ${rideId}.`);
  }

  /** Leave a ride's room. Needs no authorisation — leaving is always allowed. */
  @SubscribeMessage(RT_CLIENT_EVENTS.unsubscribeRide)
  async onRideUnsubscribe(
    @ConnectedSocket() socket: RtSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const parsed = rideSubscribeSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(
        socket,
        'validation_error',
        `Invalid unsubscribe: ${describeIssue(parsed.error)}`,
      );
      return;
    }
    await socket.leave(rideRoom(parsed.data.rideId));
    this.logger.debug(`Socket ${socket.id} left ride ${parsed.data.rideId}.`);
  }

  /**
   * A driver's position: persist it, then show it to the rider with a live
   * distance and ETA — but only while there is a trip to show it on, and no more
   * often than a rider's map can use.
   *
   * docs/API.md §8 states the rule absolutely: a rider never sees a driver's
   * location outside their own active ride. Three things enforce it together,
   * and none of them is sufficient alone:
   *
   *  - the sender must hold the `driver` role;
   *  - the ride must name this driver as its assigned driver;
   *  - the ride must be in ACTIVE_TRIP_STATUSES right now.
   *
   * "Right now" used to mean re-reading the ride on every frame. That put a
   * Postgres round trip per GPS fix back on the hottest path in the platform,
   * right beside a ping that no longer needs one. The ride is now read once per
   * RT_RIDE_CONTEXT_TTL_MS, and between reads it is kept current by the
   * ride:status frames this process delivers (observeOutgoing), which arrive
   * the moment a transition is announced — so "only while active" still has no
   * grace period anywhere a rider could be watching. The TTL is the backstop,
   * not the mechanism.
   */
  @SubscribeMessage(RT_CLIENT_EVENTS.driverLocation)
  async onDriverLocation(
    @ConnectedSocket() socket: RtSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const { principal, isDriver } = socket.data;
    if (!isDriver) {
      this.sendError(socket, 'forbidden', 'Only a driver may publish a position.');
      return;
    }
    if (!this.withinLocationBudget(socket)) return;

    const parsed = rtDriverLocationSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(
        socket,
        'validation_error',
        `Invalid location: ${describeIssue(parsed.error)}`,
      );
      return;
    }
    const frame = parsed.data;
    const driverId = principal.userId;
    // Server clock, taken before any await: this is when the fix reached us,
    // and a frame that then waited on Redis should not be stamped as newer than
    // it is.
    const receivedAtMs = Date.now();

    // Ride attribution is verified, never taken on trust. A driver naming a
    // ride that is not theirs loses the linkage, not the ping: the position is
    // still legitimate fleet telemetry and dispatch wants it, so it is stored
    // unattributed and the claim is refused.
    let stream: RideStream | null = null;
    if (frame.rideId) {
      stream = await this.attributeFrame(socket, driverId, frame.rideId);
    } else {
      // A driver streaming without a ride is not feeding one any more.
      this.releaseSocket(socket.id);
    }

    try {
      // The Redis hot path: one index script and one RPUSH onto the trail
      // queue. Postgres is touched only for a driver the index has never seen
      // (or forgot after a heartbeat of silence) — once per session, not per
      // frame — and the trail reaches driver_locations in bulk, a flush tick
      // later, with ride-attributed points kept at full fidelity.
      await this.geo.recordLocation(driverId, toPing(frame), stream?.rideId);
    } catch (error) {
      // Storage failures are a socket-level answer, never an exception: an
      // unhandled throw inside a handler takes down the whole rxjs subscription
      // Nest built for this event, silently deafening the socket to every
      // subsequent frame.
      const failure = toRtError(error);
      this.logger.debug(`Location frame from driver ${driverId} rejected: ${failure.code}`);
      this.sendError(socket, failure.code, failure.message);
      return;
    }

    if (!stream) return;
    // Every attributed frame is a speed sample, including the ones coalescing
    // is about to drop — the ETA is built from all of them.
    stream.speed = foldSpeedSample(stream.speed, frame.speedMps, receivedAtMs, this.tracking.eta);
    this.queueBroadcast(stream, {
      location: frame.location,
      headingDegrees: frame.headingDegrees ?? null,
      receivedAtMs,
    });
  }

  // -------------------------------------------------------------------------
  // Internals — live tracking
  // -------------------------------------------------------------------------

  /**
   * Every outgoing packet on an authenticated socket passes through here; only
   * ride:status is read.
   *
   * Status changes are announced by RealtimeService.emitRideStatus to the ride's
   * room once their transaction has committed, and socket.io calls a socket's
   * outgoing listeners for room broadcasts as well as for direct emits. So the
   * moment a trip ends, is cancelled or is reassigned, every socket in its room
   * on this process hands us the new status — no Postgres read, and no coupling
   * to the half-dozen modules that move rides.
   *
   * Why that is enough to keep the privacy rule exact: with the in-memory
   * adapter the platform runs, a position broadcast reaches only room members
   * in this process, and every one of them was also sent the ride:status that
   * ended the trip — which ended the stream, synchronously, before any later
   * position could go out. With no member here, there is nobody to leak to.
   * Listening on every socket rather than only the driver's is what makes that
   * hold for a driver app that never subscribed to its own ride. What this
   * cannot see is a transition that was never announced (the announcing module
   * logs and moves on when building the payload fails) and, once a
   * multi-instance adapter lands, a stream on an instance holding no member of
   * its room. RT_RIDE_CONTEXT_TTL_MS bounds both.
   *
   * It runs inside another module's broadcast loop, so it never throws: a throw
   * here would abort delivery of that ride:status to the rest of the room.
   */
  private readonly observeOutgoing = (event: string, ...args: unknown[]): void => {
    if (event !== RT_SERVER_EVENTS.rideStatus) return;
    try {
      const observed = readObservedRide(args[0]);
      if (observed) this.applyObservedRide(observed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not apply an outgoing ride:status to live tracking: ${detail}`);
    }
  };

  private applyObservedRide(observed: ObservedRide): void {
    // A read already on its way back may have started before this transition
    // committed; mark it so it cannot restore the status that just ended.
    const load = this.contextLoads.get(observed.rideId);
    if (load) load.observed = observed;

    const stream = this.streams.get(observed.rideId);
    if (!stream) return;
    if (observed.driverId !== stream.driverId) {
      // Reassigned: the previous driver's position stops here, and their next
      // frame is refused from a fresh read.
      this.endStream(stream);
      return;
    }
    stream.status = observed.status;
    // The frame waiting for its window belonged to the trip that just ended; it
    // must not go out after it.
    if (!isActiveTripStatus(stream.status)) this.cancelPending(stream);
  }

  /**
   * Verify a frame's ride claim and return the stream it feeds, or null when it
   * feeds none — refused, or not verifiable right now.
   *
   * Postgres is read only when this process holds no context for the ride, the
   * one it holds has aged past the TTL, or it names a different driver than the
   * claim does: pickup, dropoff and the assigned driver do not change from frame
   * to frame, and status changes arrive through observeOutgoing.
   */
  private async attributeFrame(
    socket: RtSocket,
    driverId: string,
    rideId: string,
  ): Promise<RideStream | null> {
    // A driver socket feeds one ride at a time; naming a different one means
    // the previous one is over as far as this socket is concerned.
    if (this.socketRides.get(socket.id) !== rideId) this.releaseSocket(socket.id);

    let stream = this.streams.get(rideId);
    const ageMs = stream ? Date.now() - stream.loadedAtMs : Number.POSITIVE_INFINITY;
    // A claim that disagrees with the cached driver is re-checked, at most once
    // per broadcast window. It is either the driver an admin just reassigned
    // the ride to — whose points must not lose their ride attribution, and with
    // it their exemption from trail sampling, for a whole TTL because an
    // announcement went astray — or a claim that will be refused again, at a
    // read rate the token bucket and this window both bound.
    const disputed = stream !== undefined && stream.driverId !== driverId;
    if (
      ageMs >= this.tracking.rideContextTtlMs ||
      (disputed && ageMs >= this.tracking.broadcastMs)
    ) {
      const load = this.startContextLoad(rideId);
      let row: RideContextRow | null;
      try {
        row = await load.promise;
      } catch (error) {
        return this.onContextLoadFailed(socket, driverId, rideId, error);
      } finally {
        if (this.contextLoads.get(rideId) === load) this.contextLoads.delete(rideId);
      }
      stream = this.applyLoadedContext(rideId, load, row, driverId, socket.id);
    }

    if (!stream || stream.driverId !== driverId) {
      this.sendError(socket, 'not_your_ride', 'You are not the driver on that ride.');
      return null;
    }
    this.bindSocket(stream, socket.id);
    return stream;
  }

  /** The one read per ride per window, shared by every frame that needs it meanwhile. */
  private startContextLoad(rideId: string): ContextLoad {
    const inFlight = this.contextLoads.get(rideId);
    if (inFlight) return inFlight;

    const load: ContextLoad = {
      startedAtMs: Date.now(),
      observed: null,
      // Wrapped so the query runs exactly once however many frames await it,
      // whatever the client's promise type does on a second `then`.
      promise: Promise.resolve(
        this.prisma.ride.findUnique({
          where: { id: rideId },
          select: {
            driverId: true,
            status: true,
            pickupLat: true,
            pickupLng: true,
            dropoffLat: true,
            dropoffLng: true,
          },
        }),
      ),
    };
    this.contextLoads.set(rideId, load);
    return load;
  }

  /**
   * Merge a finished ride read into the stream map, and return the ride's stream
   * afterwards, if it has one.
   */
  private applyLoadedContext(
    rideId: string,
    load: ContextLoad,
    row: RideContextRow | null,
    driverId: string,
    socketId: string,
  ): RideStream | undefined {
    const existing = this.streams.get(rideId);
    // Several frames can wait on one read, and the first to resume has applied
    // it already. A later waiter must not apply it again over a ride:status
    // observed in between.
    if (existing && existing.loadedAtMs >= load.startedAtMs) return existing;

    const assigned =
      row === null
        ? null
        : load.observed
          ? { driverId: load.observed.driverId, status: load.observed.status }
          : { driverId: row.driverId, status: row.status as RideStatus };

    if (existing) {
      if (assigned !== null && assigned.driverId === existing.driverId) {
        existing.status = assigned.status;
        existing.loadedAtMs = load.startedAtMs;
        if (!isActiveTripStatus(existing.status)) this.cancelPending(existing);
        return existing;
      }
      this.endStream(existing);
    }

    // Created only for the driver the ride names. A stream created from someone
    // else's frame would be tied to a socket that never feeds it, and nothing
    // would ever release it.
    if (row === null || assigned === null || assigned.driverId !== driverId) return undefined;

    // Created for an inactive ride too: a driver app still naming a trip that
    // finished is then answered from memory for a window, not from Postgres on
    // every frame. It broadcasts nothing — queueBroadcast checks the status.
    const stream: RideStream = {
      rideId,
      driverId,
      socketId,
      status: assigned.status,
      trip: {
        pickup: { lat: row.pickupLat, lng: row.pickupLng },
        dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
      },
      loadedAtMs: load.startedAtMs,
      speed: null,
      lastSentAtMs: 0,
      pending: null,
      timer: null,
    };
    this.streams.set(rideId, stream);
    this.socketRides.set(socketId, rideId);
    return stream;
  }

  /**
   * A ride read failed. Keep serving a context this driver already holds;
   * without one the claim cannot be verified, so the frame is stored
   * unattributed and shown to nobody — a refused claim's outcome, without
   * telling the driver they made one.
   */
  private onContextLoadFailed(
    socket: RtSocket,
    driverId: string,
    rideId: string,
    error: unknown,
  ): RideStream | null {
    const detail = error instanceof Error ? error.message : String(error);
    const cached = this.streams.get(rideId);
    if (cached && cached.driverId === driverId) {
      // Trusted for another window rather than retried on every frame into a
      // database that is already struggling. Serving it stays safe for the same
      // reason caching it is: a transition that commits is still observed the
      // moment it is announced.
      cached.loadedAtMs = Date.now();
      this.logger.warn(`Refreshing ride ${rideId} failed; keeping its cached context: ${detail}`);
      this.bindSocket(cached, socket.id);
      return cached;
    }
    // Debug, not warn: this repeats per frame per driver for as long as the
    // outage lasts, and the database being down is loud everywhere else.
    this.logger.debug(`Could not verify ride ${rideId} for driver ${driverId}: ${detail}`);
    return null;
  }

  /**
   * Offer a frame to its ride's broadcast window.
   *
   * At most one ride:driver_location per ride per RT_RIDER_BROADCAST_MS, and it
   * is always the newest position: the first frame after a quiet window goes
   * out at once, and a frame arriving inside the window replaces whatever was
   * waiting and goes out when the window closes. A driver phone emitting at
   * 2 Hz must not become 2 Hz of socket traffic to every rider — see the
   * RT_RIDER_BROADCAST_MS note for the fan-out arithmetic.
   */
  private queueBroadcast(stream: RideStream, frame: PendingFrame): void {
    // The stream can have ended, or the trip left the active set, while this
    // frame waited on storage.
    if (this.streams.get(stream.rideId) !== stream || !isActiveTripStatus(stream.status)) return;

    stream.pending = frame;
    if (stream.timer) return;

    const waitMs = stream.lastSentAtMs + this.tracking.broadcastMs - Date.now();
    if (waitMs <= 0) {
      this.flushBroadcast(stream);
      return;
    }
    const timer = setTimeout(() => {
      stream.timer = null;
      // A throw in a timer callback is an uncaught exception, which takes the
      // process down; one bad frame costs one broadcast instead.
      try {
        this.flushBroadcast(stream);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Dropped a location broadcast for ride ${stream.rideId}: ${detail}`);
      }
    }, waitMs);
    timer.unref();
    stream.timer = timer;
  }

  /** Send the waiting frame, with distance and ETA computed from it now. */
  private flushBroadcast(stream: RideStream): void {
    const frame = stream.pending;
    stream.pending = null;
    // Re-checked at send time, not only at queue time: the window is exactly
    // long enough for a trip to end inside it.
    if (!frame || this.streams.get(stream.rideId) !== stream || !isActiveTripStatus(stream.status)) {
      return;
    }

    const nowMs = Date.now();
    stream.lastSentAtMs = nowMs;
    // In memory, from the live position. Never a routing call: this runs per
    // broadcast per trip, and the routing provider bills per request.
    const eta = estimateLiveEta(
      {
        driver: frame.location,
        status: stream.status,
        trip: stream.trip,
        speed: stream.speed,
        nowMs,
      },
      this.tracking.eta,
    );

    this.realtime.emitDriverLocation(stream.rideId, {
      rideId: stream.rideId as RideId,
      driverId: stream.driverId as DriverId,
      location: frame.location,
      headingDegrees: frame.headingDegrees,
      target: eta?.target ?? null,
      distanceMeters: eta?.distanceMeters ?? null,
      etaSeconds: eta?.etaSeconds ?? null,
      // Server clock, not the device's: a phone with a skewed clock must not be
      // able to stamp a position into the rider's future. The arrival time, not
      // the send time — a frame held for its window is that much older.
      recordedAt: new Date(frame.receivedAtMs).toISOString() as ISODateTime,
    });
  }

  private bindSocket(stream: RideStream, socketId: string): void {
    stream.socketId = socketId;
    this.socketRides.set(socketId, stream.rideId);
  }

  /** Forget the ride a socket was feeding, ending its stream if that socket still owns it. */
  private releaseSocket(socketId: string): void {
    const rideId = this.socketRides.get(socketId);
    if (rideId === undefined) return;
    this.socketRides.delete(socketId);
    const stream = this.streams.get(rideId);
    // A driver who reconnected is already feeding the ride from their new
    // socket, and the old socket's late disconnect must not end it.
    if (stream && stream.socketId === socketId) this.endStream(stream);
  }

  private endStream(stream: RideStream): void {
    this.cancelPending(stream);
    if (this.streams.get(stream.rideId) === stream) this.streams.delete(stream.rideId);
    if (this.socketRides.get(stream.socketId) === stream.rideId) {
      this.socketRides.delete(stream.socketId);
    }
  }

  private cancelPending(stream: RideStream): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    stream.pending = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Per-socket token bucket over `driver:location`.
   *
   * In memory rather than in Redis, unlike PerUserRateLimitGuard: the thing
   * being limited is a socket, which lives in exactly one process, so the
   * counter belongs in that process. A Redis round trip per frame would cost
   * more than the work it is protecting, and at 100k sockets it would add a
   * network hop to the hottest path in the platform.
   *
   * Over-budget frames are dropped silently; the socket is told at most once
   * every {@link LOCATION_WARN_INTERVAL_MS}. Replying to every dropped frame
   * would turn a client stuck in a send loop into an amplifier pointed back at
   * us.
   */
  private withinLocationBudget(socket: RtSocket): boolean {
    const now = Date.now();
    const budget = (socket.data.locationBudget ??= {
      tokens: LOCATION_BURST,
      lastRefillMs: now,
      lastWarnedMs: 0,
    });

    const refill = ((now - budget.lastRefillMs) / 1000) * LOCATION_FRAMES_PER_SECOND;
    budget.tokens = Math.min(LOCATION_BURST, budget.tokens + refill);
    budget.lastRefillMs = now;

    if (budget.tokens >= 1) {
      budget.tokens -= 1;
      return true;
    }

    if (now - budget.lastWarnedMs >= LOCATION_WARN_INTERVAL_MS) {
      budget.lastWarnedMs = now;
      const driverId = socket.data.principal.userId;
      this.logger.debug(`Throttling location frames from driver ${driverId} (${socket.id}).`);
      this.sendError(
        socket,
        'rate_limited',
        `Location updates are limited to ${LOCATION_FRAMES_PER_SECOND} per second.`,
      );
    }
    return false;
  }

  /** Refuse a client message. Handlers report failures this way, never by throwing. */
  private sendError(socket: RtSocket, code: string, message: string): void {
    socket.emit(RT_SERVER_EVENTS.error, { code, message });
  }

  /** Tell the client its credential ran out, then hang up so it reconnects. */
  private expire(socket: RtSocket): void {
    this.sendError(socket, 'token_expired', 'Your session expired. Reconnect with a fresh token.');
    socket.disconnect(true);
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Parsed once, on the first handshake. See the note on the cors option above. */
let allowedOrigins: Set<string> | null = null;

/**
 * CORS for the socket handshake, from env.ALLOWED_ORIGINS — never `*`.
 *
 * A request with no Origin header at all is allowed: that is every native
 * client (the mobile apps send none), and CORS is a browser-enforced control
 * with nothing to say about them. The handshake's real gate is the JWT.
 */
function isOriginAllowed(requestOrigin: string | undefined): boolean {
  if (!requestOrigin) return true;
  allowedOrigins ??= new Set(
    loadEnv()
      .ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
  return allowedOrigins.has(requestOrigin);
}

/**
 * Socket frame → the shape GeoService stores.
 *
 * No `recordedAt`: a socket frame is current by definition (that is why the
 * schema has no such field), and GeoService files an omitted capture time under
 * now. The batch/backfill affordances belong to the REST ping route.
 */
function toPing(frame: RtDriverLocationInput): LocationPingInput {
  return {
    location: frame.location,
    headingDegrees: frame.headingDegrees,
    speedMps: frame.speedMps,
  };
}

/**
 * The parts of an outgoing ride:status live tracking reads, or null if the
 * payload is not one. The payload is our own RideSummary, but it reaches the
 * listener untyped, and this runs inside somebody else's broadcast.
 */
function readObservedRide(payload: unknown): ObservedRide | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { id, status, driverId } = payload as { id?: unknown; status?: unknown; driverId?: unknown };
  if (typeof id !== 'string' || typeof status !== 'string') return null;
  return {
    rideId: id,
    status: status as RideStatus,
    driverId: typeof driverId === 'string' ? driverId : null,
  };
}

/** First zod complaint, rendered for a human reading a client console. */
function describeIssue(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'payload rejected.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Reuse the `{ code, message }` body the domain services already throw, so a
 * failure reads identically whether the driver app hit the REST ping route or
 * the socket. Anything without that shape is a bug on our side and says so
 * without leaking its internals.
 */
function toRtError(error: unknown): RtErrorPayload {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null) {
      const { code, message } = body as { code?: unknown; message?: unknown };
      if (typeof code === 'string' && typeof message === 'string') return { code, message };
    }
  }
  return { code: 'internal_error', message: 'Could not record that position.' };
}
