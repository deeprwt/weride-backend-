import { Injectable, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { haversineMeters } from '../../common/pricing-client/pricing-client';
import { RedisService } from '../../common/redis/redis.module';
import type { RouteConfig } from './pricing.module';

export interface RoutePoint {
  lat: number;
  lng: number;
}

/** One origin's road cost to the shared destination. */
export interface RouteMatrixLeg {
  /** Index into the origins array as passed in. */
  originIndex: number;
  distanceMeters: number;
  durationSeconds: number;
  /** False when this origin fell back to the straight-line estimate. */
  routed: boolean;
}

/** `google` is a routed road distance; `estimate` is straight-line times the detour factor. */
export type RouteSource = 'google' | 'estimate';

export interface RouteEstimate {
  /** Road metres, integer. */
  distanceMeters: number;
  /**
   * Seconds, integer. Congestion-aware only when the source is `google` AND
   * ROUTE_TRAFFIC_AWARE is on; otherwise it is a free-flow estimate.
   */
  durationSeconds: number;
  source: RouteSource;
  /** True when a `google` route was reused from the cache rather than billed now. */
  cached: boolean;
  /**
   * Google's encoded polyline for the driven route, or null when the distance
   * came from the detour estimate — a straight-line guess has no shape to draw.
   *
   * Clients decode this to draw the route along real roads. Without it the map
   * can only join the two pins, which looks broken next to any competitor and,
   * worse, advertises that the quoted distance is not a road distance.
   */
  polyline: string | null;
}

/** What a quote needs from a route: the two numbers, plus the shape to draw. */
interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
  polyline: string | null;
}

const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const COMPUTE_MATRIX_URL =
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/**
 * Matrix replies carry the origin index, so a missing or failed element can be
 * told apart from one that simply routed to zero. `condition` distinguishes
 * ROUTE_EXISTS from ROUTE_NOT_FOUND — an island, a closed crossing — which must
 * fall back rather than be read as "zero seconds away".
 */
const MATRIX_FIELD_MASK = 'originIndex,duration,distanceMeters,condition';

/**
 * Exactly the fields that are used, and no more: computeRoutes refuses a request
 * with no field mask, and `legs` and `steps` are most of the payload weight.
 *
 * The overview polyline is worth its bytes — it is what lets the app draw the
 * route along roads instead of a straight line between the pins. It does not
 * change the billing tier; TRAFFIC_AWARE routing is what sets that.
 */
const ROUTES_FIELD_MASK =
  'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';

/**
 * Pins are rounded to three decimal places for the cache key: ~111 m of
 * latitude and ~80 m of longitude at Toronto's latitude. Coarse enough that a
 * rider nudging the pin reuses the route, fine enough that the reused distance
 * is off by at most a block at either end — a few cents on a fare.
 */
const CACHE_KEY_DECIMALS = 3;

/**
 * Trips shorter than this straight-line are never sent to Google. The answer
 * cannot move a fare past rounding, and the usual source of them is a rider who
 * has not moved the dropoff pin off the pickup yet.
 */
const ROUTE_MIN_STRAIGHT_LINE_METERS = 200;

/**
 * Google's Duration JSON: seconds with an optional fraction and a trailing
 * `s`, e.g. "1561s" or "1561.5s".
 */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)s$/;

