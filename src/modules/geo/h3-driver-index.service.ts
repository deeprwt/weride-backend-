import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  cellToBoundary,
  cellToChildren,
  cellToLatLng,
  getResolution,
  gridDiskDistances,
  isValidCell,
  latLngToCell,
} from 'h3-js';
import type { ChainableCommander } from 'ioredis';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';

// ===========================================================================
// Public contract — dispatch, surge and live ETA all code against this block.
// ===========================================================================

/** ~0.53 km edge. Fine enough that ring 1 is "a few blocks", coarse enough that a city is a few thousand keys. */
export const H3_DISPATCH_RESOLUTION = 8;
/** ~1.4 km edge. Pricing zones: small enough to follow a stadium letting out, big enough to hold a count. */
export const H3_SURGE_RESOLUTION = 7;

export type IndexedDriverStatus = 'online' | 'on_trip';

export interface IndexedDriverPosition {
  driverId: string;
  lat: number;
  lng: number;
  headingDegrees: number | null;
  speedMps: number | null;
  recordedAtMs: number;
  rideId: string | null;
  status: IndexedDriverStatus;
  /** Res-8 H3 cell. */
  cell: string;
}

export interface NearbyIndexedDriver extends IndexedDriverPosition {
  /** Haversine metres from the search origin. */
  distanceMeters: number;
  /** gridDisk ring (0 = same cell) the driver was found in. */
  ring: number;
}

// ---------------------------------------------------------------------------
// GeoModule-internal surface. Exported because GeoService and the flush
// worker live in sibling files, not because other modules should call it: the
// rest of the platform changes a driver's index state through upsert /
// setStatus / remove, and only GeoService may resolve a ping against Postgres.
// ---------------------------------------------------------------------------

/** A raw position from a ping. Status and ride are never taken from a ping. */
export type IndexedPing = Omit<IndexedDriverPosition, 'cell' | 'status' | 'rideId'>;

/** The availability status as Postgres records it, including the one the index never holds. */
export type AvailabilityStatus = IndexedDriverStatus | 'offline';

/**
 * Postgres' answer about a driver, and the Redis clock reading taken before the
 * question was asked. `readAtMs` is what lets an older answer lose to a status
 * written after it — see the "sat" field in the layout notes below.
 */
export interface IndexAuthority {
  status: AvailabilityStatus;
  rideId: string | null;
  readAtMs: number;
}

/**
 * What a ping did to the index.
 *
 *  - `applied`  the ping is now the driver's live position.
 *  - `stale`    a newer position was already held; nothing moved.
 *  - `expired`  too old to be anyone's live position; trail-only.
 *  - `offline`  the driver is known to be offline; trail-only.
 *  - `cold`     the index knows nothing about this driver — resolve their status
 *               from Postgres and call again with an {@link IndexAuthority}.
 */
export type PingIndexOutcome = 'applied' | 'stale' | 'expired' | 'offline' | 'cold';

export interface PingIndexResult {
  outcome: PingIndexOutcome;
  /** Redis' clock when the script ran. On `cold`, this is the `readAtMs` to pass back. */
  serverTimeMs: number;
}

export interface StatusObservation {
  driverId: string;
  status: AvailabilityStatus;
  rideId: string | null;
}

// ===========================================================================
// Redis layout
// ===========================================================================

const KEY_PREFIX = 'uride:geo:idx:';

/**
 * Longest a search may walk. Ring k's nearest cell centre sits ~0.8k km from
 * the origin at res 8 (measured over Toronto: ring 1 ≥ 934 m, ring 5 ≥ 4047 m),
 * so this is the ring count that covers DRIVER_MAX_SEARCH_RADIUS_METERS — the
 * same ceiling the PostGIS search enforces, spelled in hexagons.
 */
const RES8_RING_STEP_METERS = 800;

/**
 * How long "this driver is offline, do not ask Postgres again" is remembered.
 * The flush worker's reconcile clears a wrong marker within one availability
 * refresh; the TTL is only the backstop if that loop is down.
 */
const OFFLINE_MARKER_TTL_MS = 60_000;

/** Coarsest resolution countOnlineByCell expands: a res-5 cell is already 343 res-8 children. */
const MIN_COUNT_RESOLUTION = 5;

