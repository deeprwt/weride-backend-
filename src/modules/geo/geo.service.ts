import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DriverId,
  ISODateTime,
  LatLng,
  NearbyDriver,
  RideClass,
  VehicleId,
} from '@uride/types';
import type { LocationPingInput, NearbyDriversQueryInput } from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import {
  H3DriverIndexService,
  type AvailabilityStatus,
  type IndexAuthority,
  type IndexedPing,
  type StatusObservation,
} from './h3-driver-index.service';

/** What a ping write actually did, for the caller's response and for logging. */
export interface LocationWriteResult {
  /**
   * Points accepted for the breadcrumb trail. They reach Postgres a flush tick
   * later, and points recorded outside a ride may be thinned by sampling there.
   */
  pointsRecorded: number;
  /**
   * False when the ping lost to a newer live position already held for the
   * driver, or was too old to be anyone's live position. It still joins the
   * trail either way.
   */
  availabilityUpdated: boolean;
  /** Capture time of the newest ping accepted; null when nothing was accepted. */
  latestRecordedAt: ISODateTime | null;
}

/**
 * One point of the breadcrumb trail on its way to driver_locations — what
 * GeoService queues on the hot path and LocationFlushWorker hands back in bulk.
 */
export interface TrailPoint {
  driverId: string;
  rideId: string | null;
  lat: number;
  lng: number;
  headingDegrees: number | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  recordedAtMs: number;
}

/**
 * The Redis list pings are queued on. Producers RPUSH to the tail; only the
 * flush worker, under its lock, ever takes from the head.
 */
export const LOCATION_TRAIL_QUEUE_KEY = 'uride:geo:trail:queue';

/**
 * Oldest ping still worth storing.
 *
 * driver_locations is partitioned by month and old partitions get detached by
 * the rotation job, so a ping from a device that sat in a drawer for a week can
 * target a partition that no longer exists — the insert would fail and take the
 * rest of the flush down with it.
 */
const MAX_PING_BACKFILL_MS = 24 * 60 * 60 * 1000;

/** Row shapes returned by the raw queries below — snake_case, straight from Postgres. */
interface NearbyDriverRow {
  driver_id: string;
  vehicle_id: string;
  ride_class: string;
  lat: number;
  lng: number;
  distance_meters: number;
  heading_degrees: number | null;
  last_ping_at: Date;
  rating_avg: number | null;
}

interface LastLocationRow {
  driver_id: string;
  lat: number;
  lng: number;
}

interface DriverIdRow {
  driver_id: string;
}

interface AvailabilityStatusRow {
  driver_id: string;
  status: string;
  current_ride_id: string | null;
}

/** A ping paired with the timestamp it will actually be filed under. */
interface ResolvedPing {
  ping: LocationPingInput;
  recordedAt: Date;
}

