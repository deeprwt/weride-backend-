import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import {
  GeoService,
  LOCATION_TRAIL_QUEUE_KEY,
  decodeTrailPoint,
  sqlStateOf,
  type TrailPoint,
} from './geo.service';
import { H3DriverIndexService } from './h3-driver-index.service';

/** Held for one tick. Release is a compare-and-delete so we never drop someone else's. */
const LOCK_KEY = 'uride:geo:flush:tick';

/**
 * The batch being written. A claimed batch moves here atomically and leaves
 * only once Postgres has it, so a crash or a failed INSERT never loses points:
 * the next tick, on whichever instance, finds it here and tries again.
 */
const INFLIGHT_KEY = 'uride:geo:trail:inflight';
/** Which claim owns the in-flight batch — see COMPLETE_LUA for why it matters. */
const INFLIGHT_ID_KEY = 'uride:geo:trail:inflight:id';

/**
 * Batches Postgres rejected for a reason retrying cannot fix. Kept, not
 * dropped, for replay once the cause is fixed:
 *   redis-cli LMOVE uride:geo:trail:dead uride:geo:trail:queue LEFT RIGHT
 * repeated until it returns nil. Capped like the queue.
 */
const DEAD_LETTER_KEY = 'uride:geo:trail:dead';

/** Per driver: the last idle sample bucket written to the trail. */
const SAMPLE_KEY_PREFIX = 'uride:geo:trail:sampled:';
/** Per driver: present while their availability row was refreshed recently. */
const REFRESH_KEY_PREFIX = 'uride:geo:avail:refreshed:';

/**
 * How long a driver's sampling state survives silence. Long enough to span a
 * shift break, short enough that a fleet's worth of keys (~90 bytes each)
 * clears out overnight.
 */
const SAMPLE_STATE_TTL_SECONDS = 60 * 60;

/** A backlog this many full batches deep is worth a warning. */
const BACKLOG_WARN_BATCHES = 30;
const BACKLOG_WARN_EVERY_MS = 60_000;

/**
 * SQLSTATE classes that fail identically on every retry: data exceptions (22),
 * integrity violations (23 — except 23514, handled on its own) and syntax or
 * access-rule errors (42, a query that no longer matches the schema). Anything
 * else — connection loss, pool timeouts, serialization failures — is transient
 * and retried in place.
 */
const PERMANENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(['22', '23', '42']);

const RELEASE_IF_OWNED = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/**
 * Claim the next batch. KEYS: queue, inflight, inflightId. ARGV: batchSize,
 * queueCap, newBatchId. Returns {dropped, queueLengthAfter, batchId, retrying, items}.
 *
 * Enforces the queue ceiling first, from the head (oldest), and only here: the
 * hot path never trims, because a producer trimming the head would shift the
 * very items a claim is moving. An in-flight batch that has not landed is
 * returned again instead of claiming a new one. The move itself is chunked
 * because Lua's unpack() has a stack limit a 4,000-item batch would hit.
 */
const CLAIM_LUA = `
local dropped = 0
local cap = tonumber(ARGV[2])
local len = redis.call('LLEN', KEYS[1])
if len > cap then
  redis.call('LTRIM', KEYS[1], len - cap, -1)
  dropped = len - cap
end

local held = redis.call('LRANGE', KEYS[2], 0, -1)
if #held > 0 then
  local id = redis.call('GET', KEYS[3])
  if not id then
    id = ARGV[3]
    redis.call('SET', KEYS[3], id)
  end
  return {dropped, redis.call('LLEN', KEYS[1]), id, 1, held}
end

local items = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #items == 0 then return {dropped, 0, '', 0, items} end
for i = 1, #items, 500 do
  redis.call('RPUSH', KEYS[2], unpack(items, i, math.min(i + 499, #items)))
end
redis.call('LTRIM', KEYS[1], #items, -1)
redis.call('SET', KEYS[3], ARGV[3])
return {dropped, redis.call('LLEN', KEYS[1]), ARGV[3], 0, items}
`;

/**
 * Release the in-flight batch, but only if it is still the one we wrote.
 * KEYS: inflight, inflightId. ARGV: batchId.
 *
 * The guard is for the slow-tick case: if a tick outlives its lock, a second
 * instance retries the same batch (a duplicate write, harmless) and may finish
 * first and claim the NEXT batch. An unconditional DEL from the slow instance
 * would then delete a batch nobody has written. Duplicates are the price of
 * never losing a point; this check is what keeps it only duplicates.
 */