const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Shared Lua preamble.
 *
 * Key names are built inside the scripts rather than passed as KEYS because the
 * cell a driver is LEAVING is only known once the script has read their hash.
 * That is fine on a single Redis node, which is what the platform runs; the
 * route to Redis Cluster is a `{city}` hash tag in KEY_PREFIX so every key a
 * script touches shares a slot, not a different script.
 *
 * Layout (all under KEY_PREFIX):
 *
 *   drv:{driverId}          HASH  lat lng hd sp t ride st cell sat
 *                                  Expires at t + ttl (PEXPIREAT), so the hash
 *                                  dies exactly when its position is too old to
 *                                  be anyone's live position.
 *   cell:{status}:{cell}    ZSET  driverId -> t (capture ms). One per status so
 *                                  "online drivers here" is one key, not a
 *                                  filter over everyone in the cell.
 *   off:{driverId}          STRING Redis-ms of the Postgres read that found them
 *                                  offline. Only ever written from such a read,
 *                                  which is also what guarantees their
 *                                  availability row exists.
 *
 * `sat` (status-at) is the Redis-clock time the status was last written. A
 * status learnt from Postgres carries the time the read BEGAN, so a status a
 * caller wrote after committing its own change always outranks it — that is
 * the whole race between "flush worker read an old row" and "driver just went
 * online".
 */
const LUA_PREAMBLE = `
local PREFIX = ARGV[1]
local function drvKey(id) return PREFIX .. 'drv:' .. id end
local function offKey(id) return PREFIX .. 'off:' .. id end
local function cellKey(st, cell) return PREFIX .. 'cell:' .. st .. ':' .. cell end
local function nowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
-- Move one member between (status, cell) sets. Removal and insertion happen in
-- the same script, so no reader ever sees the driver in two cells or in none.
-- Every insert also prunes members whose hash has expired (score older than
-- the TTL) and keeps the set alive for twice the TTL past its last write, so an
-- abandoned cell empties and then disappears on its own.
local function relocate(id, fromSt, fromCell, toSt, toCell, score, now, ttl)
  if fromSt ~= toSt or fromCell ~= toCell then
    redis.call('ZREM', cellKey(fromSt, fromCell), id)
  end
  local k = cellKey(toSt, toCell)
  redis.call('ZADD', k, score, id)
  redis.call('ZREMRANGEBYSCORE', k, '-inf', '(' .. (now - ttl))
  redis.call('PEXPIRE', k, ttl * 2)
end
`;

/**
 * The hot-path write. ARGV: prefix, id, lat, lng, hd, sp, t, cell, ttlMs,
 * offlineTtlMs, authStatus ('' = none), authRide, authReadAtMs.
 *
 * Status and ride are never taken from the ping: a ping is a position, and
 * letting it decide status is how a phone returning from a dead zone would put
 * itself back into dispatch. They come from the entry already held, or — on a
 * cold entry — from the Postgres authority GeoService resolved.
 */
const RECORD_PING_LUA = `
local id = ARGV[2]
local lat, lng, hd, sp = ARGV[3], ARGV[4], ARGV[5], ARGV[6]
local t = tonumber(ARGV[7])
local cell = ARGV[8]
local ttl = tonumber(ARGV[9])
local offTtl = tonumber(ARGV[10])
local authSt = ARGV[11]
local authRide = ARGV[12]
local authAt = tonumber(ARGV[13])
local now = nowMs()
local dk = drvKey(id)
local cur = redis.call('HMGET', dk, 't', 'st', 'cell', 'sat')

if not cur[1] then
  if authSt == '' then
    if redis.call('EXISTS', offKey(id)) == 1 then return {'offline', now} end
    if t + ttl <= now then return {'expired', now} end
    return {'cold', now}
  end
  if authSt == 'offline' then
    redis.call('SET', offKey(id), authAt, 'PX', offTtl)
    return {'offline', now}
  end
  if t + ttl <= now then return {'expired', now} end
  redis.call('DEL', offKey(id))
  redis.call('HSET', dk, 'lat', lat, 'lng', lng, 'hd', hd, 'sp', sp, 't', t,
    'cell', cell, 'st', authSt, 'ride', authRide, 'sat', authAt)
  redis.call('PEXPIREAT', dk, t + ttl)
  relocate(id, authSt, cell, authSt, cell, t, now, ttl)
  return {'applied', now}
end

local curT = tonumber(cur[1])
local st = cur[2]
local curCell = cur[3]
local sat = tonumber(cur[4]) or 0
local newSt = st

if authSt ~= '' and sat < authAt then
  if authSt == 'offline' then
    redis.call('ZREM', cellKey(st, curCell), id)
    redis.call('DEL', dk)
    redis.call('SET', offKey(id), authAt, 'PX', offTtl)
    return {'offline', now}
  end
  newSt = authSt
  redis.call('HSET', dk, 'st', newSt, 'ride', authRide, 'sat', authAt)
end

if t < curT then
  if newSt ~= st then relocate(id, st, curCell, newSt, curCell, curT, now, ttl) end
  return {'stale', now}
end

relocate(id, st, curCell, newSt, cell, t, now, ttl)
redis.call('HSET', dk, 'lat', lat, 'lng', lng, 'hd', hd, 'sp', sp, 't', t, 'cell', cell)
redis.call('PEXPIREAT', dk, t + ttl)
return {'applied', now}
`;