/**
 * GeoService — the single owner of spatial SQL.
 *
 * Prisma models neither a geography column nor a partitioned table, so every
 * read and write touching driver_availability.last_location or driver_locations
 * is raw SQL and lives here instead of being spread across the modules that
 * need it. One class is what keeps the PostGIS invariants — axis order, SRID,
 * index-friendly predicates — reviewable in one sitting.
 *
 * Location pings no longer touch Postgres. A ping moves the driver in the H3
 * index (Redis) and joins a queue; LocationFlushWorker writes the trail and
 * refreshes availability in bulk, through the two batch methods below. Every
 * spatial statement is still in this file — the worker decides WHEN, this
 * class decides WHAT is written and how.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  private readonly maxRadiusMeters: number;
  private readonly staleAfterSeconds: number;
  private readonly heartbeatSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly index: H3DriverIndexService,
  ) {
    const env = loadEnv();
    this.maxRadiusMeters = env.DRIVER_MAX_SEARCH_RADIUS_METERS;
    this.staleAfterSeconds = env.DRIVER_LOCATION_STALE_SECONDS;
    this.heartbeatSeconds = env.DRIVER_ONLINE_HEARTBEAT_SECONDS;
  }

  // -------------------------------------------------------------------------
  // Writes — location pings (the hot path)
  // -------------------------------------------------------------------------

  /**
   * Record one live ping: move the driver in the live index and queue the point
   * for the trail. Redis only, a few commands.
   *
   * This used to be a Postgres transaction per frame — an INSERT into the
   * partitioned trail plus an upsert of the hottest row in the database — and at
   * a few thousand online drivers that is thousands of transactions a second
   * through a connection pooler, for data nothing reads until much later. The
   * index answers dispatch now; the trail can arrive a second late and in bulk.
   *
   * Index first, queue second. A ping from someone with no driver profile fails
   * in the index step (see resolveAvailability) and never reaches the trail; a
   * queue write that fails after the index moved fails the request, the app
   * retries, and the retry re-applies the same capture time harmlessly.
   */
  async recordLocation(
    driverId: string,
    ping: LocationPingInput,
    rideId?: string,
  ): Promise<LocationWriteResult> {
    const recordedAt = this.resolveRecordedAt(ping.recordedAt);
    if (!recordedAt) {
      throw new BadRequestException({
        code: 'ping_too_old',
        message: 'This position was recorded too long ago to be accepted.',
      });
    }
    return this.acceptPings(driverId, [{ ping, recordedAt }], rideId ?? null);
  }

  /**
   * Flush a queue of pings the driver app buffered through a connectivity gap.
   *
   * Every ping joins the trail, but only the newest one is offered to the live
   * index: replaying the queue oldest-first through the single-ping path would
   * park the driver at their oldest position until the final ping landed.
   * Pings past the backfill window are dropped rather than failing the flush —
   * the app cannot go back and fix a timestamp it has already captured.
   */
  async recordLocationBatch(
    driverId: string,
    pings: readonly LocationPingInput[],
    rideId?: string,
  ): Promise<LocationWriteResult> {
    const resolved: ResolvedPing[] = [];
    for (const ping of pings) {
      const recordedAt = this.resolveRecordedAt(ping.recordedAt);
      if (recordedAt) resolved.push({ ping, recordedAt });
    }

    const dropped = pings.length - resolved.length;
    if (dropped > 0) {
      this.logger.debug(`Dropped ${dropped} out-of-window ping(s) from driver ${driverId}.`);
    }
    if (resolved.length === 0) {
      return { pointsRecorded: 0, availabilityUpdated: false, latestRecordedAt: null };
    }
    return this.acceptPings(driverId, resolved, rideId ?? null);
  }

  // -------------------------------------------------------------------------
  // Writes — bulk, for LocationFlushWorker
  // -------------------------------------------------------------------------

  /**
   * Append to driver_locations, the append-only trail behind trip replay and
   * fare disputes, in ONE multi-row INSERT per call.
   *
   * Throws the raw Prisma error on failure: the worker decides whether a failed
   * batch is retried, held for ops (a missing partition) or dead-lettered, and
   * it needs the SQLSTATE to do that — see {@link sqlStateOf}.
   *
   * Every parameter carries an explicit cast. Prisma sends bind parameters
   * untyped, so Postgres has nothing to infer from when the value is NULL — an
   * uncast null heading fails the statement with "could not determine data type
   * of parameter" instead of storing a null.
   */
  async appendTrail(points: readonly TrailPoint[]): Promise<void> {
    if (points.length === 0) return;

    // ST_MakePoint takes (LONGITUDE, LATITUDE) — X before Y. Swapping the two
    // is the classic PostGIS bug and it fails silently: (lat, lng) is still a
    // perfectly valid point, just one out in the Gulf of Guinea, so nothing
    // errors and the driver simply never matches a search again.
    const values = points.map(
      (p) => Prisma.sql`(
        ${p.driverId}::uuid,
        ${p.rideId}::uuid,
        ST_SetSRID(
          ST_MakePoint(${p.lng}::double precision, ${p.lat}::double precision),
          4326
        )::geography,
        ${p.headingDegrees}::real,
        ${p.speedMps}::real,
        ${p.accuracyMeters}::real,
        ${new Date(p.recordedAtMs)}::timestamptz
      )`,
    );

    await this.prisma.$executeRaw`
      INSERT INTO "driver_locations" (
        "driver_id", "ride_id", "location",
        "heading_degrees", "speed_mps", "accuracy_meters", "recorded_at"
      ) VALUES ${Prisma.join(values)}
    `;
  }

  /**
   * Refresh driver_availability's position columns from each driver's newest
   * point, in one UPDATE, and report what status Postgres holds for them.
   *
   * Callers pass at most one point per driver — UPDATE … FROM applies an
   * arbitrary one of several matches. The newest-wins guard is the same one the
   * per-ping upsert used, so a batch that arrives late never drags a driver back
   * to a corner a newer write has already moved them past.
   *
   * UPDATE only, never INSERT: a row is created when a driver first goes online
   * (see resolveAvailability), and an INSERT here would put a foreign key on the
   * batch path, where one ping from a user with no driver profile would fail
   * everyone else's refresh with it.
   *
   * The returned statuses are what keeps the live index honest — the worker
   * reconciles them into it. Rows the guard skipped are not returned.
   */
  async refreshAvailability(points: readonly TrailPoint[]): Promise<StatusObservation[]> {
    if (points.length === 0) return [];

    const values = points.map(
      (p) => Prisma.sql`(
        ${p.driverId}::uuid,
        ${p.lat}::double precision,
        ${p.lng}::double precision,
        ${p.headingDegrees}::real,
        ${p.speedMps}::real,
        ${new Date(p.recordedAtMs)}::timestamptz
      )`,
    );

    // LONGITUDE first again — see appendTrail.
    const rows = await this.prisma.$queryRaw<AvailabilityStatusRow[]>`
      UPDATE "driver_availability" AS a
         SET "last_location"   = ST_SetSRID(ST_MakePoint(v."lng", v."lat"), 4326)::geography,
             "heading_degrees" = v."heading_degrees",
             "speed_mps"       = v."speed_mps",
             "last_ping_at"    = v."recorded_at",
             "updated_at"      = now()
        FROM (VALUES ${Prisma.join(values)})
          AS v("driver_id", "lat", "lng", "heading_degrees", "speed_mps", "recorded_at")
       WHERE a."driver_id" = v."driver_id"
         AND (a."last_ping_at" IS NULL OR v."recorded_at" >= a."last_ping_at")
      RETURNING a."driver_id", a."status", a."current_ride_id"
    `;

    return rows.map((r) => ({
      driverId: r.driver_id,
      status: toAvailabilityStatus(r.status),
      rideId: r.current_ride_id,
    }));
  }

  // -------------------------------------------------------------------------
  // Reads — dispatch
  // -------------------------------------------------------------------------

  /**
   * The dispatch query: online, eligible drivers inside a radius, nearest first.
   *
   * Why ST_DWithin instead of just `ORDER BY ST_Distance(...) LIMIT n`:
   * ST_DWithin is the form the GiST index can answer. Postgres rewrites it into
   * a bounding-box search against "driver_availability_location_gix" plus an
   * exact recheck, so only drivers actually near the pickup are ever visited.
   * ST_Distance in a WHERE or ORDER BY is an ordinary function call with no
   * index behind it: the planner would compute a spheroid distance for every
   * online driver in the country and sort the lot. Both spellings return the
   * same rows — only one of them stays flat as the fleet grows. The ORDER BY
   * then sorts the handful ST_DWithin let through, which is why ordering on
   * true distance is still cheap.
   *
   * `status = 'online'` is a literal and not a bound parameter on purpose: the
   * index is partial (WHERE status = 'online') and the planner can only prove a
   * query qualifies for it when the predicate is a constant at plan time. A
   * parameter yields a generic plan that quietly falls back to a full scan.
   */
  async findNearbyDrivers(query: NearbyDriversQueryInput): Promise<NearbyDriver[]> {
    // A request may ask for a tighter search than the platform default, never a
    // wider or a staler one — dispatch quality is an operator decision, and the
    // radius ceiling is what keeps one request from scanning the whole country.
    const radiusMeters = Math.min(query.radiusMeters, this.maxRadiusMeters);
    const maxAgeSeconds = Math.min(query.maxAgeSeconds, this.staleAfterSeconds);
    const freshAfter = new Date(Date.now() - maxAgeSeconds * 1000);
    const rideClass = query.rideClass ?? null;

    const rows = await this.prisma.$queryRaw<NearbyDriverRow[]>`
      SELECT
        a."driver_id",
        a."vehicle_id",
        v."ride_class",
        -- Read back the mirror image of how it went in: on a point, ST_X is
        -- longitude and ST_Y is latitude.
        ST_Y(a."last_location"::geometry) AS "lat",
        ST_X(a."last_location"::geometry) AS "lng",
        ST_Distance(
          a."last_location",
          ST_SetSRID(
            ST_MakePoint(${query.lng}::double precision, ${query.lat}::double precision),
            4326
          )::geography
        ) AS "distance_meters",
        a."heading_degrees",
        a."last_ping_at",
        -- Cast to double precision so Prisma hands back a number; a numeric
        -- would arrive as a Decimal object and leak into the wire payload.
        CASE WHEN p."rating_count" > 0
          THEN ROUND(p."rating_sum"::numeric / p."rating_count", 2)::double precision
        END AS "rating_avg"
      FROM "driver_availability" a
      JOIN "vehicles" v
        ON v."id" = a."vehicle_id"
       AND v."driver_id" = a."driver_id"
       AND v."status" = 'approved'
       AND v."is_active"
      JOIN "driver_profiles" p
        ON p."user_id" = a."driver_id"
       AND p."kyc_status" = 'approved'
      WHERE a."status" = 'online'
        AND a."last_ping_at" >= ${freshAfter}::timestamptz
        AND ST_DWithin(
          a."last_location",
          ST_SetSRID(
            ST_MakePoint(${query.lng}::double precision, ${query.lat}::double precision),
            4326
          )::geography,
          ${radiusMeters}::double precision
        )
        AND (${rideClass}::text IS NULL OR v."ride_class" = ${rideClass}::text)
      ORDER BY "distance_meters" ASC
      LIMIT ${query.limit}::int
    `;

    return rows.map(toNearbyDriver);
  }

  /**
   * Spheroid distance between two points, in metres.
   *
   * Round-trips to Postgres rather than doing haversine in Node so every
   * distance the platform quotes — fares, ETAs, "your driver is 200 m away" —
   * comes off the same geodesic that matching ordered candidates by.
   */
  async distanceMeters(a: LatLng, b: LatLng): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ meters: number }[]>`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(${a.lng}::double precision, ${a.lat}::double precision), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${b.lng}::double precision, ${b.lat}::double precision), 4326)::geography
      ) AS "meters"
    `;
    const [row] = rows;
    if (!row) {
      throw new InternalServerErrorException({
        code: 'distance_unavailable',
        message: 'Could not compute the distance between those points.',
      });
    }
    return Math.round(row.meters);
  }

  /**
   * Last known position of one driver, or null if they have never pinged.
   *
   * Callers need this because `last_location` is `Unsupported` in the Prisma
   * schema and therefore absent from the generated client — DriversService
   * cannot read it even though it owns every other column on the row.
   */
  async getLastLocation(driverId: string): Promise<LatLng | null> {
    const found = await this.getLastLocations([driverId]);
    return found.get(driverId) ?? null;
  }

  /** Batch form of {@link getLastLocation} — one query for a whole admin page. */
  async getLastLocations(driverIds: readonly string[]): Promise<Map<string, LatLng>> {
    if (driverIds.length === 0) return new Map();

    const ids = Prisma.join(driverIds.map((id) => Prisma.sql`${id}::uuid`));
    const rows = await this.prisma.$queryRaw<LastLocationRow[]>`
      SELECT
        "driver_id",
        ST_Y("last_location"::geometry) AS "lat",
        ST_X("last_location"::geometry) AS "lng"
      FROM "driver_availability"
      WHERE "driver_id" IN (${ids})
        AND "last_location" IS NOT NULL
    `;
    return new Map(
      rows.map((r): [string, LatLng] => [r.driver_id, { lat: r.lat, lng: r.lng }]),
    );
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Sweep drivers who stopped reporting: a killed app or a flat battery leaves
   * `online` behind, and the dispatcher would go on offering rides to a driver
   * frozen at the corner where their phone died.
   *
   * Only `online` rows are touched. A driver mid-trip stays `on_trip` even when
   * their phone goes quiet — dropping them would orphan a live ride, and the
   * trip-consistency CHECK would reject the write anyway while current_ride_id
   * is still set. Returns the swept drivers so the caller can tell them they
   * were taken offline.
   */
  async clearStaleDrivers(): Promise<DriverId[]> {
    const cutoff = new Date(Date.now() - this.heartbeatSeconds * 1000);
    const rows = await this.prisma.$queryRaw<DriverIdRow[]>`
      UPDATE "driver_availability"
         SET "status" = 'offline',
             "updated_at" = now()
       WHERE "status" = 'online'
         AND ("last_ping_at" IS NULL OR "last_ping_at" < ${cutoff}::timestamptz)
      RETURNING "driver_id"
    `;

    if (rows.length > 0) {
      this.logger.warn(
        `Swept ${rows.length} driver(s) offline after ${this.heartbeatSeconds}s without a ping.`,
      );
    }
    return rows.map((r) => r.driver_id as DriverId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Shared body behind both ping entry points: index the newest, queue them all. */
  private async acceptPings(
    driverId: string,
    points: readonly ResolvedPing[],
    rideId: string | null,
  ): Promise<LocationWriteResult> {
    const newest = points.reduce((a, b) => (b.recordedAt > a.recordedAt ? b : a));

    const availabilityUpdated = await this.placeLivePosition(driverId, newest);
    await this.enqueueTrail(driverId, points, rideId);

    return {
      pointsRecorded: points.length,
      availabilityUpdated,
      latestRecordedAt: newest.recordedAt.toISOString() as ISODateTime,
    };
  }

  /**
   * Offer a ping to the live index. The out-of-order guard lives in the index
   * script now — a retried older packet is compared against the capture time
   * Redis holds, atomically, and loses without moving the driver.
   *
   * The one Postgres touch left on this path is the `cold` case: the index has
   * never heard of this driver, or forgot them after a heartbeat of silence. It
   * cannot guess their status — a ping must never put a driver into dispatch —
   * so it asks Postgres once, and every ping after that is Redis-only again.
   * That is one small statement per driver per session, not per frame.
   *
   * Returns true when the ping became the live position, and for a driver who
   * is offline (nothing newer held it back; the trail and the availability
   * refresh still file it).
   */
  private async placeLivePosition(driverId: string, point: ResolvedPing): Promise<boolean> {
    const ping: IndexedPing = {
      driverId,
      lat: point.ping.location.lat,
      lng: point.ping.location.lng,
      headingDegrees: point.ping.headingDegrees ?? null,
      speedMps: point.ping.speedMps ?? null,
      recordedAtMs: point.recordedAt.getTime(),
    };

    let result = await this.onLocationStore(driverId, () => this.index.recordPing(ping));
    if (result.outcome === 'cold') {
      const authority = await this.resolveAvailability(driverId, point, result.serverTimeMs);
      result = await this.onLocationStore(driverId, () => this.index.recordPing(ping, authority));
    }
    return result.outcome === 'applied' || result.outcome === 'offline';
  }

  /**
   * Resolve a cold driver's status, writing their position on the way.
   *
   * An upsert, not a read, for two reasons that both predate the index. Going
   * online for the first time relies on it: DriversService.goOnline pings
   * BEFORE it flips status, and its UPDATE needs the row this creates. And the
   * row's foreign key to driver_profiles is what turns a ping from an account
   * that never applied to drive into a clean 404 instead of an index entry.
   *
   * One statement: the CTE upserts and returns the row it wrote; when the
   * newest-wins guard declined to write (an older ping), the second branch
   * reads the existing row instead, from the same snapshot.
   *
   * `readAtMs` is the Redis clock BEFORE this query, so a status some other
   * request writes to the index while we wait on Postgres outranks our answer.
   */
  private async resolveAvailability(
    driverId: string,
    point: ResolvedPing,
    readAtMs: number,
  ): Promise<IndexAuthority> {
    const { ping, recordedAt } = point;

    let rows: AvailabilityStatusRow[];
    try {
      // LONGITUDE first — see appendTrail.
      rows = await this.prisma.$queryRaw<AvailabilityStatusRow[]>`
        WITH "upserted" AS (
          INSERT INTO "driver_availability" (
            "driver_id", "last_location", "heading_degrees", "speed_mps", "last_ping_at", "updated_at"
          ) VALUES (
            ${driverId}::uuid,
            ST_SetSRID(
              ST_MakePoint(${ping.location.lng}::double precision, ${ping.location.lat}::double precision),
              4326
            )::geography,
            ${ping.headingDegrees ?? null}::real,
            ${ping.speedMps ?? null}::real,
            ${recordedAt}::timestamptz,
            now()
          )
          ON CONFLICT ("driver_id") DO UPDATE SET
            "last_location"   = EXCLUDED."last_location",
            "heading_degrees" = EXCLUDED."heading_degrees",
            "speed_mps"       = EXCLUDED."speed_mps",
            "last_ping_at"    = EXCLUDED."last_ping_at",
            "updated_at"      = now()
          WHERE "driver_availability"."last_ping_at" IS NULL
             OR EXCLUDED."last_ping_at" >= "driver_availability"."last_ping_at"
          RETURNING "driver_id", "status", "current_ride_id"
        )
        SELECT "driver_id", "status", "current_ride_id" FROM "upserted"
        UNION ALL
        SELECT "driver_id", "status", "current_ride_id" FROM "driver_availability"
         WHERE "driver_id" = ${driverId}::uuid
           AND NOT EXISTS (SELECT 1 FROM "upserted")
      `;
    } catch (error) {
      throw this.asWriteException(error);
    }

    const [row] = rows;
    if (!row) {
      throw new InternalServerErrorException({
        code: 'availability_unavailable',
        message: 'Could not read the driver availability record.',
      });
    }
    return {
      status: toAvailabilityStatus(row.status),
      rideId: row.current_ride_id,
      readAtMs,
    };
  }

  /** Queue every point for the trail in one RPUSH. */
  private async enqueueTrail(
    driverId: string,
    points: readonly ResolvedPing[],
    rideId: string | null,
  ): Promise<void> {
    const payloads = points.map(({ ping, recordedAt }) =>
      encodeTrailPoint({
        driverId,
        rideId,
        lat: ping.location.lat,
        lng: ping.location.lng,
        headingDegrees: ping.headingDegrees ?? null,
        speedMps: ping.speedMps ?? null,
        accuracyMeters: ping.accuracyMeters ?? null,
        recordedAtMs: recordedAt.getTime(),
      }),
    );
    await this.onLocationStore(driverId, () =>
      this.redis.client.rpush(LOCATION_TRAIL_QUEUE_KEY, ...payloads),
    );
  }

  /**
   * Redis being unreachable is the same answer to a driver as Postgres being
   * unreachable used to be: tracking is briefly unavailable, keep your queue and
   * retry. Nest exceptions pass through untouched — they already are answers.
   */
  private async onLocationStore<T>(driverId: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Location store failed for driver ${driverId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        code: 'location_storage_unavailable',
        message: 'Location tracking is temporarily unavailable.',
      });
    }
  }

  /**
   * Decide which timestamp a ping is filed under.
   *
   * Device clocks drift and phones buffer positions for hours, so the client's
   * capture time is evidence rather than truth. A timestamp in the future is
   * pulled back to now: a phone running an hour fast would otherwise look
   * permanently fresh to dispatch while its trail rows aimed past the newest
   * monthly partition. Anything beyond the backfill window is refused (null).
   * Keeping the client's time instead of now() is the whole point — it is what
   * lets the freshness filter in the index and in findNearbyDrivers tell a
   * driver who is out there now from one whose app just uploaded yesterday's
   * queue.
   */
  private resolveRecordedAt(raw: string | undefined): Date | null {
    const now = Date.now();
    if (!raw) return new Date(now);

    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed) || parsed > now) return new Date(now);
    if (parsed < now - MAX_PING_BACKFILL_MS) return null;
    return new Date(parsed);
  }

  /**
   * Raw SQL skips Prisma's error mapping, so every failure arrives as a generic
   * P2010 wrapping a SQLSTATE. The only one the hot path can provoke is the
   * availability row's foreign key; anything else is handed back untouched to
   * surface as a 500, which is the honest answer for a bug in a query only we
   * can write. (A missing trail partition, 23514, can no longer reach a request
   * at all — the flush worker meets it, and holds the batch for ops.)
   */
  private asWriteException(error: unknown): unknown {
    // 23503: the availability row's FK to driver_profiles. The caller is a user
    // who never applied to drive, not a broken query.
    if (sqlStateOf(error) === '23503') {
      return new NotFoundException({
        code: 'driver_not_found',
        message: 'No driver profile exists for this account.',
      });
    }
    return error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The SQLSTATE inside a raw-query failure, or null when it is not one. */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = error.meta as { code?: unknown } | undefined;
  return typeof meta?.code === 'string' ? meta.code : null;
}

