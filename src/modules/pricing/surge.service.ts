import { Injectable, Logger } from '@nestjs/common';
import { cellToParent, gridDisk, latLngToCell } from 'h3-js';
import { RedisService } from '../../common/redis/redis.module';
import {
  H3_DISPATCH_RESOLUTION,
  H3_SURGE_RESOLUTION,
  H3DriverIndexService,
} from '../geo/h3-driver-index.service';
import type { SurgeConfig } from './pricing.module';

/**
 * Why a reading came out the way it did. `measured` is the only status that can
 * carry a multiplier above 1.0.
 */
export type SurgeStatus = 'measured' | 'disabled' | 'unavailable';

/** One surge evaluation, with the numbers behind it for logs and ops tooling. */
export interface SurgeReading {
  /** Res-7 H3 cell of the pickup — the zone the smoothed multiplier is kept for. */
  zone: string;
  status: SurgeStatus;
  /**
   * Ride requests in the zone and its ring-1 neighbours this window, counting a
   * rider once per zone when recordDemand was given their id.
   */
  demand: number;
  /** Idle drivers in the same seven zones, per the live index. */
  supply: number;
  /** demand / max(supply, 1). */
  ratio: number;
  /** What the curve asks for right now, before smoothing and rounding. */
  targetMultiplier: number;
  /** What a quote uses: smoothed, rounded to 0.1, within [1, SURGE_MAX_MULTIPLIER]. */
  multiplier: number;
}

/**
 * Count one request in its minute bucket, at most once per rider per zone per
 * window.
 *
 * KEYS[1] demand bucket, KEYS[2] (optional) rider marker.
 * ARGV[1] bucket TTL seconds, ARGV[2] rider marker TTL seconds.
 *
 * One script so the dedupe check and the increment cannot be split by a crash
 * or interleaved with a second request from the same rider. Both keys carry the
 * zone as a hash tag, so they stay in one slot if Redis is ever clustered.
 */
const RECORD_DEMAND_LUA = `
if KEYS[2] then
  if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[2]) then
    return 0
  end
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1
`;

/**
 * Move a zone's moving average toward the target and return the new value.
 *
 * KEYS[1] the zone's average. ARGV[1] target, ARGV[2] time constant in ms,
 * ARGV[3] key TTL seconds.
 *
 * Time-weighted, not sample-weighted: alpha = 1 - exp(-dt / tau). A burst of
 * quotes from one rider dragging a pin moves the average by almost nothing,
 * because almost no time has passed — a per-sample EWMA would let that same
 * burst walk the price. Elapsed time comes from Redis TIME so every API
 * instance measures it on one clock; skew between replicas would otherwise read
 * as time passing, or as time running backwards.
 *
 * A zone with no history starts at the target. Nobody has been shown a price
 * there recently, so there is nothing for the first quote to flicker from.
 * Values return as strings: Lua numbers become Redis integers on the way out.
 */
const SMOOTH_MULTIPLIER_LUA = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local target = tonumber(ARGV[1])
local tauMs = tonumber(ARGV[2])
local value = target
local prev = redis.call('HMGET', KEYS[1], 'm', 't')
-- tonumber() returns nil for anything that is not a number, and arithmetic on
-- nil aborts the whole script. A corrupt stored average must not abort it:
-- the script's error would reach evaluate() and switch surge off for the zone
-- until the key expired. Treat an unreadable average as no average — smooth
-- from the live target — and the HSET below overwrites the bad value.
local last = prev[1] and tonumber(prev[1])
local lastT = prev[2] and tonumber(prev[2])
-- NaN is the only value not equal to itself, and the range bounds rule out
-- infinities. Plain comparisons rather than math.huge, which keeps the check to
-- operators every Lua 5.1 embedding (and the in-memory test interpreter) has.
local usable = last and lastT and last == last and lastT == lastT
  and last > -1e308 and last < 1e308
if usable and tauMs > 0 then
  local dt = nowMs - lastT
  if dt < 0 then dt = 0 end
  value = last + (1 - math.exp(-dt / tauMs)) * (target - last)