/**
 * Full write for callers that KNOW the status (go-online, trip start after an
 * app restart). ARGV: prefix, id, lat, lng, hd, sp, t, cell, ttlMs, status, ride.
 * Status always applies; the position only if it is not older than the one
 * held. Returns the entry as stored, or nil when there was nothing to place.
 */
const UPSERT_LUA = `
local id = ARGV[2]
local lat, lng, hd, sp = ARGV[3], ARGV[4], ARGV[5], ARGV[6]
local t = tonumber(ARGV[7])
local cell = ARGV[8]
local ttl = tonumber(ARGV[9])
local status = ARGV[10]
local ride = ARGV[11]
local now = nowMs()
local dk = drvKey(id)
redis.call('DEL', offKey(id))
local cur = redis.call('HMGET', dk, 't', 'st', 'cell')

if not cur[1] then
  if t + ttl <= now then return false end
  redis.call('HSET', dk, 'lat', lat, 'lng', lng, 'hd', hd, 'sp', sp, 't', t,
    'cell', cell, 'st', status, 'ride', ride, 'sat', now)
  redis.call('PEXPIREAT', dk, t + ttl)
  relocate(id, status, cell, status, cell, t, now, ttl)
else
  local curT = tonumber(cur[1])
  if t >= curT then
    relocate(id, cur[2], cur[3], status, cell, t, now, ttl)
    redis.call('HSET', dk, 'lat', lat, 'lng', lng, 'hd', hd, 'sp', sp, 't', t, 'cell', cell,
      'st', status, 'ride', ride, 'sat', now)
    redis.call('PEXPIREAT', dk, t + ttl)
  else
    relocate(id, cur[2], cur[3], status, cur[3], curT, now, ttl)
    redis.call('HSET', dk, 'st', status, 'ride', ride, 'sat', now)
  end
end
return redis.call('HMGET', dk, 'lat', 'lng', 'hd', 'sp', 't', 'ride', 'st', 'cell')
`;

/** ARGV: prefix, id, status, ride, ttlMs. Returns 1 if an entry was changed. */
const SET_STATUS_LUA = `
local id = ARGV[2]
local status = ARGV[3]
local ride = ARGV[4]
local ttl = tonumber(ARGV[5])
local dk = drvKey(id)
-- A status write is fresher news than any offline marker: clear it, so a
-- driver with no live entry is re-resolved from Postgres on their next ping.
redis.call('DEL', offKey(id))
local cur = redis.call('HMGET', dk, 't', 'st', 'cell')
if not cur[1] then return 0 end
local now = nowMs()
relocate(id, cur[2], cur[3], status, cur[3], tonumber(cur[1]), now, ttl)
redis.call('HSET', dk, 'st', status, 'ride', ride, 'sat', now)
return 1
`;

/** ARGV: prefix, id. */
const REMOVE_LUA = `
local id = ARGV[2]
local dk = drvKey(id)
local cur = redis.call('HMGET', dk, 'st', 'cell')
if cur[1] then
  redis.call('ZREM', cellKey(cur[1], cur[2]), id)
  redis.call('DEL', dk)
end
return 1
`;