/**
 * RouteEstimatorService — road distance and duration for a fare quote.
 *
 * Straight-line distance under-quotes every trip that is not a straight line,
 * which is every trip. With MAPS_PROVIDER=google this asks the Routes API
 * (computeRoutes) for the real road distance and duration. With
 * MAPS_PROVIDER=none it multiplies straight-line distance by
 * ROUTE_DETOUR_FACTOR, so local development costs nothing.
 *
 * Google is BILLABLE, and traffic-aware routing bills at a higher tier than
 * static routing (see docs/RUNBOOK.md §cost), which is why ROUTE_TRAFFIC_AWARE
 * defaults off: the congestion-aware duration is the only thing it buys, and
 * distance — which dominates the fare — is identical on the cheaper tier. The
 * spend is bounded three ways:
 *
 *  - Once per QUOTE, never per location frame. Live ETAs during a trip are
 *    computed in memory from the driver's position; nothing on that path may
 *    call this service.
 *  - A shared Redis cache keyed on pins rounded to ~100 m, for
 *    ROUTE_CACHE_TTL_SECONDS. Quote and ride creation usually land on different
 *    API instances, and the rider dragging a pin fires a quote per drag; both
 *    reuse one billed route.
 *  - Single-flight per key within the process, so a burst of identical quotes
 *    racing the first response waits for it instead of each paying for it.
 *
 * A quote must never fail or stall because Google is slow. The call has a hard
 * timeout, sits behind a circuit breaker so an outage stops costing each quote
 * a full timeout, and every failure — HTTP error, malformed body, no route,
 * breaker open — falls back to the detour estimate. Estimates are never written
 * to the route cache: once Google recovers, the next quote should get the real
 * route, not a stale guess.
 *
 * The API key travels in a header, never the URL, and is never logged: errors
 * are reported by status code only, because error bodies echo request details.
 *
 * Constructed by PricingModule's factory; see there for why.
 */