/**
 * Queue wire form. Short keys because at fleet scale this list is the largest
 * thing in Redis, and "recordedAtMs" spelled out on every point is a measurable
 * slice of it.
 */
interface QueuedTrailPoint {
  d: string;
  r: string | null;
  la: number;
  ln: number;
  h: number | null;
  s: number | null;
  a: number | null;
  t: number;
}

export function encodeTrailPoint(p: TrailPoint): string {
  const wire: QueuedTrailPoint = {
    d: p.driverId,
    r: p.rideId,
    la: p.lat,
    ln: p.lng,
    h: p.headingDegrees,
    s: p.speedMps,
    a: p.accuracyMeters,
    t: p.recordedAtMs,
  };
  return JSON.stringify(wire);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse and re-validate a queued point, or null if it can never be stored.
 *
 * Re-validated even though only this file writes the queue: a value that
 * cannot be cast (a malformed uuid, a NaN) would fail the whole multi-row
 * INSERT on every retry, and one bad point must not hold up everyone else's.
 */
export function decodeTrailPoint(raw: string): TrailPoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const w = parsed as Partial<Record<keyof QueuedTrailPoint, unknown>>;

  if (typeof w.d !== 'string' || !UUID_PATTERN.test(w.d)) return null;
  let rideId: string | null;
  if (w.r === null) rideId = null;
  else if (typeof w.r === 'string' && UUID_PATTERN.test(w.r)) rideId = w.r;
  else return null;
  if (!isFiniteInRange(w.la, -90, 90) || !isFiniteInRange(w.ln, -180, 180)) return null;
  if (!isFiniteInRange(w.t, 0, Number.MAX_SAFE_INTEGER)) return null;

  const optional = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const h = optional(w.h);
  const s = optional(w.s);
  const a = optional(w.a);
  if (h === undefined || s === undefined || a === undefined) return null;

  return {
    driverId: w.d,
    rideId,
    lat: w.la,
    lng: w.ln,
    headingDegrees: h,
    speedMps: s,
    accuracyMeters: a,
    recordedAtMs: w.t,
  };
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** The CHECK constraint allows only these three; anything else is treated as not dispatchable. */
function toAvailabilityStatus(raw: string): AvailabilityStatus {
  return raw === 'online' || raw === 'on_trip' ? raw : 'offline';
}

/** Map a dispatch row to the wire shape: nested coords, ISO timestamps, branded ids. */
function toNearbyDriver(row: NearbyDriverRow): NearbyDriver {
  return {
    driverId: row.driver_id as DriverId,
    vehicleId: row.vehicle_id as VehicleId,
    rideClass: row.ride_class as RideClass,
    location: { lat: row.lat, lng: row.lng },
    // Whole metres: GPS is good to a handful of them, so the extra decimals
    // PostGIS returns are noise the apps would render as false precision.
    distanceMeters: Math.round(row.distance_meters),
    headingDegrees: row.heading_degrees,
    lastPingAt: row.last_ping_at.toISOString() as ISODateTime,
    ratingAvg: row.rating_avg,
  };
}