/**
 * Bring one entry in line with a Postgres observation. ARGV: prefix, id,
 * pgStatus, pgRide, readAtMs, ttlMs. Returns 1 if anything changed.
 *
 * Skips any entry whose status was written at or after the read began: that
 * write came from a caller who had already committed a newer truth.
 */
const RECONCILE_LUA = `
local id = ARGV[2]
local pgSt = ARGV[3]
local pgRide = ARGV[4]
local readAt = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])
local dk = drvKey(id)
local cur = redis.call('HMGET', dk, 't', 'st', 'cell', 'ride', 'sat')

if not cur[1] then
  if pgSt == 'offline' then return 0 end
  local marker = redis.call('GET', offKey(id))
  if marker and tonumber(marker) < readAt then
    redis.call('DEL', offKey(id))
    return 1
  end
  return 0
end
if (tonumber(cur[5]) or 0) >= readAt then return 0 end
if pgSt == 'offline' then
  redis.call('ZREM', cellKey(cur[2], cur[3]), id)
  redis.call('DEL', dk)
  return 1
end
if cur[2] == pgSt and cur[4] == pgRide then return 0 end
relocate(id, cur[2], cur[3], pgSt, cur[3], tonumber(cur[1]), nowMs(), ttl)
redis.call('HSET', dk, 'st', pgSt, 'ride', pgRide, 'sat', readAt)
return 1
`;

interface LuaScript {
  readonly source: string;
  readonly sha: string;
}