end
local encoded = string.format('%.6f', value)
redis.call('HSET', KEYS[1], 'm', encoded, 't', string.format('%.0f', nowMs))
redis.call('EXPIRE', KEYS[1], ARGV[3])
return encoded
`;

/**
 * The surge zone for a point: the res-7 PARENT of its res-8 dispatch cell.
 *
 * Deliberately not latLngToCell(lat, lng, 7). H3 children do not tile their
 * parent exactly, so near a zone edge a point's res-7 cell and the parent of its
 * res-8 cell can differ. Supply is counted by res-8 cell and rolled up by
 * parentage, so demand is bucketed the same way — otherwise a rider and the
 * driver parked beside them could land in different zones.
 */
export function surgeZoneOf(lat: number, lng: number): string {
  return cellToParent(latLngToCell(lat, lng, H3_DISPATCH_RESOLUTION), H3_SURGE_RESOLUTION);
}

/**
 * Demand/supply ratio → target multiplier, before smoothing.
 *
 * Flat at 1.0 up to the threshold, flat at the cap past SURGE_RATIO_AT_MAX, and
 * a smoothstep S-curve between. The S-curve rather than a straight line because
 * its slope is zero at both ends: a neighbourhood drifting just over the
 * threshold stays at 1.0x after rounding instead of stepping straight to 1.1x,
 * and one approaching the cap slows into it instead of hitting a wall.
 */
export function surgeTargetFor(
  ratio: number,
  config: Pick<SurgeConfig, 'ratioThreshold' | 'ratioAtMax' | 'maxMultiplier'>,
): number {
  if (!(ratio > config.ratioThreshold)) return 1;
  if (ratio >= config.ratioAtMax) return config.maxMultiplier;
  const t = (ratio - config.ratioThreshold) / (config.ratioAtMax - config.ratioThreshold);
  const eased = t * t * (3 - 2 * t);
  return 1 + (config.maxMultiplier - 1) * eased;
}

/**
 * Round to one decimal, ties up — the same rounding the pricing service applies
 * (fares.py applied_surge), so the number shown is the number charged.
 */
export function roundSurge(multiplier: number): number {
  return Math.round(multiplier * 10) / 10;
}

/**
 * SurgeService — zone surge on H3 hexagons, the Uber model.
 *
 * DEMAND is ride requests, counted per res-7 zone in per-minute Redis buckets
 * that expire on their own. SUPPLY is idle drivers from the live H3 driver
 * index, which lives in Redis at res 8 and is rolled up to res 7 by parentage.
 * The multiplier is demand over supply across the pickup's zone and its six
 * neighbours, mapped through a thresholded, capped curve and smoothed over time
 * per zone. No Postgres anywhere on this path: a quote costs a handful of Redis
 * round trips.
 *
 * Fairness, which is the whole design constraint. Surge exists to pull drivers
 * toward riders who are not being served — a price signal a driver can see
 * and act on. It only works if it is predictable, for both sides:
 *
 *  - Neighbourhood, not hexagon. One res-7 cell is ~5 km²; a driver crossing a
 *    single street can halve its supply. Seven cells (~36 km²) is the scale a
 *    driver actually repositions across, and the scale at which the count means
 *    something.
 *  - Threshold, then a smooth ramp, then a cap. Normal fluctuation never moves
 *    the price, a real shortage moves it gradually, and nothing moves it past a
 *    number ops has signed off on.
 *  - Smoothed over minutes. A price that changes between two quotes seconds
 *    apart — or while the rider is looking at it — reads as the app haggling
 *    with them, and a rider who distrusts the price does not book.
 *  - One vote per rider. A rider cancelling and re-requesting, or an account
 *    trying to talk a neighbourhood's price up, counts once per window.
 *  - When in doubt, 1.0. Disabled, too few requests to mean anything, Redis or
 *    the index unreachable: the rider pays the base price. A shortage we cannot
 *    measure is never a reason to charge more.
 *
 * Demand is requests, not app opens, so surge partly suppresses its own signal:
 * a higher price converts fewer requests, the ratio falls, the price follows.
 * That feedback is intended — it is what makes the price settle instead of
 * climbing — and it is why the curve does not need to be steep to clear a
 * shortage.
 *
 * Constructed by PricingModule's factory; see there for why.
 */
@Injectable()
export class SurgeService {
  private readonly logger = new Logger(SurgeService.name);

  private readonly windowSeconds: number;
  private readonly bucketTtlSeconds: number;
  private readonly averageTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly index: H3DriverIndexService,
    private readonly config: SurgeConfig,
  ) {
    this.windowSeconds = config.windowMinutes * 60;
    // One spare minute so the oldest bucket in the window is never the one
    // that has just expired mid-read.
    this.bucketTtlSeconds = this.windowSeconds + 60;
    // Past five time constants the average has converged on whatever the
    // target was, so there is nothing left to remember. Never shorter than the
    // window, so a zone that is quoted once per window keeps its history.
    this.averageTtlSeconds = Math.max(this.windowSeconds, config.smoothingSeconds * 5) + 60;
  }

  /**
   * Count a ride request toward its pickup zone's demand.
   *
   * Call AFTER the ride row commits and after its fare was quoted: a request
   * that rolled back is not demand, and a rider must not raise their own price.
   * Pass the rider id so repeat requests from one rider count once per window.
   *
   * Never throws. Losing one demand sample under-prices one zone slightly for a
   * few minutes; failing a ride request because a counter was unreachable would
   * be absurd. Recorded even when surge is disabled — see SURGE_ENABLED.
   */
  async recordDemand(lat: number, lng: number, riderId?: string): Promise<void> {
    try {
      const zone = surgeZoneOf(lat, lng);
      const keys = [demandKey(zone, currentMinute())];
      if (riderId) keys.push(riderKey(zone, riderId));
      await this.redis.client.eval(
        RECORD_DEMAND_LUA,
        keys.length,
        ...keys,
        this.bucketTtlSeconds,
        this.windowSeconds,
      );
    } catch (error) {
      this.logger.warn(`Surge demand sample dropped: ${describeError(error)}`);
    }
  }

  /** The multiplier a fare quote at this pickup should use. Never throws; 1.0 when unsure. */
  async multiplierFor(lat: number, lng: number): Promise<number> {
    const reading = await this.evaluate(lat, lng);
    return reading.multiplier;
  }

  /**
   * Full surge reading for a pickup.
   *
   * Not a pure read: it advances the zone's moving average, because the
   * average is defined by what quotes have been shown. Ops tooling that only
   * wants to look should expect to nudge it — harmlessly, since a nudge seconds
   * after the last one moves it by almost nothing.
   */
  async evaluate(lat: number, lng: number): Promise<SurgeReading> {
    const zone = surgeZoneOf(lat, lng);
    if (!this.config.enabled) return neutralReading(zone, 'disabled');

    try {
      const neighbourhood = gridDisk(zone, 1);
      const [demand, supply] = await Promise.all([
        this.demandIn(neighbourhood),
        this.supplyIn(neighbourhood),
      ]);
      const ratio = demand / Math.max(supply, 1);
      const targetMultiplier =
        demand < this.config.minDemand ? 1 : surgeTargetFor(ratio, this.config);
      const smoothed = await this.smooth(zone, targetMultiplier);
      const multiplier = Math.min(
        Math.max(roundSurge(smoothed), 1),
        this.config.maxMultiplier,
      );
      return { zone, status: 'measured', demand, supply, ratio, targetMultiplier, multiplier };
    } catch (error) {
      this.logger.warn(`Surge unavailable for zone ${zone}, quoting 1.0x: ${describeError(error)}`);
      return neutralReading(zone, 'unavailable');
    }
  }

  /**
   * Requests over the window across the given zones: one MGET per zone,
   * pipelined into a single round trip. Per zone rather than one MGET over
   * every bucket of every zone, so each command stays inside one hash slot.
   *
   * The newest bucket is the current, partial minute, so the effective window
   * slides between N-1 and N minutes. Buckets are keyed on this instance's
   * clock; skew between replicas is seconds against minute-wide buckets.
   */
  private async demandIn(zones: readonly string[]): Promise<number> {
    const nowMinute = currentMinute();
    const pipeline = this.redis.client.pipeline();
    for (const zone of zones) {
      const keys: string[] = [];
      for (let i = 0; i < this.config.windowMinutes; i += 1) {
        keys.push(demandKey(zone, nowMinute - i));
      }
      pipeline.mget(keys);
    }
    const results = await pipeline.exec();
    if (!results) throw new Error('demand pipeline was discarded');

    let total = 0;
    for (const [error, values] of results) {
      if (error) throw error;
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const count = typeof value === 'string' ? Number.parseInt(value, 10) : 0;
        if (Number.isFinite(count) && count > 0) total += count;
      }
    }
    return total;
  }

  /**
   * Idle drivers across the given res-7 zones. The index rolls its res-8 cells
   * up to each zone by parentage — the same mapping surgeZoneOf uses for demand
   * — and already drops positions too old to be anyone's live location, so a
   * driver whose phone died stops counting as supply without help from here.
   * Only the zones asked for are summed, so extra entries in the result cannot
   * double-count.
   */
  private async supplyIn(zones: readonly string[]): Promise<number> {
    const counts = await this.index.countOnlineByCell(zones, H3_SURGE_RESOLUTION);
    let total = 0;
    for (const zone of zones) total += counts.get(zone) ?? 0;
    return total;
  }

  private async smooth(zone: string, target: number): Promise<number> {
    const raw = await this.redis.client.eval(
      SMOOTH_MULTIPLIER_LUA,
      1,
      averageKey(zone),
      target.toFixed(6),
      this.config.smoothingSeconds * 1000,
      this.averageTtlSeconds,
    );
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    // A corrupt average must not become a price. Use the live target instead;
    // the next write overwrites the bad value.
    return Number.isFinite(value) ? value : target;
  }
}

// ---------------------------------------------------------------------------
// Keys and helpers
// ---------------------------------------------------------------------------

/** The zone sits in braces as a hash tag: every key for one zone shares a slot. */
function demandKey(zone: string, minute: number): string {
  return `uride:surge:{${zone}}:demand:${minute}`;
}

function riderKey(zone: string, riderId: string): string {
  return `uride:surge:{${zone}}:rider:${riderId}`;
}

function averageKey(zone: string): string {
  return `uride:surge:{${zone}}:avg`;
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function neutralReading(zone: string, status: SurgeStatus): SurgeReading {
  return { zone, status, demand: 0, supply: 0, ratio: 0, targetMultiplier: 1, multiplier: 1 };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
