import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { cellToChildren, cellToLatLng, cellToParent, gridDisk, gridDiskDistances, gridDistance, latLngToCell } from 'h3-js';
import { _resetEnvCache } from '../../config/env';
import type { RedisService } from '../../common/redis/redis.module';
import { H3_DISPATCH_RESOLUTION, H3DriverIndexService, type IndexedDriverStatus } from '../geo/h3-driver-index.service';
import type { SurgeConfig } from './pricing.module';
import { SurgeService, roundSurge, surgeTargetFor, surgeZoneOf } from './surge.service';

/**
 * Zone surge, tested on the promises that make a surge price fair.
 *
 * **No surge without a shortage.** A served neighbourhood, a ratio sitting on
 * the threshold, two people and no drivers, one rider hammering request, a
 * switched-off kill switch: all base price.
 *
 * **A ramp, not a step.** Past the threshold the price rises smoothly with the
 * ratio and over minutes in time — never a jump between two quotes seconds
 * apart.
 *
 * **Never past the cap.** Not at any ratio, not from a smoothed average left
 * over from a higher cap, not when the numbers cannot be read.
 *
 * **A neighbourhood, not a hexagon.** A burst of requests in one zone whose
 * neighbours are full of idle drivers is not a shortage worth repricing.
 *
 * Supply is the REAL live driver index on the same in-memory Redis, so drivers
 * are placed by latitude and longitude and counted by the same res-8 → res-7
 * rollup production uses: a rider and the driver parked beside them must land
 * in the same zone, and nothing here lets a test assume they do. Every Lua
 * script — demand counting, the smoothed average, the index — runs as written
 * against the fake at the bottom of this file.
 */

interface Point {
  lat: number;
  lng: number;
}

const T0 = Date.UTC(2026, 8, 13, 17, 30, 0);
const CITY_HALL: Point = { lat: 43.6532, lng: -79.3832 };

/** The shipped defaults (pricing.module.ts), with smoothing off unless a case turns it on. */
const CONFIG: SurgeConfig = {
  enabled: true,
  windowMinutes: 10,
  maxMultiplier: 2.5,
  ratioThreshold: 1.25,
  ratioAtMax: 4,
  minDemand: 3,
  smoothingSeconds: 0,
};

const ZONE = surgeZoneOf(CITY_HALL.lat, CITY_HALL.lng);
const NEIGHBOURS = gridDisk(ZONE, 1).filter((zone) => zone !== ZONE);
const TWO_RINGS_OUT = gridDiskDistances(ZONE, 2)[2][0];