function defineScript(body: string): LuaScript {
  const source = `${LUA_PREAMBLE}\n${body}`;
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

const SCRIPTS = {
  recordPing: defineScript(RECORD_PING_LUA),
  upsert: defineScript(UPSERT_LUA),
  setStatus: defineScript(SET_STATUS_LUA),
  remove: defineScript(REMOVE_LUA),
  reconcile: defineScript(RECONCILE_LUA),
} as const;

/** HMGET order for a full position; the Lua upsert returns the same order. */
const POSITION_FIELDS = ['lat', 'lng', 'hd', 'sp', 't', 'ride', 'st', 'cell'] as const;

type RedisArg = string | number;

/**
 * H3DriverIndexService — where every online driver IS, in memory.
 *
 * The dispatcher used to find drivers with a PostGIS ST_DWithin against
 * driver_availability, which meant every GPS frame had to be a Postgres write
 * so that query had something current to read. Here a frame is a few Redis
 * commands and a search reads a handful of keys around the pickup; Postgres
 * gets the trail later, in bulk (LocationFlushWorker).
 *
 * Why H3 hexagons rather than a radius query (Redis GEOSEARCH, PostGIS):
 *
 *  - Every neighbour of a hexagon is the same distance away. Squares have two
 *    neighbour distances (edge and corner), so "one ring out" means something
 *    different on the diagonal; widening rings of hexagons widen evenly, which
 *    is what replaces the radius ladder in dispatch.
 *  - No pole, antimeridian or projection edge cases. H3 is defined on the
 *    icosahedron, so a cell id and its neighbours are the same computation in
 *    Toronto, Yellowknife and Auckland — geohash prefixes, by contrast, stop
 *    sharing a prefix across arbitrary grid seams.
 *  - Cells double as zones. The same ids that bucket drivers for dispatch are
 *    the pricing zones surge counts supply and demand in (at res 7, a parent of
 *    the res-8 cells here), so there is one geography, not two that disagree.
 *  - The cost is honest: a search touches O(cells walked + drivers found), and
 *    never scales with the size of the fleet.
 *
 * Every write is a Lua script, not MULTI. A move has to read the cell the
 * driver is leaving and the capture time already stored before it knows what
 * to write, and MULTI cannot branch on a read without WATCH and a retry loop
 * that would spin under exactly the load this exists for. A script is one
 * round trip and atomic: a driver is never in two cells, or in none.
 */
@Injectable()
export class H3DriverIndexService {
  private readonly logger = new Logger(H3DriverIndexService.name);

  /** How long an entry outlives its position's capture time. */
  private readonly entryTtlMs: number;
  /** A driver whose position is older than this is not counted as supply. */
  private readonly staleMs: number;
  private readonly maxRings: number;

  constructor(private readonly redis: RedisService) {
    const env = loadEnv();
    // The heartbeat is how long Postgres keeps a silent driver `online`, so the
    // index forgets them on the same schedule. Never shorter than twice the
    // dispatch freshness window, or a search allowed to see 60-second-old
    // positions would find the entries already gone.
    this.entryTtlMs =
      Math.max(env.DRIVER_ONLINE_HEARTBEAT_SECONDS, env.DRIVER_LOCATION_STALE_SECONDS * 2) * 1000;
    this.staleMs = env.DRIVER_LOCATION_STALE_SECONDS * 1000;
    this.maxRings = Math.ceil(env.DRIVER_MAX_SEARCH_RADIUS_METERS / RES8_RING_STEP_METERS) + 1;
  }

  // -------------------------------------------------------------------------
  // Contract — writes
  // -------------------------------------------------------------------------

  /**
   * Place a driver whose status the caller knows (go-online, or re-attaching a
   * trip after an app restart). Status and ride always apply; the position only
   * applies if it is not older than the one already held. Returns the entry as
   * stored — the caller's position when it won, the newer one when it lost.
   */
  async upsert(pos: Omit<IndexedDriverPosition, 'cell'>): Promise<IndexedDriverPosition> {
    const cell = latLngToCell(pos.lat, pos.lng, H3_DISPATCH_RESOLUTION);
    const reply = await this.run(SCRIPTS.upsert, [
      KEY_PREFIX,
      pos.driverId,
      pos.lat,
      pos.lng,
      nullableArg(pos.headingDegrees),
      nullableArg(pos.speedMps),
      captureTimeArg(pos.recordedAtMs),
      cell,
      this.entryTtlMs,
      pos.status,
      pos.rideId ?? '',
    ]);

    const stored = Array.isArray(reply) ? parsePosition(pos.driverId, reply) : null;
    if (!stored) {
      throw new BadRequestException({
        code: 'position_too_old',
        message: 'That position is too old to place the driver on the live map.',
      });
    }
    return stored;
  }

  /**
   * Change what the index believes a driver is doing, keeping their position.
   *
   * A driver with no live entry is left absent — there is no position to put
   * in a cell — but any offline marker is cleared, so their very next ping is
   * resolved against Postgres and lands with the right status.
   */
  async setStatus(
    driverId: string,
    status: IndexedDriverStatus,
    rideId: string | null,
  ): Promise<void> {
    await this.run(SCRIPTS.setStatus, [KEY_PREFIX, driverId, status, rideId ?? '', this.entryTtlMs]);
  }

  /**
   * Take a driver off the live map (go-offline, suspension).
   *
   * Deliberately does NOT leave an offline marker. A marker means "skip
   * Postgres for this driver's pings", and it is only safe to write one after
   * Postgres has been asked: that same question is what creates the
   * availability row DriversService.goOnline updates. A marker written here for
   * a brand-new driver — an app that fires go-offline on first launch — would
   * have their go-online ping skip the row creation and fail. The cost of not
   * writing one is a single Postgres statement on the first ping after going
   * offline, which then leaves the marker itself.
   */
  async remove(driverId: string): Promise<void> {
    await this.run(SCRIPTS.remove, [KEY_PREFIX, driverId]);
  }

  // -------------------------------------------------------------------------
  // Contract — reads
  // -------------------------------------------------------------------------

  async get(driverId: string): Promise<IndexedDriverPosition | null> {
    const fields = await this.redis.client.hmget(driverKey(driverId), ...POSITION_FIELDS);
    return parsePosition(driverId, fields);
  }

  async getMany(driverIds: readonly string[]): Promise<Map<string, IndexedDriverPosition>> {
    const unique = [...new Set(driverIds)];
    const found = new Map<string, IndexedDriverPosition>();
    if (unique.length === 0) return found;

    const pipeline = this.redis.client.pipeline();
    for (const id of unique) pipeline.hmget(driverKey(id), ...POSITION_FIELDS);
    const replies = await execPipeline(pipeline);

    unique.forEach((id, i) => {
      const reply = replies[i];
      const pos = Array.isArray(reply) ? parsePosition(id, reply) : null;
      if (pos) found.set(id, pos);
    });
    return found;
  }

  /**
   * Nearest indexed drivers to a point, nearest first.
   *
   * Walks the pickup's cell, then ring 1, ring 2… reading each ring's cell sets
   * in one pipeline and the members' hashes in a second. Only members whose
   * score (capture time) is inside `maxAgeMs` are even returned by Redis, so
   * stale drivers cost nothing to skip.
   *
   * Stops at the END of a ring, never mid-ring: the cells within a ring come
   * back in no particular order, so a closer driver may sit in a cell not yet
   * read. And it only stops once the next ring provably cannot hold anyone
   * closer than the `limit`-th driver already found — hexagon rings are not
   * circles, so a driver just across the boundary of ring k+1 can beat one in a
   * far corner of ring k. The bound is computed from cell geometry in memory
   * and costs no Redis reads.
   */
  async searchNearby(q: {
    lat: number;
    lng: number;
    maxRings: number;
    limit: number;
    maxAgeMs: number;
    status?: IndexedDriverStatus;
  }): Promise<NearbyIndexedDriver[]> {
    const limit = Math.max(1, Math.trunc(q.limit));
    const maxRings = Math.min(Math.max(0, Math.trunc(q.maxRings)), this.maxRings);
    // The index cannot hold anything older than its TTL; asking for more would
    // only let expired-but-unpruned set members through the score filter.
    const maxAgeMs = Math.min(Math.max(0, q.maxAgeMs), this.entryTtlMs);
    const minScore = Date.now() - maxAgeMs;
    const statuses: readonly IndexedDriverStatus[] = q.status ? [q.status] : ['online', 'on_trip'];
    const origin: readonly [number, number] = [q.lat, q.lng];

    const originCell = latLngToCell(q.lat, q.lng, H3_DISPATCH_RESOLUTION);
    const rings = gridDiskDistances(originCell, maxRings);
    const found = new Map<string, NearbyIndexedDriver>();

    for (let ring = 0; ring < rings.length; ring += 1) {
      const cells = rings[ring] ?? [];
      await this.collectRing(cells, ring, statuses, minScore, origin, found);

      if (found.size < limit) continue;
      const next = rings[ring + 1];
      if (!next) break;
      const kth = kthSmallestDistance(found, limit);
      if (kth <= nearestPossibleMeters(origin, next)) break;
    }

    return [...found.values()]
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, limit);
  }

  /**
   * Fresh `online` drivers per cell — the supply side of surge.
   *
   * Cells coarser than res 8 are counted by expanding them to their res-8
   * children and summing ZCOUNTs, so the index keeps one layout and surge can
   * still ask in pricing zones. `on_trip` drivers are not supply: they cannot
   * take the ride being priced.
   */
  async countOnlineByCell(
    cells: readonly string[],
    resolution: number,
  ): Promise<Map<string, number>> {
    if (
      !Number.isInteger(resolution) ||
      resolution < MIN_COUNT_RESOLUTION ||
      resolution > H3_DISPATCH_RESOLUTION
    ) {
      throw new InternalServerErrorException({
        code: 'h3_resolution_unsupported',
        message:
          `Driver counts are available for H3 resolutions ${MIN_COUNT_RESOLUTION}–` +
          `${H3_DISPATCH_RESOLUTION}; got ${resolution}.`,
      });
    }

    const unique = [...new Set(cells)];
    const counts = new Map<string, number>();
    if (unique.length === 0) return counts;

    const minScore = Date.now() - this.staleMs;
    const pipeline = this.redis.client.pipeline();
    const plan: { cell: string; children: number }[] = [];

    for (const cell of unique) {
      if (!isValidCell(cell) || getResolution(cell) !== resolution) {
        throw new InternalServerErrorException({
          code: 'h3_cell_invalid',
          message: `"${cell}" is not a valid resolution-${resolution} H3 cell.`,
        });
      }
      const children =
        resolution === H3_DISPATCH_RESOLUTION
          ? [cell]
          : cellToChildren(cell, H3_DISPATCH_RESOLUTION);
      for (const child of children) pipeline.zcount(cellKey('online', child), minScore, '+inf');
      plan.push({ cell, children: children.length });
    }

    const replies = await execPipeline(pipeline);
    let offset = 0;
    for (const { cell, children } of plan) {
      let total = 0;
      for (let i = 0; i < children; i += 1) total += Number(replies[offset + i] ?? 0);
      offset += children;
      counts.set(cell, total);
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // GeoModule-internal
  // -------------------------------------------------------------------------

  /**
   * The hot-path write behind every location frame. Moves the driver if this
   * ping is not older than the one held, keeping their status and ride.
   *
   * Pass `authority` only after a `cold` outcome, with the Postgres status and
   * the `serverTimeMs` that outcome returned.
   */
  async recordPing(ping: IndexedPing, authority?: IndexAuthority): Promise<PingIndexResult> {
    const cell = latLngToCell(ping.lat, ping.lng, H3_DISPATCH_RESOLUTION);
    const reply = await this.run(SCRIPTS.recordPing, [
      KEY_PREFIX,
      ping.driverId,
      ping.lat,
      ping.lng,
      nullableArg(ping.headingDegrees),
      nullableArg(ping.speedMps),
      captureTimeArg(ping.recordedAtMs),
      cell,
      this.entryTtlMs,
      OFFLINE_MARKER_TTL_MS,
      authority?.status ?? '',
      authority?.rideId ?? '',
      authority ? Math.trunc(authority.readAtMs) : 0,
    ]);

    if (!Array.isArray(reply) || !isPingOutcome(reply[0])) {
      throw new InternalServerErrorException({
        code: 'driver_index_unavailable',
        message: 'The live driver index returned an unexpected reply.',
      });
    }
    return { outcome: reply[0], serverTimeMs: Number(reply[1]) };
  }

  /**
   * Correct entries that drifted from Postgres. Returns how many changed.
   *
   * Status transitions happen in half a dozen modules — accept, complete,
   * cancel, reassign, suspend, the heartbeat sweeper — and every one of them
   * is expected to tell the index. This is what makes forgetting to cost
   * seconds instead of a driver receiving offers mid-trip until their app
   * restarts. `readAtMs` must be {@link serverTimeMs} taken BEFORE the query
   * that produced the observations.
   */
  async reconcile(observations: readonly StatusObservation[], readAtMs: number): Promise<number> {
    if (observations.length === 0) return 0;

    const build = (): ChainableCommander => {
      const pipeline = this.redis.client.pipeline();
      for (const o of observations) {
        pipeline.evalsha(
          SCRIPTS.reconcile.sha,
          0,
          KEY_PREFIX,
          o.driverId,
          o.status,
          o.rideId ?? '',
          Math.trunc(readAtMs),
          this.entryTtlMs,
        );
      }
      return pipeline;
    };

    let results = await build().exec();
    if (results?.some(([error]) => isNoScript(error))) {
      // Redis restarted or flushed its script cache since the last call.
      await this.redis.client.script('LOAD', SCRIPTS.reconcile.source);
      results = await build().exec();
    }

    let changed = 0;
    for (const [error, value] of results ?? []) {
      if (error) {
        this.logger.warn(`Driver index reconcile entry failed: ${error.message}`);
        continue;
      }
      changed += Number(value) === 1 ? 1 : 0;
    }
    return changed;
  }

  /** Redis' own clock, the one every `sat` in the index is written against. */
  async serverTimeMs(): Promise<number> {
    const [seconds, micros] = await this.redis.client.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read one ring's cells, then the members' hashes, into `found`. */
  private async collectRing(
    cells: readonly string[],
    ring: number,
    statuses: readonly IndexedDriverStatus[],
    minScore: number,
    origin: readonly [number, number],
    found: Map<string, NearbyIndexedDriver>,
  ): Promise<void> {
    const membership = this.redis.client.pipeline();
    const slots: { cell: string; status: IndexedDriverStatus }[] = [];
    for (const cell of cells) {
      for (const status of statuses) {
        membership.zrangebyscore(cellKey(status, cell), minScore, '+inf');
        slots.push({ cell, status });
      }
    }
    const memberReplies = await execPipeline(membership);

    const candidates: { id: string; cell: string; status: IndexedDriverStatus }[] = [];
    slots.forEach((slot, i) => {
      const ids = memberReplies[i];
      if (!Array.isArray(ids)) return;
      for (const id of ids) {
        if (typeof id === 'string' && !found.has(id)) candidates.push({ id, ...slot });
      }
    });
    if (candidates.length === 0) return;

    const hashes = this.redis.client.pipeline();
    for (const c of candidates) hashes.hmget(driverKey(c.id), ...POSITION_FIELDS);
    const hashReplies = await execPipeline(hashes);

    candidates.forEach((c, i) => {
      const reply = hashReplies[i];
      const pos = Array.isArray(reply) ? parsePosition(c.id, reply) : null;
      // A member whose hash is gone, has moved on, or changed status between
      // the two pipelines is a leftover, not a driver: the hash is the truth.
      if (!pos || pos.cell !== c.cell || pos.status !== c.status) return;
      if (pos.recordedAtMs < minScore) return;
      found.set(c.id, {
        ...pos,
        distanceMeters: Math.round(haversineMeters(origin, [pos.lat, pos.lng])),
        ring,
      });
    });
  }

  /**
   * EVALSHA with a one-time EVAL fallback. Shipping the script body on every
   * location frame would multiply the bytes per ping several times over; the
   * SHA is 40 characters and Redis keeps the body after the first EVAL.
   */
  private async run(script: LuaScript, args: readonly RedisArg[]): Promise<unknown> {
    try {
      return await this.redis.client.evalsha(script.sha, 0, ...args);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return this.redis.client.eval(script.source, 0, ...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function driverKey(driverId: string): string {
  return `${KEY_PREFIX}drv:${driverId}`;
}

function cellKey(status: IndexedDriverStatus, cell: string): string {
  return `${KEY_PREFIX}cell:${status}:${cell}`;
}

/** Redis has no null; an empty string stands in for it in hashes and ARGV. */
function nullableArg(value: number | null): RedisArg {
  return value === null || !Number.isFinite(value) ? '' : value;
}

/**
 * Capture time as stored. Never in the future: a clock running fast would
 * otherwise set an expiry and a set score the entry could hide behind — fresh
 * to every search long after the phone went quiet.
 */
function captureTimeArg(recordedAtMs: number): number {
  return Math.trunc(Math.min(recordedAtMs, Date.now()));
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

function isPingOutcome(value: unknown): value is PingIndexOutcome {
  return (
    value === 'applied' ||
    value === 'stale' ||
    value === 'expired' ||
    value === 'offline' ||
    value === 'cold'
  );
}

function parsePosition(driverId: string, fields: readonly unknown[]): IndexedDriverPosition | null {
  const [lat, lng, hd, sp, t, ride, st, cell] = fields;
  if (typeof lat !== 'string' || typeof lng !== 'string' || typeof t !== 'string') return null;
  if (typeof cell !== 'string' || (st !== 'online' && st !== 'on_trip')) return null;

  const position: IndexedDriverPosition = {
    driverId,
    lat: Number(lat),
    lng: Number(lng),
    headingDegrees: parseNullableNumber(hd),
    speedMps: parseNullableNumber(sp),
    recordedAtMs: Number(t),
    rideId: typeof ride === 'string' && ride !== '' ? ride : null,
    status: st,
    cell,
  };
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
  if (!Number.isFinite(position.recordedAtMs)) return null;
  return position;
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function execPipeline(pipeline: ChainableCommander): Promise<unknown[]> {
  const results = await pipeline.exec();
  if (!results) return [];
  return results.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function kthSmallestDistance(found: Map<string, NearbyIndexedDriver>, k: number): number {
  const distances = [...found.values()].map((d) => d.distanceMeters).sort((a, b) => a - b);
  return distances[k - 1] ?? Number.POSITIVE_INFINITY;
}

/**
 * Lower bound on the distance from `origin` to anything inside `cells`: the
 * distance to each cell's centre minus that cell's own circumradius (its
 * farthest vertex). Pure geometry, no Redis. Rounded down a metre so rounding
 * in the reported distances can never make a tie look like a win.
 */
function nearestPossibleMeters(
  origin: readonly [number, number],
  cells: readonly string[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const centre = cellToLatLng(cell);
    const centreLL: readonly [number, number] = [centre[0], centre[1]];
    let circumradius = 0;
    for (const vertex of cellToBoundary(cell)) {
      circumradius = Math.max(circumradius, haversineMeters(centreLL, [vertex[0], vertex[1]]));
    }
    nearest = Math.min(nearest, haversineMeters(origin, centreLL) - circumradius);
  }
  return Math.max(0, Math.floor(nearest) - 1);
}