const COMPLETE_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

/** KEYS: inflight, inflightId, deadLetter. ARGV: batchId, cap. */
const DEAD_LETTER_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local items = redis.call('LRANGE', KEYS[1], 0, -1)
for i = 1, #items, 500 do
  redis.call('RPUSH', KEYS[3], unpack(items, i, math.min(i + 499, #items)))
end
redis.call('LTRIM', KEYS[3], -tonumber(ARGV[2]), -1)
redis.call('DEL', KEYS[1], KEYS[2])
return #items
`;

interface ClaimedBatch {
  dropped: number;
  queueLength: number;
  batchId: string;
  retrying: boolean;
  items: string[];
}

interface SampleResult {
  keep: TrailPoint[];
  /** Drivers whose sampling bucket advanced, committed only once the batch lands. */
  advanced: Map<string, number>;
}

/**
 * LocationFlushWorker — the durable half of the location pipeline.
 *
 * Pings are queued in Redis by GeoService and indexed live; this loop is the
 * only thing that writes them to Postgres. Each tick it claims up to
 * GEO_FLUSH_BATCH_SIZE points, samples them, writes the trail in one INSERT,
 * and refreshes driver_availability in one UPDATE. A backlog drains over
 * several ticks rather than in one statement large enough to starve the pool.
 *
 * SAMPLING. Points recorded on a ride are all kept: they are what a fare
 * dispute is settled on, and every one of them is a metre of distance someone
 * paid for. Points with no ride keep at most one per driver per
 * GEO_IDLE_TRAIL_SAMPLE_SECONDS of capture time (fixed buckets), because an
 * online-but-idle trail is only ever read coarsely — where supply sat, where a
 * driver was when an offer went out.
 *
 * The storage math, at ~170 bytes a driver_locations row including its two
 * indexes and a ping every 4 s:
 *
 *   unsampled idle   900 rows per driver-hour  ≈ 153 KB
 *   sampled at 30 s  120 rows per driver-hour  ≈  20 KB
 *
 *   10k drivers idle 5 h a day: 45 M rows ≈ 7.6 GB/day → 6 M rows ≈ 1.0 GB/day,
 *   or a monthly partition of ~230 GB → ~31 GB. On-trip hours are unchanged.
 *
 * Idle points older than a bucket already written for that driver are dropped,
 * so a buffered queue the app uploads after live pings resumed loses its idle
 * part. That gap was never evidence; the strict one-per-bucket bound is what
 * makes the numbers above a ceiling rather than an average.
 *
 * AVAILABILITY. last_location / last_ping_at are refreshed per driver at most
 * every GEO_AVAILABILITY_REFRESH_SECONDS. Dispatch reads the live index now;
 * the admin dashboard and the heartbeat sweeper read the row, and the sweeper
 * is why the refresh never waits on the trail: it uses the newest points in the
 * queue, not just the claimed batch, so a stuck trail (a missing partition, a
 * long backlog after an outage) cannot age every row past the heartbeat and
 * sweep a fleet of pinging drivers offline. The statuses that UPDATE returns
 * are then reconciled into the live index, which is what heals any status
 * transition that forgot to tell it.
 *
 * FAILURE. A failed INSERT leaves the batch in flight, retried next tick. A
 * missing monthly partition (SQLSTATE 23514) is an ops emergency logged at
 * error every tick until it is fixed. A permanent error — the query no longer
 * fits the schema — moves the batch to a dead-letter list instead of wedging
 * the queue behind it. Nothing here ever runs on the request path: a stuck
 * flush grows a Redis list, bounded by GEO_FLUSH_QUEUE_MAX_POINTS, and pings
 * keep being accepted.
 *
 * Plumbing copies DispatchWorker: a Redis SET NX EX lock so one instance works
 * per tick, released at the end so the next tick can run anywhere; an unref'd
 * timer; a catch around everything so a bad tick never kills the interval.
 *
 * The next step at scale is a Redis Stream with a consumer group, sharded by
 * city, so several instances flush in parallel. The list is enough until one
 * INSERT per second stops keeping up, and it keeps the lock story simple.
 */
@Injectable()
export class LocationFlushWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LocationFlushWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastBacklogWarningAt = 0;

  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly queueCap: number;
  private readonly sampleMs: number;
  private readonly refreshMs: number;
  private readonly lockTtlSeconds: number;

  constructor(
    private readonly geo: GeoService,
    private readonly index: H3DriverIndexService,
    private readonly redis: RedisService,
  ) {
    const env = loadEnv();
    this.intervalMs = env.GEO_FLUSH_TICK_MS;
    this.batchSize = env.GEO_FLUSH_BATCH_SIZE;
    this.queueCap = env.GEO_FLUSH_QUEUE_MAX_POINTS;
    this.sampleMs = env.GEO_IDLE_TRAIL_SAMPLE_SECONDS * 1000;
    this.refreshMs = env.GEO_AVAILABILITY_REFRESH_SECONDS * 1000;
    // Crash insurance, not a schedule — the lock is released every tick. Generous
    // because a lock that expires under a slow INSERT means a second instance
    // re-writes the same batch: harmless, but it is the load we are here to shed.
    this.lockTtlSeconds = Math.max(30, Math.ceil((this.intervalMs / 1000) * 10));
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `Location flush worker started (every ${this.intervalMs}ms, batch ${this.batchSize}, ` +
        `idle sample ${this.sampleMs / 1000}s, availability refresh ${this.refreshMs / 1000}s).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for an ops-triggered manual flush. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const token = randomUUID();
    let held = false;
    try {
      const acquired = await this.redis.client.set(
        LOCK_KEY,
        token,
        'EX',
        this.lockTtlSeconds,
        'NX',
      );
      if (acquired !== 'OK') return; // another instance owns this tick
      held = true;

      await this.flush();
    } catch (error) {
      // Never let a tick failure kill the interval. Redis or Postgres being
      // briefly unavailable must delay the trail by a few ticks, not stop it
      // until someone restarts the process.
      this.logger.error(`Location flush tick failed: ${describeError(error)}`);
    } finally {
      if (held) await this.releaseLock(token);
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------
  // One tick
  // -------------------------------------------------------------------------

  private async flush(): Promise<void> {
    const claim = await this.claim();
    this.reportQueueHealth(claim);
    if (claim.items.length === 0) return;

    const points: TrailPoint[] = [];
    for (const raw of claim.items) {
      const point = decodeTrailPoint(raw);
      if (point) points.push(point);
    }
    const unreadable = claim.items.length - points.length;
    if (unreadable > 0) {
      // Nothing can ever store these; holding them would wedge every batch behind.
      this.logger.warn(`Discarded ${unreadable} unreadable point(s) from the trail queue.`);
    }

    const { keep, advanced } = await this.sample(points);
    const stored = await this.writeTrail(claim, keep);
    if (stored) await this.commitSampling(advanced);

    // Deliberately independent of the trail's outcome — see the class comment.
    try {
      await this.refreshAvailability(points, claim.retrying || claim.queueLength > 0);
    } catch (error) {
      this.logger.warn(
        `Availability refresh failed; retried with the next batch: ${describeError(error)}`,
      );
    }
  }

  private async claim(): Promise<ClaimedBatch> {
    const reply = await this.redis.client.eval(
      CLAIM_LUA,
      3,
      LOCATION_TRAIL_QUEUE_KEY,
      INFLIGHT_KEY,
      INFLIGHT_ID_KEY,
      this.batchSize,
      this.queueCap,
      randomUUID(),
    );
    if (!Array.isArray(reply) || reply.length < 5 || !Array.isArray(reply[4])) {
      throw new Error('Trail queue claim returned an unexpected reply.');
    }
    const [dropped, queueLength, batchId, retrying, items] = reply as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown[],
    ];
    return {
      dropped: Number(dropped),
      queueLength: Number(queueLength),
      batchId: String(batchId),
      retrying: Number(retrying) === 1,
      items: items.filter((item): item is string => typeof item === 'string'),
    };
  }

  /** Write the trail and release the batch. Returns true when Postgres has it. */
  private async writeTrail(claim: ClaimedBatch, keep: readonly TrailPoint[]): Promise<boolean> {
    try {
      await this.geo.appendTrail(keep);
    } catch (error) {
      await this.onTrailWriteFailed(error, claim, keep.length);
      return false;
    }

    const released = await this.redis.client.eval(
      COMPLETE_LUA,
      2,
      INFLIGHT_KEY,
      INFLIGHT_ID_KEY,
      claim.batchId,
    );
    if (Number(released) !== 1) {
      this.logger.warn(
        `Trail batch ${claim.batchId} was already released by another instance; ` +
          'its points may have been written twice.',
      );
    }
    if (claim.retrying) {
      this.logger.log(`Held trail batch of ${keep.length} point(s) written after retry.`);
    }
    return true;
  }

  private async onTrailWriteFailed(
    error: unknown,
    claim: ClaimedBatch,
    kept: number,
  ): Promise<void> {
    const sqlState = sqlStateOf(error);

    // 23514: no partition of driver_locations covers these recorded_at values —
    // the monthly rotation job is behind. Retrying is correct (the batch lands
    // the moment ops attach the partition) and dead-lettering would be wrong,
    // so this stays loud every tick until someone acts.
    if (sqlState === '23514') {
      this.logger.error(
        `driver_locations has no partition for a batch of ${kept} point(s); the monthly ` +
          'partition rotation is overdue. The batch is held and retried every tick, and ' +
          `${claim.queueLength} more point(s) are queued behind it ` +
          `(ceiling GEO_FLUSH_QUEUE_MAX_POINTS=${this.queueCap}).`,
      );
      return;
    }

    if (sqlState && PERMANENT_SQLSTATE_CLASSES.has(sqlState.slice(0, 2))) {
      const moved = await this.redis.client.eval(
        DEAD_LETTER_LUA,
        3,
        INFLIGHT_KEY,
        INFLIGHT_ID_KEY,
        DEAD_LETTER_KEY,
        claim.batchId,
        this.queueCap,
      );
      this.logger.error(
        `Trail batch failed with SQLSTATE ${sqlState}, which no retry can fix; moved ` +
          `${Number(moved)} point(s) to ${DEAD_LETTER_KEY} for replay: ${describeError(error)}`,
      );
      return;
    }

    this.logger.error(
      `Trail write of ${kept} point(s) failed; batch held for the next tick: ${describeError(error)}`,
    );
  }

  private reportQueueHealth(claim: ClaimedBatch): void {
    if (claim.dropped > 0) {
      this.logger.error(
        `Trail queue exceeded GEO_FLUSH_QUEUE_MAX_POINTS=${this.queueCap}; dropped the ` +
          `${claim.dropped} oldest point(s). Postgres has not been keeping up — check the ` +
          'errors above this line.',
      );
    }

    const behindBatches = claim.queueLength / this.batchSize;
    const now = Date.now();
    if (
      behindBatches >= BACKLOG_WARN_BATCHES &&
      now - this.lastBacklogWarningAt >= BACKLOG_WARN_EVERY_MS
    ) {
      this.lastBacklogWarningAt = now;
      const seconds = Math.round((behindBatches * this.intervalMs) / 1000);
      this.logger.warn(
        `Trail queue backlog: ${claim.queueLength} point(s), ~${seconds}s of flushing at the ` +
          'current drain rate. Raise GEO_FLUSH_BATCH_SIZE or lower GEO_FLUSH_TICK_MS if this persists.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  /**
   * Keep every ride point, and the first idle point per driver per bucket.
   *
   * The bucket state is only read here; {@link commitSampling} writes it after
   * the INSERT lands. Advancing it first would make a retried batch drop the
   * very idle points its failed attempt had selected.
   */
  private async sample(points: readonly TrailPoint[]): Promise<SampleResult> {
    const keep: TrailPoint[] = [];
    const idleByDriver = new Map<string, TrailPoint[]>();
    for (const point of points) {
      if (point.rideId) {
        keep.push(point);
        continue;
      }
      const list = idleByDriver.get(point.driverId);
      if (list) list.push(point);
      else idleByDriver.set(point.driverId, [point]);
    }

    const advanced = new Map<string, number>();
    if (idleByDriver.size === 0) return { keep, advanced };

    const drivers = [...idleByDriver.keys()];
    const stored = await this.redis.client.mget(drivers.map(sampleKey));

    drivers.forEach((driverId, i) => {
      const raw = stored[i];
      const lastBucket = raw === null || raw === undefined ? Number.NEGATIVE_INFINITY : Number(raw);
      let highest = lastBucket;

      const idle = (idleByDriver.get(driverId) ?? []).sort(
        (a, b) => a.recordedAtMs - b.recordedAtMs,
      );
      for (const point of idle) {
        const bucket = Math.floor(point.recordedAtMs / this.sampleMs);
        if (bucket <= highest) continue;
        keep.push(point);
        highest = bucket;
      }
      if (highest > lastBucket) advanced.set(driverId, highest);
    });

    return { keep, advanced };
  }

  private async commitSampling(advanced: ReadonlyMap<string, number>): Promise<void> {
    if (advanced.size === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const [driverId, bucket] of advanced) {
      pipeline.set(sampleKey(driverId), String(bucket), 'EX', SAMPLE_STATE_TTL_SECONDS);
    }
    // Best effort: a lost write costs at most one extra idle row per driver.
    const results = await pipeline.exec();
    const failed = results?.filter(([error]) => error !== null).length ?? 0;
    if (failed > 0) this.logger.debug(`${failed} idle sampling state write(s) failed.`);
  }

  // -------------------------------------------------------------------------
  // Availability refresh + index reconcile
  // -------------------------------------------------------------------------

  /**
   * Refresh driver_availability from each driver's newest known point, for the
   * drivers not refreshed within GEO_AVAILABILITY_REFRESH_SECONDS, then fold the
   * statuses Postgres reports back into the live index.
   *
   * When a backlog exists (or the batch is a retry), the newest points are at
   * the TAIL of the queue, not in the batch just claimed from its head, so the
   * tail is read too — without consuming it. Batch plus tail is at most 8,000
   * distinct drivers, 48,000 bind parameters: inside Postgres' 65,535.
   *
   * Throttle keys are set for every driver attempted, including ones the
   * newest-wins guard skipped — they already had a newer row.
   */
  private async refreshAvailability(
    batch: readonly TrailPoint[],
    includeQueueTail: boolean,
  ): Promise<void> {
    let candidates: readonly TrailPoint[] = batch;
    if (includeQueueTail) {
      const tail = await this.redis.client.lrange(LOCATION_TRAIL_QUEUE_KEY, -this.batchSize, -1);
      candidates = [...batch, ...tail.map(decodeTrailPoint).filter(isTrailPoint)];
    }

    const newest = new Map<string, TrailPoint>();
    for (const point of candidates) {
      const current = newest.get(point.driverId);
      if (!current || point.recordedAtMs > current.recordedAtMs) newest.set(point.driverId, point);
    }
    if (newest.size === 0) return;

    const entries = [...newest.values()];
    const throttled = await this.redis.client.mget(entries.map((p) => refreshKey(p.driverId)));
    const due = entries.filter((_, i) => throttled[i] === null || throttled[i] === undefined);
    if (due.length === 0) return;

    // Redis' clock BEFORE the read: any status written to the index after this
    // instant came from a caller who committed first, and must win.
    const readAtMs = await this.index.serverTimeMs();
    // A deadlock with the heartbeat sweeper's own multi-row UPDATE is possible
    // in principle; Postgres aborts one side, this throws, and the drivers are
    // simply refreshed on a later tick since their throttle keys were not set.
    const observations = await this.geo.refreshAvailability(due);

    const throttle = this.redis.client.pipeline();
    for (const point of due) {
      throttle.set(refreshKey(point.driverId), '1', 'PX', this.refreshMs);
    }
    await throttle.exec();

    const corrected = await this.index.reconcile(observations, readAtMs);
    if (corrected > 0) {
      this.logger.log(
        `Reconciled ${corrected} live index entr${corrected === 1 ? 'y' : 'ies'} ` +
          'with driver_availability — a status change did not reach the index.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Lock
  // -------------------------------------------------------------------------

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.client.eval(RELEASE_IF_OWNED, 1, LOCK_KEY, token);
    } catch (error) {
      this.logger.debug(`Location flush lock release failed: ${describeError(error)}`);
    }
  }
}

function sampleKey(driverId: string): string {
  return `${SAMPLE_KEY_PREFIX}${driverId}`;
}

function refreshKey(driverId: string): string {
  return `${REFRESH_KEY_PREFIX}${driverId}`;
}

function isTrailPoint(point: TrailPoint | null): point is TrailPoint {
  return point !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
