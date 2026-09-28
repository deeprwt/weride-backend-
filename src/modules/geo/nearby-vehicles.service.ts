import { Injectable, Logger } from '@nestjs/common';
import type { RideClass } from '@uride/types';
import { RedisService } from '../../common/redis/redis.module';
import { GeoService } from './geo.service';

/** What a rider is allowed to see about an available vehicle. */
export interface NearbyVehicle {
  lat: number;
  lng: number;
  /** Degrees clockwise from north, for rotating the marker. Null when unknown. */
  headingDegrees: number | null;
  rideClass: RideClass;
}

export interface NearbyVehiclesResult {
  vehicles: NearbyVehicle[];
  /** How many were found before the display cap, for "12 cars nearby" copy. */
  total: number;
  /**
   * Approximate ROAD metres to the closest available vehicle, or null when
   * there are none.
   *
   * Straight-line distance times a detour factor, not a route: this is an
   * availability hint drawn before a ride exists, and routing to every car on
   * the map would bill a request per marker per refresh. Returning the raw
   * crow's-flight number would be worse than approximating — it reads as
   * precise and is always optimistic, so "2 min away" becomes a five-minute
   * wait. The real routed ETA is computed once, when a driver accepts.
   */
  nearestMeters: number | null;
}

/**
 * NearbyVehiclesService — the moving cars a rider sees on the booking map.
 *
 * A thin, deliberately lossy projection of GeoService.findNearbyDrivers. The
 * dispatch view of a driver carries their id, vehicle id, rating and exact
 * distance; none of that may reach a rider, because together they turn a
 * public map into a tool for following one particular driver around a city.
 * What survives is a point, a heading and a class — enough to draw a car
 * pointing the right way, and nothing that identifies whose car it is.
 *
 * Positions are also snapped to a coarse grid (see SNAP_DECIMALS). Exact
 * coordinates refreshed every few seconds would let a rider reconstruct a
 * driver's precise path even without an id to hang it on.
 *
 * Cached for a few seconds per grid cell and class: every rider looking at the
 * same part of the city shares one PostGIS query, and a rider panning the map
 * cannot turn a finger drag into a query per frame.
 */
@Injectable()
export class NearbyVehiclesService {
  private readonly logger = new Logger(NearbyVehiclesService.name);

  constructor(
    private readonly geo: GeoService,
    private readonly redis: RedisService,
  ) {}

  async find(input: {
    lat: number;
    lng: number;
    rideClass: RideClass | null;
    radiusMeters: number;
  }): Promise<NearbyVehiclesResult> {
    const key = cacheKey(input);

    const cached = await this.readCache(key);
    if (cached) return cached;

    const drivers = await this.geo.findNearbyDrivers({
      lat: input.lat,
      lng: input.lng,
      radiusMeters: input.radiusMeters,
      rideClass: input.rideClass ?? undefined,
      // Asking for more than we draw would cost a wider scan for markers the
      // rider never sees; asking for exactly MAX_MARKERS would make "total"
      // useless as a count. This is the compromise.
      limit: MAX_MARKERS,
      maxAgeSeconds: FRESHNESS_SECONDS,
    });

    const result: NearbyVehiclesResult = {
      vehicles: drivers.slice(0, MAX_MARKERS).map((d) => ({
        lat: snap(d.location.lat),
        lng: snap(d.location.lng),
        headingDegrees: d.headingDegrees,
        rideClass: d.rideClass,
      })),
      total: drivers.length,
      nearestMeters:
        drivers.length > 0
          ? Math.round(drivers[0].distanceMeters * ROAD_DETOUR_FACTOR)
          : null,
    };

    await this.writeCache(key, result);
    return result;
  }

  private async readCache(key: string): Promise<NearbyVehiclesResult | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return isResult(parsed) ? parsed : null;
    } catch (error) {
      // A cache miss, not a failure. The query still runs.
      this.logger.debug(`Nearby cache read failed: ${describe(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, value: NearbyVehiclesResult): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.debug(`Nearby cache write failed: ${describe(error)}`);
    }
  }
}

/**
 * ~110 m of latitude. Fine enough that a car still appears on the right block
 * and moves visibly between refreshes, coarse enough that successive positions
 * do not reconstruct an exact route.
 */
const SNAP_DECIMALS = 3;

/**
 * Markers drawn on the map. Past roughly a dozen the map reads as noise and
 * each extra marker is payload and render cost for no information gained.
 */
const MAX_MARKERS = 12;

/**
 * Only drivers who pinged this recently are drawn. A stale marker is worse than
 * a missing one: it promises a car that is not there.
 */
const FRESHNESS_SECONDS = 45;

/**
 * Long enough that panning the map does not bill a query per frame, short
 * enough that the cars still visibly move. Cars are drawn as an availability
 * hint, not a live tracker — that fidelity is reserved for the assigned driver
 * during a trip, which comes over the socket instead.
 */
const CACHE_TTL_SECONDS = 8;

/**
 * Straight-line to approximate-road. Matches the factor dispatch uses for offer
 * estimates, so the distance a rider sees before booking and the one a driver
 * is offered come from the same arithmetic instead of drifting apart.
 */
const ROAD_DETOUR_FACTOR = 1.3;

function snap(value: number): number {
  return Number(value.toFixed(SNAP_DECIMALS));
}

/**
 * Keyed on the same grid the positions are snapped to, so every rider looking
 * at one neighbourhood shares a single query.
 */
function cacheKey(input: {
  lat: number;
  lng: number;
  rideClass: RideClass | null;
  radiusMeters: number;
}): string {
  const cls = input.rideClass ?? 'any';
  return `uride:nearby:v1:${cls}:${input.radiusMeters}:${snap(input.lat)},${snap(input.lng)}`;
}

function isResult(value: unknown): value is NearbyVehiclesResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.vehicles) &&
    typeof v.total === 'number' &&
    (v.nearestMeters === null || typeof v.nearestMeters === 'number')
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