@Injectable()
export class RouteEstimatorService {
  private readonly logger = new Logger(RouteEstimatorService.name);
  private readonly breaker: CircuitBreaker<[RoutePoint, RoutePoint], RouteLeg> | null;
  private readonly inFlight = new Map<string, Promise<RouteEstimate>>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: RouteConfig,
  ) {
    if (config.provider !== 'google' || config.googleApiKey === null) {
      this.breaker = null;
      return;
    }

    const apiKey = config.googleApiKey;
    this.breaker = new CircuitBreaker(
      (pickup: RoutePoint, dropoff: RoutePoint) => this.callRoutesApi(apiKey, pickup, dropoff),
      {
        timeout: config.timeoutMs,
        errorThresholdPercentage: 50,
        // A handful of failures before tripping, so one dropped packet does not
        // put a whole city on estimated distances for half a minute.
        volumeThreshold: 5,
        resetTimeout: 30_000,
      },
    );
    this.breaker.on('open', () =>
      this.logger.warn('Routes API circuit OPEN — quoting on estimated road distance.'),
    );
    this.breaker.on('halfOpen', () => this.logger.log('Routes API circuit half-open.'));
    this.breaker.on('close', () => this.logger.log('Routes API circuit CLOSED.'));
  }

  /**
   * Road distance and duration from pickup to dropoff. Never throws: every
   * failure resolves to the detour estimate.
   */
  async estimate(pickup: RoutePoint, dropoff: RoutePoint): Promise<RouteEstimate> {
    const straightLineMeters = haversineMeters(pickup, dropoff);
    if (this.breaker === null || straightLineMeters < ROUTE_MIN_STRAIGHT_LINE_METERS) {
      return this.approximate(straightLineMeters);
    }

    const key = cacheKey(pickup, dropoff);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    // resolveRoute never rejects, so the entry is always cleared and a waiter
    // can never be handed a rejection meant for somebody else's request.
    const lookup = this.resolveRoute(this.breaker, key, pickup, dropoff, straightLineMeters).finally(
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /**
   * Road cost from many origins to one destination, in a single call.
   *
   * This exists for dispatch. Ranking candidate drivers by straight-line
   * distance gets the river case wrong: a driver 5 km away on the far bank is
   * 10 km by road, while one 6 km away beside the bridge is 7 km. Straight-line
   * offers the ride to the first driver, the rider waits longer, and the driver
   * makes a long dead leg — so the shortlist has to be re-ranked on real road
   * time before offers go out.
   *
   * One batched request for the whole shortlist, not one per driver: the matrix
   * endpoint bills per origin-destination element, so N origins in one call
   * costs the same elements as N calls but one round trip of latency, inside a
   * dispatch tick where latency is the budget.
   *
   * Never throws and never partially fails: any origin Google could not route —
   * and every origin if the call itself fails — comes back on the detour
   * estimate, flagged `routed: false`. Dispatch degrades to the ordering it
   * used before rather than stalling because a maps provider is slow.
   */
  async estimateMatrix(
    origins: readonly RoutePoint[],
    destination: RoutePoint,
  ): Promise<RouteMatrixLeg[]> {
    const fallback = (): RouteMatrixLeg[] =>
      origins.map((origin, originIndex) => {
        const approx = this.approximate(haversineMeters(origin, destination));
        return {
          originIndex,
          distanceMeters: approx.distanceMeters,
          durationSeconds: approx.durationSeconds,
          routed: false,
        };
      });

    if (this.breaker === null || origins.length === 0) return fallback();

    let response: Response;
    try {
      response = await fetch(COMPUTE_MATRIX_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.googleApiKey ?? '',
          'x-goog-fieldmask': MATRIX_FIELD_MASK,
        },
        body: JSON.stringify({
          origins: origins.map((o) => ({ waypoint: waypoint(o) })),
          destinations: [{ waypoint: waypoint(destination) }],
          travelMode: 'DRIVE',
          routingPreference: this.config.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Route matrix failed, ranking on estimates: ${describeError(error)}`);
      return fallback();
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      this.logger.warn(`Route matrix responded ${response.status}; ranking on estimates.`);
      return fallback();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fallback();
    }

    // Start from the fallback and overwrite what actually routed, so an origin
    // Google omitted keeps a usable number instead of vanishing from the
    // ranking — a dropped candidate is a driver who is never asked at all.
    const legs = fallback();
    if (!Array.isArray(body)) return legs;

    for (const entry of body) {
      const parsed = parseMatrixElement(entry, origins.length);
      if (parsed) legs[parsed.originIndex] = parsed;
    }
    return legs;
  }

  /** Straight-line × detour factor, at the configured average speed. */
  private approximate(straightLineMeters: number): RouteEstimate {
    const distanceMeters = Math.round(straightLineMeters * this.config.detourFactor);
    const durationSeconds = Math.round(
      (distanceMeters / 1000 / this.config.averageSpeedKmh) * 3600,
    );
    return { distanceMeters, durationSeconds, source: 'estimate', cached: false, polyline: null };
  }

  private async resolveRoute(
    breaker: CircuitBreaker<[RoutePoint, RoutePoint], RouteLeg>,
    key: string,
    pickup: RoutePoint,
    dropoff: RoutePoint,
    straightLineMeters: number,
  ): Promise<RouteEstimate> {
    const hit = await this.readCache(key);
    if (hit) return { ...hit, source: 'google', cached: true };

    let leg: RouteLeg;
    try {
      leg = await breaker.fire(pickup, dropoff);
    } catch (error) {
      // While the breaker is open every quote lands here; the 'open' event has
      // already said so once, so do not repeat it per request.
      const message = `Routes API lookup failed, using estimate: ${describeError(error)}`;
      if (breaker.opened) this.logger.debug(message);
      else this.logger.warn(message);
      return this.approximate(straightLineMeters);
    }

    // Awaited, not fired and forgotten: the next quote for this trip is often
    // milliseconds behind, and it should find the route rather than bill again.
    await this.writeCache(key, leg);
    return { ...leg, source: 'google', cached: false };
  }

  private async callRoutesApi(
    apiKey: string,
    pickup: RoutePoint,
    dropoff: RoutePoint,
  ): Promise<RouteLeg> {
    const res = await fetch(COMPUTE_ROUTES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        'x-goog-fieldmask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify({
        origin: waypoint(pickup),
        destination: waypoint(dropoff),
        travelMode: 'DRIVE',
        routingPreference: this.config.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
        computeAlternativeRoutes: false,
        units: 'METRIC',
      }),
      // The breaker's timeout rejects the caller; this one actually cancels the
      // socket, so a hung request does not keep a connection open behind it.
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Routes API responded ${res.status}`);
    }
    const body: unknown = await res.json();
    return parseComputeRoutesResponse(body);
  }

  private async readCache(key: string): Promise<RouteLeg | null> {
    try {
      const raw = await this.redis.client.get(key);
      return raw === null ? null : parseCachedLeg(raw);
    } catch (error) {
      // A cache miss, not a failure: Google still answers. It does mean this
      // quote bills, which is the price of not failing it.
      this.logger.debug(`Route cache read failed: ${describeError(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, leg: RouteLeg): Promise<void> {
    try {
      await this.redis.client.set(
        key,
        JSON.stringify({ d: leg.distanceMeters, s: leg.durationSeconds, p: leg.polyline }),
        'EX',
        this.config.cacheTtlSeconds,
      );
    } catch (error) {
      this.logger.debug(`Route cache write failed: ${describeError(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheKey(pickup: RoutePoint, dropoff: RoutePoint): string {
  const p = (value: number): string => value.toFixed(CACHE_KEY_DECIMALS);
  return `uride:route:v1:${p(pickup.lat)},${p(pickup.lng)}:${p(dropoff.lat)},${p(dropoff.lng)}`;
}

function waypoint(point: RoutePoint): { location: { latLng: { latitude: number; longitude: number } } } {
  return { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull distance and duration out of a computeRoutes response, refusing
 * anything that is not clearly a route. A body with no routes is Google saying
 * the trip is not drivable (an island, a closed crossing); that is a fallback,
 * not a zero-metre fare.
 */
function parseComputeRoutesResponse(body: unknown): RouteLeg {
  if (!isRecord(body) || !Array.isArray(body.routes) || body.routes.length === 0) {
    throw new Error('Routes API returned no route');
  }
  const route: unknown = body.routes[0];
  if (!isRecord(route)) throw new Error('Routes API returned a malformed route');

  // proto3 JSON omits zero-valued scalars, so an absent distance is 0 m, not a
  // malformed reply. Duration is a message and has no such excuse.
  const distance = route.distanceMeters ?? 0;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
    throw new Error('Routes API returned an invalid distance');
  }
  const match = typeof route.duration === 'string' ? DURATION_PATTERN.exec(route.duration) : null;
  const seconds = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(seconds)) throw new Error('Routes API returned an invalid duration');

  // Geometry is best-effort: a route with a usable distance but a missing or
  // malformed polyline should still produce a fare. The map falls back to a
  // straight line for that one trip rather than the whole quote failing over
  // a decoration.
  const encoded = isRecord(route.polyline) ? route.polyline.encodedPolyline : undefined;
  const polyline = typeof encoded === 'string' && encoded.length > 0 ? encoded : null;

  return {
    distanceMeters: Math.round(distance),
    durationSeconds: Math.round(seconds),
    polyline,
  };
}

/**
 * One element of a computeRouteMatrix reply.
 *
 * Returns null — meaning "keep the fallback for this origin" — for anything
 * that is not a usable route: an out-of-range index, a missing originIndex, or
 * a `condition` other than ROUTE_EXISTS. That last one matters: Google reports
 * an unreachable pair as a successful element with no duration, and reading
 * that as zero would rank an unreachable driver first.
 */
function parseMatrixElement(entry: unknown, originCount: number): RouteMatrixLeg | null {
  if (!isRecord(entry)) return null;

  // proto3 JSON omits zero-valued scalars, so an absent originIndex is 0.
  const originIndex = typeof entry.originIndex === 'number' ? entry.originIndex : 0;
  if (!Number.isInteger(originIndex) || originIndex < 0 || originIndex >= originCount) {
    return null;
  }

  const condition = typeof entry.condition === 'string' ? entry.condition : '';
  if (condition && condition !== 'ROUTE_EXISTS') return null;

  const match = typeof entry.duration === 'string' ? DURATION_PATTERN.exec(entry.duration) : null;
  const seconds = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(seconds)) return null;

  const distance = entry.distanceMeters ?? 0;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) return null;

  return {
    originIndex,
    distanceMeters: Math.round(distance),
    durationSeconds: Math.round(seconds),
    routed: true,
  };
}

function parseCachedLeg(raw: string): RouteLeg | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { d, s, p } = parsed;
    if (typeof d !== 'number' || typeof s !== 'number') return null;
    if (!Number.isFinite(d) || !Number.isFinite(s) || d < 0 || s < 0) return null;
    // `p` is absent on entries written before geometry was cached. Those are
    // still perfectly good distances, so serve them with no shape rather than
    // discarding the cache and re-billing every trip in the city at once.
    return { distanceMeters: d, durationSeconds: s, polyline: typeof p === 'string' ? p : null };
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