describe('SurgeService', () => {
  const clock = { now: T0 };
  let server: FakeRedisServer;
  let index: H3DriverIndexService;
  let surge: SurgeService;
  let nextDriver: number;

  beforeAll(() => {
    // The index reads its freshness window from the environment.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://uride:uride@localhost:5432/uride',
      DIRECT_URL: 'postgresql://uride:uride@localhost:5432/uride',
      REDIS_URL: 'redis://localhost:6379',
      JWT_LOCAL_SECRET: 'a-test-only-secret-of-at-least-32-characters',
      DRIVER_LOCATION_STALE_SECONDS: '60',
      DRIVER_ONLINE_HEARTBEAT_SECONDS: '120',
    });
    _resetEnvCache();
  });

  beforeEach(() => {
    clock.now = T0;
    nextDriver = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    server = new FakeRedisServer(() => clock.now);
    index = new H3DriverIndexService(redisOn(server));
    surge = surgeWith();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function redisOn(target: FakeRedisServer): RedisService {
    return { client: new FakeRedisClient(target) } as unknown as RedisService;
  }

  function surgeWith(overrides: Partial<SurgeConfig> = {}): SurgeService {
    return new SurgeService(redisOn(server), index, { ...CONFIG, ...overrides });
  }

  /** `count` ride requests from distinct riders somewhere in `zone`. */
  async function requests(zone: string, count: number, via: SurgeService = surge, tag = zone): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const at = spotIn(zone, i);
      await via.recordDemand(at.lat, at.lng, `rider-${tag}-${i}`);
    }
  }

  async function drivers(zone: string, count: number, status: IndexedDriverStatus = 'online'): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const at = spotIn(zone, i);
      nextDriver += 1;
      await index.upsert({
        driverId: `d0000000-0000-4000-8000-${String(nextDriver).padStart(12, '0')}`,
        lat: at.lat,
        lng: at.lng,
        headingDegrees: null,
        speedMps: null,
        recordedAtMs: clock.now,
        rideId: status === 'on_trip' ? '33333333-3333-4333-8333-333333333333' : null,
        status,
      });
    }
  }

  function quote(via: SurgeService = surge): ReturnType<SurgeService['evaluate']> {
    return via.evaluate(CITY_HALL.lat, CITY_HALL.lng);
  }

  // -------------------------------------------------------------------------
  // No surge below the threshold
  // -------------------------------------------------------------------------

  describe('no surge below the threshold', () => {
    it('a neighbourhood with a driver for every request pays the base price', async () => {
      await requests(ZONE, 10);
      await drivers(ZONE, 10);

      expect(await quote()).toEqual({
        zone: ZONE,
        status: 'measured',
        demand: 10,
        supply: 10,
        ratio: 1,
        targetMultiplier: 1,
        multiplier: 1,
      });
    });

    it('a ratio exactly on the threshold is still the base price', async () => {
      await requests(ZONE, 5);
      await drivers(ZONE, 4);

      const reading = await quote();
      expect(reading.ratio).toBe(1.25);
      expect(reading.targetMultiplier).toBe(1);
      expect(reading.multiplier).toBe(1);
    });

    it('too few requests to mean anything never surge — even with no drivers at all', async () => {
      await requests(ZONE, 2);
      const twoRiders = await quote();
      expect(twoRiders).toMatchObject({ demand: 2, supply: 0, ratio: 2, targetMultiplier: 1, multiplier: 1 });

      // The third request crosses SURGE_MIN_DEMAND: it was the gate, not the curve.
      await requests(ZONE, 1, surge, 'third');
      expect((await quote()).multiplier).toBeGreaterThan(1);
    });

    it('a rider re-requesting is one vote, and drivers already on a trip are not supply', async () => {
      const at = spotIn(ZONE, 0);
      for (let i = 0; i < 8; i += 1) await surge.recordDemand(at.lat, at.lng, 'rider-impatient');
      await requests(ZONE, 2, surge, 'others');
      await drivers(ZONE, 2, 'online');
      await drivers(ZONE, 10, 'on_trip');

      expect(await quote()).toMatchObject({ demand: 3, supply: 2, ratio: 1.5 });
    });

    it('switched off, every quote is the base price — and demand keeps counting for when it comes back on', async () => {
      const off = surgeWith({ enabled: false });
      await requests(ZONE, 30, off);

      expect(await quote(off)).toMatchObject({ status: 'disabled', multiplier: 1 });
      expect(await quote(surgeWith())).toMatchObject({ status: 'measured', demand: 30, multiplier: 2.5 });
    });
  });

  // -------------------------------------------------------------------------
  // Ramp
  // -------------------------------------------------------------------------

  describe('ramps', () => {
    it('the curve is flat to the threshold, rises monotonically without steps, and is flat at the cap', () => {
      let previous = surgeTargetFor(0, CONFIG);
      let largestStep = 0;
      for (let hundredths = 0; hundredths <= 600; hundredths += 1) {
        const ratio = hundredths / 100;
        const target = surgeTargetFor(ratio, CONFIG);
        if (ratio <= CONFIG.ratioThreshold) expect(target).toBe(1);
        else if (ratio >= CONFIG.ratioAtMax) expect(target).toBe(CONFIG.maxMultiplier);
        else {
          expect(target).toBeGreaterThan(1);
          expect(target).toBeLessThan(CONFIG.maxMultiplier);
        }
        expect(target).toBeGreaterThanOrEqual(previous);
        largestStep = Math.max(largestStep, target - previous);
        previous = target;
      }
      // A 0.01 change in ratio never moves the target by more than a cent in
      // the dollar: there is no step anywhere on the curve, including at the
      // threshold and the cap.
      expect(largestStep).toBeLessThan(0.01);
      // Drifting just over the threshold still quotes 1.0x after rounding.
      expect(roundSurge(surgeTargetFor(1.4, CONFIG))).toBe(1);
    });

    it('the quoted multiplier climbs with demand against fixed supply, one decimal at a time', async () => {
      await drivers(ZONE, 4);
      const multipliers: number[] = [];
      let recorded = 0;
      for (const demand of [4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 40]) {
        await requests(ZONE, demand - recorded, surge, `wave-${demand}`);
        recorded = demand;
        const reading = await quote();
        expect(reading).toMatchObject({ demand, supply: 4 });
        expect(reading.multiplier).toBe(roundSurge(surgeTargetFor(demand / 4, CONFIG)));
        multipliers.push(reading.multiplier);
      }

      expect(multipliers.slice(0, 2)).toEqual([1, 1]);
      expect(multipliers[multipliers.length - 1]).toBe(2.5);
      expect(multipliers.filter((m) => m > 1 && m < 2.5).length).toBeGreaterThanOrEqual(3);
      multipliers.forEach((m, i) => {
        expect(Number.isInteger(Math.round(m * 10)) && Math.abs(m * 10 - Math.round(m * 10)) < 1e-9).toBe(true);
        if (i > 0) expect(m).toBeGreaterThanOrEqual(multipliers[i - 1]);
      });
    });

    it('with smoothing on, a sudden shortage moves the price over minutes — never between quotes seconds apart', async () => {
      const smoothed = surgeWith({ smoothingSeconds: 120, windowMinutes: 30 });
      expect((await quote(smoothed)).multiplier).toBe(1); // a calm zone, shown 1.0x

      await requests(ZONE, 40, smoothed); // a stadium lets out: target is the cap
      expect((await quote(smoothed)).targetMultiplier).toBe(2.5);

      // A rider dragging the pin: a hundred quotes inside a second.
      for (let i = 0; i < 100; i += 1) {
        clock.now += 10;
        expect((await quote(smoothed)).multiplier).toBe(1);
      }

      clock.now += 120_000; // one time constant
      const oneMinuteLater = (await quote(smoothed)).multiplier;
      expect(oneMinuteLater).toBeGreaterThan(1.5);
      expect(oneMinuteLater).toBeLessThan(2.5);

      clock.now += 480_000; // five time constants in all
      expect((await quote(smoothed)).multiplier).toBeGreaterThanOrEqual(2.4);
    });
  });

  // -------------------------------------------------------------------------
  // Cap
  // -------------------------------------------------------------------------

  describe('never exceeds the cap', () => {
    it('an extreme shortage is charged the cap and not a cent more', async () => {
      await requests(ZONE, 150);

      expect(await quote()).toMatchObject({ supply: 0, ratio: 150, targetMultiplier: 2.5, multiplier: 2.5 });
      expect(surgeTargetFor(1e9, CONFIG)).toBe(2.5);
      expect(surgeTargetFor(Number.POSITIVE_INFINITY, CONFIG)).toBe(2.5);
      expect(surgeTargetFor(Number.NaN, CONFIG)).toBe(1);
    });

    it('an average left above the cap — ops just lowered it — is clamped on the very next quote', async () => {
      // What the smoothing script stored while the cap was 3.0, seconds ago.
      server.command(['HSET', `uride:surge:{${ZONE}}:avg`, 'm', '2.900000', 't', String(clock.now - 5_000)]);
      const lowered = surgeWith({ smoothingSeconds: 120, maxMultiplier: 2 });
      await requests(ZONE, 150, lowered);

      expect(await quote(lowered)).toMatchObject({ targetMultiplier: 2, multiplier: 2 });
    });

    it('a corrupt smoothed average never becomes a price, and the next quote overwrites it (as smooth() documents)', async () => {
      // SurgeService.smooth(): "A corrupt average must not become a price. Use
      // the live target instead; the next write overwrites the bad value."
      const averageKey = `uride:surge:{${ZONE}}:avg`;
      server.command(['HSET', averageKey, 'm', 'not-a-number', 't', String(clock.now - 5_000)]);
      server.command(['EXPIRE', averageKey, '660']);
      const smoothed = surgeWith({ smoothingSeconds: 120 });
      await requests(ZONE, 150, smoothed);

      const reading = await quote(smoothed);
      expect(reading).toMatchObject({ status: 'measured', targetMultiplier: 2.5, multiplier: 2.5 });
      expect(Number.isFinite(Number(server.hashOf(averageKey)?.get('m')))).toBe(true);
    });

    it('stays inside [1.0, cap] at one decimal for any mix of demand, supply, smoothing and time', async () => {
      const random = seededRandom(0xca9);
      for (let scenario = 0; scenario < 40; scenario += 1) {
        server = new FakeRedisServer(() => clock.now);
        index = new H3DriverIndexService(redisOn(server));
        const service = surgeWith({ smoothingSeconds: Math.floor(random() * 300) });
        const zones = gridDisk(ZONE, 1);
        for (let burst = 0; burst < 4; burst += 1) {
          await requests(zones[Math.floor(random() * zones.length)], Math.floor(random() * 30), service, `s${scenario}b${burst}`);
          await drivers(zones[Math.floor(random() * zones.length)], Math.floor(random() * 8));
          clock.now += Math.floor(random() * 90_000);
          const { multiplier } = await quote(service);
          expect(multiplier).toBeGreaterThanOrEqual(1);
          expect(multiplier).toBeLessThanOrEqual(CONFIG.maxMultiplier);
          expect(Math.abs(multiplier * 10 - Math.round(multiplier * 10))).toBeLessThan(1e-9);
        }
      }
    });

    it('when the numbers cannot be read, the rider pays the base price and a request still goes through', async () => {
      const refused = (): Promise<never> => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      const deadPipeline = { mget: () => deadPipeline, zcount: () => deadPipeline, exec: refused };
      const deadRedis = { client: { eval: refused, evalsha: refused, pipeline: () => deadPipeline } } as unknown as RedisService;
      const blind = new SurgeService(deadRedis, new H3DriverIndexService(deadRedis), CONFIG);

      await expect(blind.recordDemand(CITY_HALL.lat, CITY_HALL.lng, 'rider-1')).resolves.toBeUndefined();
      expect(await quote(blind)).toMatchObject({ status: 'unavailable', multiplier: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Neighbourhood damping
  // -------------------------------------------------------------------------

  describe('a single-hex spike is damped by the neighbour ring', () => {
    it('a burst of requests in one zone whose neighbours are full of idle drivers is not a shortage', async () => {
      await requests(ZONE, 12);
      await drivers(ZONE, 1);
      for (const neighbour of NEIGHBOURS) await drivers(neighbour, 2);

      // Priced on that one hexagon alone, this would be the cap.
      expect(surgeTargetFor(12 / 1, CONFIG)).toBe(2.5);
      expect(await quote()).toMatchObject({ demand: 12, supply: 13, targetMultiplier: 1, multiplier: 1 });
    });

    it('the same burst with an empty ring is a real shortage, and is priced as one', async () => {
      await requests(ZONE, 12);
      await drivers(ZONE, 1);

      expect(await quote()).toMatchObject({ demand: 12, supply: 1, multiplier: 2.5 });
    });

    it('requests next door count toward this zone, and drivers two rings out do not', async () => {
      await requests(NEIGHBOURS[0], 12);
      await drivers(ZONE, 1);
      await drivers(TWO_RINGS_OUT, 30);

      expect(await quote()).toMatchObject({ demand: 12, supply: 1, multiplier: 2.5 });
    });

    it('a zone just beyond the ring is untouched by the spike', async () => {
      await requests(ZONE, 40);
      const beyond = spotIn(TWO_RINGS_OUT, 0);

      expect(await surge.evaluate(beyond.lat, beyond.lng)).toMatchObject({ zone: TWO_RINGS_OUT, demand: 0, multiplier: 1 });
    });
  });

  describe('zones', () => {
    it('a request at a zone edge counts in the zone its res-8 cell belongs to — the zone the driver beside it is counted in', async () => {
      // H3 children do not tile their parent exactly, so near an edge a
      // point's own res-7 cell and its res-8 cell's parent disagree. Supply is
      // rolled up by parentage; demand has to be, or the rider and the driver
      // parked beside them are counted in different neighbourhoods.
      const edge = zoneEdgePoint(ZONE);
      const byParentage = cellToParent(latLngToCell(edge.lat, edge.lng, H3_DISPATCH_RESOLUTION), 7);
      const byGeometry = latLngToCell(edge.lat, edge.lng, 7);
      expect(byParentage).toBe(ZONE);
      expect(byGeometry).not.toBe(ZONE);
      // A neighbour of the parentage zone that is NOT a neighbour of the geometric one.
      const farSide = gridDisk(ZONE, 1).find((zone) => gridDistance(zone, byGeometry) === 2);
      if (!farSide) throw new Error('fixture: no zone adjacent to one and two rings from the other');

      expect(surgeZoneOf(edge.lat, edge.lng)).toBe(ZONE);
      for (let i = 0; i < 12; i += 1) await surge.recordDemand(edge.lat, edge.lng, `rider-edge-${i}`);
      const quoteAt = spotIn(farSide, 0);

      expect(await surge.evaluate(quoteAt.lat, quoteAt.lng)).toMatchObject({ zone: farSide, demand: 12 });
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A point inside a res-7 zone: the centre of one of its res-8 children, so the
 * point's zone is the zone by construction — asserted anyway, because the
 * whole suite leans on it.
 */
function spotIn(zone: string, n: number): Point {
  const children = cellToChildren(zone, H3_DISPATCH_RESOLUTION);
  const [lat, lng] = cellToLatLng(children[n % children.length]);
  // A few metres apart per n, so no two riders or drivers share a coordinate.
  const at = { lat: lat + ((n % 50) - 25) * 0.00001, lng };
  if (surgeZoneOf(at.lat, at.lng) !== zone) throw new Error(`fixture point ${n} fell outside zone ${zone}`);
  return at;
}

/**
 * A point near `zone`'s edge whose res-8 cell's parent is `zone` but whose own
 * res-7 cell is a neighbour. Found by a deterministic scan, so the same point
 * every run.
 */
function zoneEdgePoint(zone: string): Point {
  const [lat, lng] = cellToLatLng(zone);
  for (let i = -60; i <= 60; i += 1) {
    for (let j = -60; j <= 60; j += 1) {
      const at = { lat: lat + i * 0.0004, lng: lng + j * 0.0005 };
      const parent = cellToParent(latLngToCell(at.lat, at.lng, H3_DISPATCH_RESOLUTION), 7);
      const own = latLngToCell(at.lat, at.lng, 7);
      if (parent === zone && own !== zone && gridDisk(zone, 1).some((z) => gridDistance(z, own) === 2)) return at;
    }
  }
  throw new Error(`fixture: no edge point found for zone ${zone}`);
}

/** mulberry32: small, fast, and the same sequence on every machine. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ===========================================================================
// FakeRedis — an in-memory Redis 7 that runs Lua
// ===========================================================================
//
// Why not jest.fn() stubs: what makes the geo pipeline correct — a driver
// moving between cells, the out-of-order guard, the status race, claiming and
// releasing a trail batch, the surge average — lives in Lua scripts, and a stub
// replaying canned replies passes whatever those scripts do. So the scripts run
// as written, through an interpreter for the Lua 5.1 subset Redis scripts use,
// against a keyspace with Redis' reply conversions, lazy expiry, empty-key
// deletion, strict integer arguments, unpack()'s stack limit and Redis 7's
// refusal to touch undeclared globals.
//
// Pipelines execute atomically at exec(); `beforePipelineExec` is the seam for
// a concurrent writer. This block is byte-identical at the foot of
// h3-driver-index.service.spec.ts, location-flush.worker.spec.ts and
// surge.service.spec.ts. It lives in the spec files only because those are the
// files this change owns; src/testing/ is where it belongs.

type RedisReply = null | number | string | { status: string } | RedisReply[];

type StoredValue =
  | { type: 'string'; data: string }
  | { type: 'hash'; data: Map<string, string> }
  | { type: 'list'; data: string[] }
  | { type: 'zset'; data: Map<string, number> };

type StoredOf<T extends StoredValue['type']> = Extract<StoredValue, { type: T }>;

interface StoredEntry {
  value: StoredValue;
  expiresAtMs: number | null;
}

class FakeRedisServer {
  /** Command names in execution order, including those issued from Lua. */
  readonly commandLog: string[] = [];
  /** Called before every pipeline runs. */
  beforePipelineExec: (() => void) | null = null;

  private readonly store = new Map<string, StoredEntry>();
  private readonly scripts = new Map<string, LuaBlock>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  // --- Introspection for assertions (not Redis commands) -------------------

  keysMatching(pattern: string): string[] {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    return [...this.store.keys()].filter((k) => regex.test(k) && this.live(k) !== undefined);
  }

  hashOf(key: string): Map<string, string> | null {
    return this.read(key, 'hash')?.data ?? null;
  }

  listOf(key: string): string[] {
    return [...(this.read(key, 'list')?.data ?? [])];
  }

  stringOf(key: string): string | null {
    return this.read(key, 'string')?.data ?? null;
  }

  zscore(key: string, member: string): number | null {
    return this.read(key, 'zset')?.data.get(member) ?? null;
  }

  // --- Commands --------------------------------------------------------------

  command(argv: readonly string[]): RedisReply {
    const name = (argv[0] ?? '').toUpperCase();
    const a = argv.slice(1);
    this.commandLog.push(name);
    switch (name) {
      case 'TIME': {
        const now = this.clock();
        return [String(Math.floor(now / 1000)), String((now % 1000) * 1000)];
      }
      case 'GET':
        return this.read(arg(a, 0), 'string')?.data ?? null;
      case 'SET':
        return this.set(a);
      case 'MGET':
        return a.map((k) => {
          const entry = this.live(k);
          return entry?.value.type === 'string' ? entry.value.data : null;
        });
      case 'INCR': {
        const k = arg(a, 0);
        const current = this.read(k, 'string');
        const next = (current ? toInteger(current.data) : 0) + 1;
        if (current) current.data = String(next);
        else this.store.set(k, { value: { type: 'string', data: String(next) }, expiresAtMs: null });
        return next;
      }
      case 'DEL':
        return a.filter((k) => this.live(k) !== undefined && this.store.delete(k)).length;
      case 'EXISTS':
        return a.filter((k) => this.live(k) !== undefined).length;
      case 'EXPIRE':
        return this.expireAt(arg(a, 0), this.clock() + toInteger(a[1]) * 1000);
      case 'PEXPIRE':
        return this.expireAt(arg(a, 0), this.clock() + toInteger(a[1]));
      case 'PEXPIREAT':
        return this.expireAt(arg(a, 0), toInteger(a[1]));
      case 'PTTL': {
        const entry = this.live(arg(a, 0));
        if (!entry) return -2;
        return entry.expiresAtMs === null ? -1 : entry.expiresAtMs - this.clock();
      }
      case 'HSET': {
        if (a.length < 3 || a.length % 2 === 0) throw wrongArity(name);
        const hash = this.readOrCreate(arg(a, 0), 'hash', () => ({ type: 'hash', data: new Map<string, string>() }));
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!hash.data.has(arg(a, i))) added += 1;
          hash.data.set(arg(a, i), arg(a, i + 1));
        }
        return added;
      }
      case 'HMGET': {
        const hash = this.read(arg(a, 0), 'hash');
        return a.slice(1).map((field) => hash?.data.get(field) ?? null);
      }
      case 'RPUSH': {
        if (a.length < 2) throw wrongArity(name);
        const list = this.readOrCreate(arg(a, 0), 'list', () => ({ type: 'list', data: [] }));
        for (const value of a.slice(1)) list.data.push(value);
        return list.data.length;
      }
      case 'LLEN':
        return this.read(arg(a, 0), 'list')?.data.length ?? 0;
      case 'LRANGE': {
        const [start, stop] = [toInteger(a[1]), toInteger(a[2])];
        const list = this.read(arg(a, 0), 'list');
        if (!list) return [];
        const [from, to] = listRange(list.data.length, start, stop);
        return from > to ? [] : list.data.slice(from, to + 1);
      }
      case 'LTRIM': {
        const k = arg(a, 0);
        const [start, stop] = [toInteger(a[1]), toInteger(a[2])];
        const list = this.read(k, 'list');
        if (list) {
          const [from, to] = listRange(list.data.length, start, stop);
          list.data = from > to ? [] : list.data.slice(from, to + 1);
          this.dropIfEmpty(k);
        }
        return { status: 'OK' };
      }
      case 'ZADD': {
        if (a.length < 3 || a.length % 2 === 0) throw wrongArity(name);
        const pairs: [number, string][] = [];
        for (let i = 1; i < a.length; i += 2) pairs.push([toScore(a[i]), arg(a, i + 1)]);
        const zset = this.readOrCreate(arg(a, 0), 'zset', () => ({ type: 'zset', data: new Map<string, number>() }));
        let added = 0;
        for (const [score, member] of pairs) {
          if (!zset.data.has(member)) added += 1;
          zset.data.set(member, score);
        }
        return added;
      }
      case 'ZREM': {
        const k = arg(a, 0);
        const zset = this.read(k, 'zset');
        if (!zset) return 0;
        const removed = a.slice(1).filter((member) => zset.data.delete(member)).length;
        this.dropIfEmpty(k);
        return removed;
      }
      case 'ZREMRANGEBYSCORE': {
        const k = arg(a, 0);
        const [min, max] = [toScoreBound(a[1]), toScoreBound(a[2])];
        const zset = this.read(k, 'zset');
        if (!zset) return 0;
        let removed = 0;
        for (const [member, score] of [...zset.data]) {
          if (withinBounds(score, min, max)) {
            zset.data.delete(member);
            removed += 1;
          }
        }
        this.dropIfEmpty(k);
        return removed;
      }
      case 'ZRANGEBYSCORE': {
        if (a.length !== 3) throw new Error('ERR syntax error (the fake implements no ZRANGEBYSCORE options)');
        const [min, max] = [toScoreBound(a[1]), toScoreBound(a[2])];
        const zset = this.read(arg(a, 0), 'zset');
        if (!zset) return [];
        return [...zset.data]
          .filter(([, score]) => withinBounds(score, min, max))
          .sort(([ma, sa], [mb, sb]) => sa - sb || (ma < mb ? -1 : ma > mb ? 1 : 0))
          .map(([member]) => member);
      }
      case 'ZCOUNT': {
        const [min, max] = [toScoreBound(a[1]), toScoreBound(a[2])];
        const zset = this.read(arg(a, 0), 'zset');
        return zset ? [...zset.data.values()].filter((score) => withinBounds(score, min, max)).length : 0;
      }
      case 'SCRIPT':
        if (arg(a, 0).toUpperCase() !== 'LOAD') throw new Error('ERR the fake implements SCRIPT LOAD only');
        return this.loadScript(arg(a, 1));
      case 'EVAL':
        return this.runScript(this.loadScript(arg(a, 0)), a.slice(1));
      case 'EVALSHA':
        return this.runScript(arg(a, 0).toLowerCase(), a.slice(1));
      default:
        throw new Error(`ERR unknown command '${name}' (not implemented by the fake)`);
    }
  }

  private set(a: readonly string[]): RedisReply {
    const k = arg(a, 0);
    const value = arg(a, 1);
    let nx = false;
    let xx = false;
    let expiresAtMs: number | null = null;
    for (let i = 2; i < a.length; i += 1) {
      const option = arg(a, i).toUpperCase();
      if (option === 'NX') nx = true;
      else if (option === 'XX') xx = true;
      else if (option === 'EX' || option === 'PX') {
        i += 1;
        const amount = toInteger(a[i]);
        if (amount <= 0) throw new Error("ERR invalid expire time in 'set' command");
        expiresAtMs = this.clock() + (option === 'EX' ? amount * 1000 : amount);
      } else throw new Error('ERR syntax error');
    }
    const exists = this.live(k) !== undefined;
    if ((nx && exists) || (xx && !exists)) return null;
    this.store.set(k, { value: { type: 'string', data: value }, expiresAtMs });
    return { status: 'OK' };
  }

  private live(key: string): StoredEntry | undefined {
    const entry = this.store.get(key);
    // Redis: a key is expired once now > its expiry.
    if (entry && entry.expiresAtMs !== null && this.clock() > entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private read<T extends StoredValue['type']>(key: string, type: T): StoredOf<T> | undefined {
    const entry = this.live(key);
    if (!entry) return undefined;
    if (entry.value.type !== type) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    return entry.value as StoredOf<T>;
  }

  private readOrCreate<T extends StoredValue['type']>(key: string, type: T, empty: () => StoredOf<T>): StoredOf<T> {
    const existing = this.read(key, type);
    if (existing) return existing;
    const created = empty();
    this.store.set(key, { value: created, expiresAtMs: null });
    return created;
  }

  private dropIfEmpty(key: string): void {
    const entry = this.store.get(key);
    if (!entry) return;
    const { value } = entry;
    const size = value.type === 'list' ? value.data.length : value.type === 'string' ? 1 : value.data.size;
    if (size === 0) this.store.delete(key);
  }

  private expireAt(key: string, whenMs: number): number {
    const entry = this.live(key);
    if (!entry) return 0;
    // Redis deletes outright when the expiry is already due.
    if (whenMs <= this.clock()) this.store.delete(key);
    else entry.expiresAtMs = whenMs;
    return 1;
  }

  private loadScript(source: string): string {
    const sha = createHash('sha1').update(source).digest('hex');
    if (!this.scripts.has(sha)) {
      try {
        this.scripts.set(sha, new LuaParser(tokenizeLua(source)).parseChunk());
      } catch (error) {
        throw new Error(`ERR Error compiling script: ${errorMessage(error)}`);
      }
    }
    return sha;
  }

  private runScript(sha: string, rest: readonly string[]): RedisReply {
    const block = this.scripts.get(sha);
    if (!block) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    const numKeys = toInteger(rest[0]);
    if (numKeys < 0 || numKeys > rest.length - 1) {
      throw new Error("ERR Number of keys can't be greater than number of args");
    }
    const globals = luaGlobals((args, protectedCall) => this.callFromLua(args, protectedCall));
    globals.set('KEYS', luaArray(rest.slice(1, 1 + numKeys)));
    globals.set('ARGV', luaArray(rest.slice(1 + numKeys)));
    try {
      return luaToReply(new LuaInterpreter(globals).run(block)[0] ?? null);
    } catch (error) {
      if (error instanceof LuaError) throw new Error(`ERR user_script: ${error.message}`);
      throw error;
    }
  }

  private callFromLua(args: readonly LuaValue[], protectedCall: boolean): LuaValue {
    if (args.length === 0) throw new LuaError('Please specify at least one argument for this redis lib call');
    const argv = args.map((value) => {
      if (typeof value === 'string') return value;
      // Redis 7 prints Lua numbers shortest-round-trip (fpconv_dtoa).
      if (typeof value === 'number') return String(value);
      throw new LuaError('Lua redis lib command arguments must be strings or integers');
    });
    try {
      return replyToLua(this.command(argv));
    } catch (error) {
      if (!protectedCall) throw new LuaError(errorMessage(error));
      const failure = new LuaTable();
      failure.set('err', errorMessage(error));
      return failure;
    }
  }
}

type ClientArg = string | number | readonly (string | number)[];

/** The slice of ioredis' surface the geo services call. */
class FakeRedisClient {
  constructor(readonly server: FakeRedisServer) {}

  eval(...args: ClientArg[]): Promise<unknown> {
    return this.send('EVAL', args);
  }
  evalsha(...args: ClientArg[]): Promise<unknown> {
    return this.send('EVALSHA', args);
  }
  script(...args: ClientArg[]): Promise<unknown> {
    return this.send('SCRIPT', args);
  }
  time(): Promise<unknown> {
    return this.send('TIME', []);
  }
  get(...args: ClientArg[]): Promise<unknown> {
    return this.send('GET', args);
  }
  set(...args: ClientArg[]): Promise<unknown> {
    return this.send('SET', args);
  }
  mget(...args: ClientArg[]): Promise<unknown> {
    return this.send('MGET', args);
  }
  del(...args: ClientArg[]): Promise<unknown> {
    return this.send('DEL', args);
  }
  hmget(...args: ClientArg[]): Promise<unknown> {
    return this.send('HMGET', args);
  }
  rpush(...args: ClientArg[]): Promise<unknown> {
    return this.send('RPUSH', args);
  }
  lrange(...args: ClientArg[]): Promise<unknown> {
    return this.send('LRANGE', args);
  }
  llen(...args: ClientArg[]): Promise<unknown> {
    return this.send('LLEN', args);
  }
  pipeline(): FakePipeline {
    return new FakePipeline(this.server);
  }

  private send(name: string, args: readonly ClientArg[]): Promise<unknown> {
    try {
      return Promise.resolve(toClientReply(this.server.command([name, ...flattenArgs(args)])));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class FakePipeline {
  private readonly queued: string[][] = [];

  constructor(private readonly server: FakeRedisServer) {}

  zrangebyscore(...args: ClientArg[]): this {
    return this.queue('ZRANGEBYSCORE', args);
  }
  zcount(...args: ClientArg[]): this {
    return this.queue('ZCOUNT', args);
  }
  hmget(...args: ClientArg[]): this {
    return this.queue('HMGET', args);
  }
  evalsha(...args: ClientArg[]): this {
    return this.queue('EVALSHA', args);
  }
  set(...args: ClientArg[]): this {
    return this.queue('SET', args);
  }
  mget(...args: ClientArg[]): this {
    return this.queue('MGET', args);
  }

  exec(): Promise<[Error | null, unknown][]> {
    this.server.beforePipelineExec?.();
    return Promise.resolve(
      this.queued.map((argv): [Error | null, unknown] => {
        try {
          return [null, toClientReply(this.server.command(argv))];
        } catch (error) {
          return [error instanceof Error ? error : new Error(String(error)), null];
        }
      }),
    );
  }

  private queue(name: string, args: readonly ClientArg[]): this {
    this.queued.push([name, ...flattenArgs(args)]);
    return this;
  }
}

function flattenArgs(args: readonly ClientArg[]): string[] {
  const out: string[] = [];
  for (const value of args) {
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
    else for (const item of value) out.push(String(item));
  }
  return out;
}

function toClientReply(reply: RedisReply): unknown {
  if (reply === null || typeof reply === 'number' || typeof reply === 'string') return reply;
  if (Array.isArray(reply)) return reply.map(toClientReply);
  return reply.status;
}

function arg(a: readonly string[], i: number): string {
  const value = a[i];
  if (value === undefined) throw new Error('ERR wrong number of arguments');
  return value;
}

function wrongArity(command: string): Error {
  return new Error(`ERR wrong number of arguments for '${command.toLowerCase()}' command`);
}

function toInteger(raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) throw new Error('ERR value is not an integer or out of range');
  return Number(raw);
}

function toScore(raw: string | undefined): number {
  const value = parseScore(raw);
  if (value === null) throw new Error('ERR value is not a valid float');
  return value;
}

interface ScoreBound {
  value: number;
  exclusive: boolean;
}

function toScoreBound(raw: string | undefined): ScoreBound {
  const exclusive = raw?.startsWith('(') ?? false;
  const value = parseScore(exclusive ? raw?.slice(1) : raw);
  if (value === null) throw new Error('ERR min or max is not a float');
  return { value, exclusive };
}

function parseScore(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (raw === '-inf') return Number.NEGATIVE_INFINITY;
  if (raw === '+inf' || raw === 'inf') return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}

function withinBounds(score: number, min: ScoreBound, max: ScoreBound): boolean {
  const aboveMin = min.exclusive ? score > min.value : score >= min.value;
  const belowMax = max.exclusive ? score < max.value : score <= max.value;
  return aboveMin && belowMax;
}

function listRange(length: number, start: number, stop: number): [number, number] {
  const from = Math.max(0, start < 0 ? length + start : start);
  const to = Math.min(length - 1, stop < 0 ? length + stop : stop);
  return [from, to];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Lua 5.1 — the subset Redis scripts are written in
// ---------------------------------------------------------------------------

class LuaError extends Error {}

class LuaTable {
  private readonly entries = new Map<Exclude<LuaValue, null>, LuaValue>();

  get(key: LuaValue): LuaValue {
    if (key === null) return null;
    const value = this.entries.get(key);
    return value === undefined ? null : value;
  }

  set(key: LuaValue, value: LuaValue): void {
    if (key === null || (typeof key === 'number' && Number.isNaN(key))) {
      throw new LuaError('table index is nil or NaN');
    }
    if (value === null) this.entries.delete(key);
    else this.entries.set(key, value);
  }

  /** A border, as `#` returns: here always the first one. */
  length(): number {
    let n = 0;
    while (this.entries.has(n + 1)) n += 1;
    return n;
  }
}

class LuaFunction {
  constructor(readonly invoke: (args: LuaValue[]) => LuaValue[]) {}
}

type LuaValue = null | boolean | number | string | LuaTable | LuaFunction;

/** LUAI_MAXCSTACK in the Lua Redis embeds; unpack() of more values than this fails. */
const LUA_MAX_C_STACK = 8000;

interface LuaToken {
  kind: 'name' | 'number' | 'string' | 'symbol' | 'eof';
  text: string;
  number: number;
  line: number;
}

type LuaExpr =
  | { kind: 'nil' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'name'; name: string }
  | { kind: 'index'; target: LuaExpr; key: LuaExpr }
  | { kind: 'call'; callee: LuaExpr; args: LuaExpr[] }
  | { kind: 'function'; params: string[]; body: LuaBlock }
  | { kind: 'table'; fields: { key: LuaExpr | null; value: LuaExpr }[] }
  | { kind: 'paren'; inner: LuaExpr }
  | { kind: 'unary'; op: string; operand: LuaExpr }
  | { kind: 'binary'; op: string; left: LuaExpr; right: LuaExpr };

type LuaStmt =
  | { kind: 'local'; names: string[]; values: LuaExpr[] }
  | { kind: 'localFunction'; name: string; params: string[]; body: LuaBlock }
  | { kind: 'assign'; targets: LuaExpr[]; values: LuaExpr[] }
  | { kind: 'call'; call: Extract<LuaExpr, { kind: 'call' }> }
  | { kind: 'if'; branches: { test: LuaExpr; body: LuaBlock }[]; otherwise: LuaBlock | null }
  | { kind: 'for'; variable: string; start: LuaExpr; limit: LuaExpr; step: LuaExpr | null; body: LuaBlock }
  | { kind: 'while'; test: LuaExpr; body: LuaBlock }
  | { kind: 'do'; body: LuaBlock }
  | { kind: 'return'; values: LuaExpr[] }
  | { kind: 'break' };

type LuaBlock = LuaStmt[];

const LUA_KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

const LUA_SYMBOLS = [
  '...', '..', '==', '~=', '<=', '>=', '+', '-', '*', '/', '%', '^', '#',
  '<', '>', '=', '(', ')', '{', '}', '[', ']', ';', ':', ',', '.',
];

/** Left and right binding power, from lparser.c. */
const LUA_BINARY_PRIORITY: ReadonlyMap<string, readonly [number, number]> = new Map([
  ['or', [1, 1]], ['and', [2, 2]],
  ['<', [3, 3]], ['>', [3, 3]], ['<=', [3, 3]], ['>=', [3, 3]], ['~=', [3, 3]], ['==', [3, 3]],
  ['..', [5, 4]], ['+', [6, 6]], ['-', [6, 6]], ['*', [7, 7]], ['/', [7, 7]], ['%', [7, 7]],
  ['^', [10, 9]],
]);
const LUA_UNARY_PRIORITY = 8;

function tokenizeLua(source: string): LuaToken[] {
  const tokens: LuaToken[] = [];
  const name = /[A-Za-z_][A-Za-z0-9_]*/y;
  const numeral = /0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let line = 1;
  let i = 0;
  const push = (kind: LuaToken['kind'], text: string, number = 0): void => {
    tokens.push({ kind, text, number, line });
  };

  while (i < source.length) {
    const c = source[i];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
    } else if (source.startsWith('--', i)) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      name.lastIndex = i;
      const word = name.exec(source)?.[0] ?? c;
      push('name', word);
      i += word.length;
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(source[i + 1] ?? ''))) {
      numeral.lastIndex = i;
      const text = numeral.exec(source)?.[0] ?? c;
      push('number', text, Number(text));
      i += text.length;
    } else if (c === '"' || c === "'") {
      let value = '';
      let j = i + 1;
      while (source[j] !== c) {
        if (j >= source.length || source[j] === '\n') throw new LuaError(`unfinished string on line ${line}`);
        if (source[j] === '\\') {
          const escaped = source[j + 1] ?? '';
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      push('string', value);
      i = j + 1;
    } else {
      const symbol = LUA_SYMBOLS.find((s) => source.startsWith(s, i));
      if (!symbol) throw new LuaError(`unexpected symbol near '${c}' on line ${line}`);
      push('symbol', symbol);
      i += symbol.length;
    }
  }
  push('eof', '<eof>');
  return tokens;
}

class LuaParser {
  private pos = 0;

  constructor(private readonly tokens: readonly LuaToken[]) {}

  parseChunk(): LuaBlock {
    const block = this.block();
    if (this.peek().kind !== 'eof') throw this.error("'<eof>' expected");
    return block;
  }

  private peek(ahead = 0): LuaToken {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)];
  }

  private isWord(text: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return (token.kind === 'name' || token.kind === 'symbol') && token.text === text;
  }

  private accept(text: string): boolean {
    if (!this.isWord(text)) return false;
    this.pos += 1;
    return true;
  }

  private expect(text: string): void {
    if (!this.accept(text)) throw this.error(`'${text}' expected`);
  }

  private identifier(): string {
    const token = this.peek();
    if (token.kind !== 'name' || LUA_KEYWORDS.has(token.text)) throw this.error('<name> expected');
    this.pos += 1;
    return token.text;
  }

  private error(message: string): LuaError {
    const token = this.peek();
    return new LuaError(`${message} near '${token.text}' on line ${token.line}`);
  }

  private blockEnds(): boolean {
    return this.peek().kind === 'eof' || ['end', 'else', 'elseif', 'until'].some((w) => this.isWord(w));
  }

  private block(): LuaBlock {
    const body: LuaBlock = [];
    while (!this.blockEnds()) {
      if (this.accept('return')) {
        const values = this.blockEnds() || this.isWord(';') ? [] : this.exprList();
        this.accept(';');
        body.push({ kind: 'return', values });
        break;
      }
      const statement = this.statement();
      if (statement) body.push(statement);
    }
    return body;
  }

  private statement(): LuaStmt | null {
    if (this.accept(';')) return null;
    if (this.accept('break')) return { kind: 'break' };
    if (this.accept('local')) {
      if (this.accept('function')) {
        const name = this.identifier();
        return { kind: 'localFunction', name, ...this.functionBody() };
      }
      const names = [this.identifier()];
      while (this.accept(',')) names.push(this.identifier());
      return { kind: 'local', names, values: this.accept('=') ? this.exprList() : [] };
    }
    if (this.accept('if')) {
      const branches: { test: LuaExpr; body: LuaBlock }[] = [];
      let otherwise: LuaBlock | null = null;
      do {
        const test = this.expr();
        this.expect('then');
        branches.push({ test, body: this.block() });
      } while (this.accept('elseif'));
      if (this.accept('else')) otherwise = this.block();
      this.expect('end');
      return { kind: 'if', branches, otherwise };
    }
    if (this.accept('for')) {
      const variable = this.identifier();
      this.expect('=');
      const start = this.expr();
      this.expect(',');
      const limit = this.expr();
      const step = this.accept(',') ? this.expr() : null;
      this.expect('do');
      const body = this.block();
      this.expect('end');
      return { kind: 'for', variable, start, limit, step, body };
    }
    if (this.accept('while')) {
      const test = this.expr();
      this.expect('do');
      const body = this.block();
      this.expect('end');
      return { kind: 'while', test, body };
    }
    if (this.accept('do')) {
      const body = this.block();
      this.expect('end');
      return { kind: 'do', body };
    }

    const first = this.suffixedExpr();
    if (this.isWord('=') || this.isWord(',')) {
      const targets = [first];
      while (this.accept(',')) targets.push(this.suffixedExpr());
      this.expect('=');
      if (targets.some((t) => t.kind !== 'name' && t.kind !== 'index')) throw this.error('cannot assign');
      return { kind: 'assign', targets, values: this.exprList() };
    }
    if (first.kind !== 'call') throw this.error('syntax error');
    return { kind: 'call', call: first };
  }

  private functionBody(): { params: string[]; body: LuaBlock } {
    this.expect('(');
    const params: string[] = [];
    if (!this.isWord(')')) {
      do params.push(this.identifier());
      while (this.accept(','));
    }
    this.expect(')');
    const body = this.block();
    this.expect('end');
    return { params, body };
  }

  private exprList(): LuaExpr[] {
    const list = [this.expr()];
    while (this.accept(',')) list.push(this.expr());
    return list;
  }

  private expr(limit = 0): LuaExpr {
    let left: LuaExpr;
    const token = this.peek();
    if (this.isWord('not') || (token.kind === 'symbol' && (token.text === '-' || token.text === '#'))) {
      this.pos += 1;
      left = { kind: 'unary', op: token.text, operand: this.expr(LUA_UNARY_PRIORITY) };
    } else {
      left = this.simpleExpr();
    }
    for (;;) {
      const op = this.peek();
      const priority = op.kind === 'string' || op.kind === 'number' ? undefined : LUA_BINARY_PRIORITY.get(op.text);
      if (!priority || priority[0] <= limit) return left;
      this.pos += 1;
      left = { kind: 'binary', op: op.text, left, right: this.expr(priority[1]) };
    }
  }

  private simpleExpr(): LuaExpr {
    const token = this.peek();
    if (token.kind === 'number') {
      this.pos += 1;
      return { kind: 'number', value: token.number };
    }
    if (token.kind === 'string') {
      this.pos += 1;
      return { kind: 'string', value: token.text };
    }
    if (this.accept('nil')) return { kind: 'nil' };
    if (this.accept('true')) return { kind: 'boolean', value: true };
    if (this.accept('false')) return { kind: 'boolean', value: false };
    if (this.accept('function')) return { kind: 'function', ...this.functionBody() };
    if (this.isWord('{')) return this.tableConstructor();
    return this.suffixedExpr();
  }

  private suffixedExpr(): LuaExpr {
    let expr: LuaExpr;
    if (this.accept('(')) {
      expr = { kind: 'paren', inner: this.expr() };
      this.expect(')');
    } else {
      expr = { kind: 'name', name: this.identifier() };
    }
    for (;;) {
      if (this.accept('.')) {
        expr = { kind: 'index', target: expr, key: { kind: 'string', value: this.identifier() } };
      } else if (this.accept('[')) {
        expr = { kind: 'index', target: expr, key: this.expr() };
        this.expect(']');
      } else if (this.accept('(')) {
        const args = this.isWord(')') ? [] : this.exprList();
        this.expect(')');
        expr = { kind: 'call', callee: expr, args };
      } else if (this.peek().kind === 'string' || this.isWord('{')) {
        expr = { kind: 'call', callee: expr, args: [this.simpleExpr()] };
      } else {
        return expr;
      }
    }
  }

  private tableConstructor(): LuaExpr {
    this.expect('{');
    const fields: { key: LuaExpr | null; value: LuaExpr }[] = [];
    while (!this.isWord('}')) {
      if (this.accept('[')) {
        const key = this.expr();
        this.expect(']');
        this.expect('=');
        fields.push({ key, value: this.expr() });
      } else if (this.peek().kind === 'name' && this.isWord('=', 1)) {
        const key: LuaExpr = { kind: 'string', value: this.identifier() };
        this.expect('=');
        fields.push({ key, value: this.expr() });
      } else {
        fields.push({ key: null, value: this.expr() });
      }
      if (!this.accept(',') && !this.accept(';')) break;
    }
    this.expect('}');
    return { kind: 'table', fields };
  }
}

class LuaScope {
  private readonly slots = new Map<string, { value: LuaValue }>();

  constructor(private readonly parent: LuaScope | null) {}

  declare(name: string, value: LuaValue): void {
    this.slots.set(name, { value });
  }

  find(name: string): { value: LuaValue } | null {
    return this.slots.get(name) ?? this.parent?.find(name) ?? null;
  }
}

type LuaCompletion = { type: 'return'; values: LuaValue[] } | { type: 'break' } | null;

class LuaInterpreter {
  constructor(private readonly globals: ReadonlyMap<string, LuaValue>) {}

  run(block: LuaBlock): LuaValue[] {
    const done = this.execBlock(block, new LuaScope(null));
    return done?.type === 'return' ? done.values : [];
  }

  private execBlock(block: LuaBlock, parent: LuaScope): LuaCompletion {
    const scope = new LuaScope(parent);
    for (const statement of block) {
      const done = this.exec(statement, scope);
      if (done) return done;
    }
    return null;
  }

  private exec(statement: LuaStmt, scope: LuaScope): LuaCompletion {
    switch (statement.kind) {
      case 'local': {
        const values = this.evalList(statement.values, scope);
        statement.names.forEach((name, i) => scope.declare(name, values[i] ?? null));
        return null;
      }
      case 'localFunction':
        scope.declare(statement.name, null);
        this.assignName(statement.name, this.closure(statement.params, statement.body, scope), scope);
        return null;
      case 'assign': {
        const values = this.evalList(statement.values, scope);
        statement.targets.forEach((target, i) => this.assign(target, values[i] ?? null, scope));
        return null;
      }
      case 'call':
        this.evalCall(statement.call, scope);
        return null;
      case 'if': {
        for (const branch of statement.branches) {
          if (isTruthy(this.eval(branch.test, scope))) return this.execBlock(branch.body, scope);
        }
        return statement.otherwise ? this.execBlock(statement.otherwise, scope) : null;
      }
      case 'for': {
        const start = toArithmetic(this.eval(statement.start, scope));
        const limit = toArithmetic(this.eval(statement.limit, scope));
        const step = statement.step ? toArithmetic(this.eval(statement.step, scope)) : 1;
        for (let v = start; step > 0 ? v <= limit : v >= limit; v += step) {
          const body = new LuaScope(scope);
          body.declare(statement.variable, v);
          const done = this.execBlock(statement.body, body);
          if (done?.type === 'break') break;
          if (done) return done;
        }
        return null;
      }
      case 'while':
        while (isTruthy(this.eval(statement.test, scope))) {
          const done = this.execBlock(statement.body, scope);
          if (done?.type === 'break') break;
          if (done) return done;
        }
        return null;
      case 'do':
        return this.execBlock(statement.body, scope);
      case 'return':
        return { type: 'return', values: this.evalList(statement.values, scope) };
      case 'break':
        return { type: 'break' };
    }
  }

  private assign(target: LuaExpr, value: LuaValue, scope: LuaScope): void {
    if (target.kind === 'name') {
      this.assignName(target.name, value, scope);
      return;
    }
    if (target.kind !== 'index') throw new LuaError('cannot assign to this expression');
    const table = this.eval(target.target, scope);
    if (!(table instanceof LuaTable)) throw new LuaError(`attempt to index a ${luaType(table)} value`);
    table.set(this.eval(target.key, scope), value);
  }

  private assignName(name: string, value: LuaValue, scope: LuaScope): void {
    const slot = scope.find(name);
    // Redis 7 locks the global table, so a missing `local` fails the script.
    if (!slot) throw new LuaError(`Attempt to modify a readonly table (global '${name}')`);
    slot.value = value;
  }

  private evalList(exprs: readonly LuaExpr[], scope: LuaScope): LuaValue[] {
    const values: LuaValue[] = [];
    exprs.forEach((expr, i) => {
      if (i === exprs.length - 1 && expr.kind === 'call') {
        for (const value of this.evalCall(expr, scope)) values.push(value);
      } else {
        values.push(this.eval(expr, scope));
      }
    });
    return values;
  }

  private evalCall(expr: Extract<LuaExpr, { kind: 'call' }>, scope: LuaScope): LuaValue[] {
    const callee = this.eval(expr.callee, scope);
    if (!(callee instanceof LuaFunction)) throw new LuaError(`attempt to call a ${luaType(callee)} value`);
    return callee.invoke(this.evalList(expr.args, scope));
  }

  private eval(expr: LuaExpr, scope: LuaScope): LuaValue {
    switch (expr.kind) {
      case 'nil':
        return null;
      case 'boolean':
      case 'number':
      case 'string':
        return expr.value;
      case 'name': {
        const slot = scope.find(expr.name);
        if (slot) return slot.value;
        const global = this.globals.get(expr.name);
        if (global === undefined) {
          throw new LuaError(`Script attempted to access nonexistent global variable '${expr.name}'`);
        }
        return global;
      }
      case 'index': {
        const table = this.eval(expr.target, scope);
        if (!(table instanceof LuaTable)) throw new LuaError(`attempt to index a ${luaType(table)} value`);
        return table.get(this.eval(expr.key, scope));
      }
      case 'call':
        return this.evalCall(expr, scope)[0] ?? null;
      case 'function':
        return this.closure(expr.params, expr.body, scope);
      case 'paren':
        return this.eval(expr.inner, scope);
      case 'table': {
        const table = new LuaTable();
        let position = 1;
        expr.fields.forEach((field, i) => {
          if (field.key) {
            table.set(this.eval(field.key, scope), this.eval(field.value, scope));
            return;
          }
          const value = field.value;
          const values =
            i === expr.fields.length - 1 && value.kind === 'call'
              ? this.evalCall(value, scope)
              : [this.eval(value, scope)];
          for (const item of values) {
            table.set(position, item);
            position += 1;
          }
        });
        return table;
      }
      case 'unary': {
        const operand = this.eval(expr.operand, scope);
        if (expr.op === 'not') return !isTruthy(operand);
        if (expr.op === '-') return -toArithmetic(operand);
        if (typeof operand === 'string') return operand.length;
        if (operand instanceof LuaTable) return operand.length();
        throw new LuaError(`attempt to get length of a ${luaType(operand)} value`);
      }
      case 'binary':
        return this.evalBinary(expr, scope);
    }
  }

  private evalBinary(expr: Extract<LuaExpr, { kind: 'binary' }>, scope: LuaScope): LuaValue {
    const left = this.eval(expr.left, scope);
    if (expr.op === 'and') return isTruthy(left) ? this.eval(expr.right, scope) : left;
    if (expr.op === 'or') return isTruthy(left) ? left : this.eval(expr.right, scope);
    const right = this.eval(expr.right, scope);
    switch (expr.op) {
      case '+':
        return toArithmetic(left) + toArithmetic(right);
      case '-':
        return toArithmetic(left) - toArithmetic(right);
      case '*':
        return toArithmetic(left) * toArithmetic(right);
      case '/':
        return toArithmetic(left) / toArithmetic(right);
      case '%': {
        const [a, b] = [toArithmetic(left), toArithmetic(right)];
        return a - Math.floor(a / b) * b;
      }
      case '^':
        return toArithmetic(left) ** toArithmetic(right);
      case '..':
        return toConcatenable(left) + toConcatenable(right);
      case '==':
        return left === right;
      case '~=':
        return left !== right;
      case '<':
        return luaLess(left, right, false);
      case '<=':
        return luaLess(left, right, true);
      case '>':
        return luaLess(right, left, false);
      case '>=':
        return luaLess(right, left, true);
      default:
        throw new LuaError(`unsupported operator '${expr.op}'`);
    }
  }

  private closure(params: readonly string[], body: LuaBlock, scope: LuaScope): LuaFunction {
    return new LuaFunction((args) => {
      const frame = new LuaScope(scope);
      params.forEach((param, i) => frame.declare(param, args[i] ?? null));
      const done = this.execBlock(body, frame);
      return done?.type === 'return' ? done.values : [];
    });
  }
}

function luaGlobals(
  redisCall: (args: readonly LuaValue[], protectedCall: boolean) => LuaValue,
): Map<string, LuaValue> {
  const fn = (impl: (args: LuaValue[]) => LuaValue[]): LuaFunction => new LuaFunction(impl);
  const library = (members: Record<string, (args: LuaValue[]) => LuaValue[]>): LuaTable => {
    const table = new LuaTable();
    for (const [member, impl] of Object.entries(members)) table.set(member, fn(impl));
    return table;
  };
  const num = (value: LuaValue | undefined): number => toArithmetic(value ?? null);

  return new Map<string, LuaValue>([
    ['tonumber', fn(([value]) => [luaToNumber(value ?? null)])],
    ['tostring', fn(([value]) => [luaToString(value ?? null)])],
    ['type', fn(([value]) => [luaType(value ?? null)])],
    [
      'unpack',
      fn(([list, from, to]) => {
        if (!(list instanceof LuaTable)) throw new LuaError("bad argument #1 to 'unpack' (table expected)");
        const first = from === undefined || from === null ? 1 : num(from);
        const last = to === undefined || to === null ? list.length() : num(to);
        if (last - first + 1 > LUA_MAX_C_STACK) throw new LuaError('too many results to unpack');
        const values: LuaValue[] = [];
        for (let i = first; i <= last; i += 1) values.push(list.get(i));
        return values;
      }),
    ],
    [
      'math',
      library({
        floor: ([v]) => [Math.floor(num(v))],
        ceil: ([v]) => [Math.ceil(num(v))],
        abs: ([v]) => [Math.abs(num(v))],
        exp: ([v]) => [Math.exp(num(v))],
        min: (values) => [Math.min(...values.map(num))],
        max: (values) => [Math.max(...values.map(num))],
      }),
    ],
    ['string', library({ format: (values) => [luaFormat(values)] })],
    [
      'redis',
      library({
        call: (values) => [redisCall(values, false)],
        pcall: (values) => [redisCall(values, true)],
      }),
    ],
  ]);
}

function luaArray(values: readonly string[]): LuaTable {
  const table = new LuaTable();
  values.forEach((value, i) => table.set(i + 1, value));
  return table;
}

function isTruthy(value: LuaValue): boolean {
  return value !== null && value !== false;
}

function luaType(value: LuaValue): string {
  if (value === null) return 'nil';
  if (value instanceof LuaTable) return 'table';
  if (value instanceof LuaFunction) return 'function';
  return typeof value;
}

function luaToNumber(value: LuaValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text, 16);
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text) ? Number(text) : null;
}

function luaToString(value: LuaValue): string {
  if (value === null) return 'nil';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return formatLuaNumber(value);
  if (typeof value === 'string') return value;
  return value instanceof LuaTable ? 'table: 0x0' : 'function: 0x0';
}

function toArithmetic(value: LuaValue): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? luaToNumber(value) : null;
  if (n === null) throw new LuaError(`attempt to perform arithmetic on a ${luaType(value)} value`);
  return n;
}

function toConcatenable(value: LuaValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatLuaNumber(value);
  throw new LuaError(`attempt to concatenate a ${luaType(value)} value`);
}

function luaLess(a: LuaValue, b: LuaValue, orEqual: boolean): boolean {
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
    return orEqual ? a <= b : a < b;
  }
  throw new LuaError(`attempt to compare ${luaType(a)} with ${luaType(b)}`);
}

/** Lua 5.1's LUA_NUMBER_FMT, "%.14g" — what tostring() and `..` print. */
function formatLuaNumber(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  if (n === 0) return '0';
  const [mantissa, exponentText] = n.toExponential(13).split('e');
  const exponent = Number(exponentText);
  const strip = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);
  if (exponent < -4 || exponent >= 14) {
    return `${strip(mantissa)}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return strip(n.toFixed(13 - exponent));
}

function luaFormat(args: readonly LuaValue[]): string {
  const [format, ...rest] = args;
  if (typeof format !== 'string') throw new LuaError("bad argument #1 to 'format' (string expected)");
  let next = 0;
  return format.replace(
    /%([-0]?)(\d*)(?:\.(\d+))?([dfsgi%])/g,
    (_match: string, flag: string, width: string, precision: string | undefined, conversion: string) => {
      if (conversion === '%') return '%';
      const value = rest[next] ?? null;
      next += 1;
      let out: string;
      if (conversion === 'd' || conversion === 'i') out = String(Math.trunc(toArithmetic(value)));
      else if (conversion === 'f') out = toArithmetic(value).toFixed(precision === undefined ? 6 : Number(precision));
      else if (conversion === 'g') out = formatLuaNumber(toArithmetic(value));
      else out = luaToString(value);
      if (!width) return out;
      return flag === '-' ? out.padEnd(Number(width)) : out.padStart(Number(width), flag === '0' ? '0' : ' ');
    },
  );
}

function replyToLua(reply: RedisReply): LuaValue {
  if (reply === null) return false;
  if (typeof reply === 'number' || typeof reply === 'string') return reply;
  const table = new LuaTable();
  if (Array.isArray(reply)) reply.forEach((item, i) => table.set(i + 1, replyToLua(item)));
  else table.set('ok', reply.status);
  return table;
}

function luaToReply(value: LuaValue): RedisReply {
  if (value === null || value === false) return null;
  if (value === true) return 1;
  // Redis casts a Lua number to a C long long: fractions are truncated.
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') return value;
  if (value instanceof LuaFunction) return null;
  const err = value.get('err');
  if (typeof err === 'string') throw new Error(err);
  const ok = value.get('ok');
  if (typeof ok === 'string') return { status: ok };
  const items: RedisReply[] = [];
  for (let i = 1; value.get(i) !== null; i += 1) items.push(luaToReply(value.get(i)));
  return items;
}
