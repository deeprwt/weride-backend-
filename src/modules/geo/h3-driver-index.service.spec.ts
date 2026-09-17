import { createHash } from 'node:crypto';
import { cellToLatLng, gridDiskDistances, gridDistance, latLngToCell } from 'h3-js';
import { _resetEnvCache } from '../../config/env';
import type { RedisService } from '../../common/redis/redis.module';
import {
  H3_DISPATCH_RESOLUTION,
  H3DriverIndexService,
  type IndexedDriverStatus,
  type PingIndexOutcome,
} from './h3-driver-index.service';

/**
 * The live driver index, tested on the two promises dispatch is built on.
 *
 * **One driver, one cell.** A driver in two cells is offered two rides from
 * two neighbourhoods; a driver in none is online, paying for fuel, and never
 * offered anything. Every write that can move a driver — a ping, a stale
 * packet, a status change, a Postgres read racing a status change, a removal,
 * a reconcile, an expiry — is followed by a check that the driver's hash and
 * the cell sets agree exactly.
 *
 * **Nearest first, and only the right drivers.** A search that returns a far
 * driver ahead of a near one sends the rider the longer wait; one that returns
 * a stale or busy driver sends an offer nobody can take. The geometry cases
 * are built from real H3 cells around Toronto City Hall, and each fixture
 * asserts its own preconditions (which cell, which ring, which is closer), so
 * a fixture that stopped meaning what it says fails loudly instead of passing
 * vacuously.
 *
 * Redis is an in-memory fake that RUNS the service's Lua — see the block at the
 * bottom of this file for why a stub would prove nothing here.
 */

interface Point {
  lat: number;
  lng: number;
}

const KEY_PREFIX = 'uride:geo:idx:';
const STALE_SECONDS = 60;
const HEARTBEAT_SECONDS = 120;
/** entryTtlMs exactly as the constructor derives it. */
const ENTRY_TTL_MS = Math.max(HEARTBEAT_SECONDS, STALE_SECONDS * 2) * 1000;
const FRESH_MS = STALE_SECONDS * 1000;

const T0 = Date.UTC(2026, 8, 13, 14, 0, 0);
const CITY_HALL: Point = { lat: 43.6532, lng: -79.3832 };

const DRIVER_A = 'a0000000-0000-4000-8000-00000000000a';
const DRIVER_B = 'b0000000-0000-4000-8000-00000000000b';
const DRIVER_C = 'c0000000-0000-4000-8000-00000000000c';
const DRIVER_D = 'd0000000-0000-4000-8000-00000000000d';
const DRIVER_E = 'e0000000-0000-4000-8000-00000000000e';
const RIDE_ID = '33333333-3333-4333-8333-333333333333';

describe('H3DriverIndexService', () => {
  const clock = { now: T0 };
  let server: FakeRedisServer;
  let index: H3DriverIndexService;

  beforeAll(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://uride:uride@localhost:5432/uride',
      DIRECT_URL: 'postgresql://uride:uride@localhost:5432/uride',
      REDIS_URL: 'redis://localhost:6379',
      JWT_LOCAL_SECRET: 'a-test-only-secret-of-at-least-32-characters',
      DRIVER_LOCATION_STALE_SECONDS: String(STALE_SECONDS),
      DRIVER_ONLINE_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
      DRIVER_MAX_SEARCH_RADIUS_METERS: '25000',
    });
    _resetEnvCache();
  });

  beforeEach(() => {
    clock.now = T0;
    // One clock for the service (Date.now) and for Redis (TIME), as in
    // production where the index compares capture times against Redis' clock.
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    server = new FakeRedisServer(() => clock.now);
    index = new H3DriverIndexService({ client: new FakeRedisClient(server) } as unknown as RedisService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helpers bound to this test's server and index
  // -------------------------------------------------------------------------

  async function goOnline(
    driverId: string,
    at: Point,
    status: IndexedDriverStatus = 'online',
    recordedAtMs: number = clock.now,
  ): Promise<void> {
    await index.upsert({
      driverId,
      lat: at.lat,
      lng: at.lng,
      headingDegrees: null,
      speedMps: null,
      recordedAtMs,
      rideId: status === 'on_trip' ? RIDE_ID : null,
      status,
    });
  }

  async function ping(driverId: string, at: Point, recordedAtMs: number = clock.now): Promise<PingIndexOutcome> {
    const result = await index.recordPing({
      driverId,
      lat: at.lat,
      lng: at.lng,
      headingDegrees: 90,
      speedMps: 8,
      recordedAtMs,
    });
    return result.outcome;
  }

  /**
   * Cell sets holding this driver with a score the index still treats as live
   * (capture time within the entry TTL), as `status:cell`. A member older than
   * that is a leftover of an expired hash — invisible to every read, pruned by
   * the next insert into its set.
   */
  function liveMemberships(driverId: string): string[] {
    const cellPrefix = `${KEY_PREFIX}cell:`;
    return server
      .keysMatching(`${cellPrefix}*`)
      .filter((key) => {
        const score = server.zscore(key, driverId);
        return score !== null && score >= clock.now - ENTRY_TTL_MS;
      })
      .map((key) => key.slice(cellPrefix.length))
      .sort();
  }

  /** The invariant: the hash and the cell sets agree, exactly. */
  function expectConsistent(driverId: string): void {
    const hash = server.hashOf(`${KEY_PREFIX}drv:${driverId}`);
    const memberships = liveMemberships(driverId);
    if (hash === null) {
      expect({ driverId, memberships }).toEqual({ driverId, memberships: [] });
      return;
    }
    const lat = Number(hash.get('lat'));
    const lng = Number(hash.get('lng'));
    const cell = hash.get('cell');
    expect(cell).toBe(latLngToCell(lat, lng, H3_DISPATCH_RESOLUTION));
    expect({ driverId, memberships }).toEqual({ driverId, memberships: [`${hash.get('st')}:${cell}`] });
    expect(server.zscore(`${KEY_PREFIX}cell:${hash.get('st')}:${cell}`, driverId)).toBe(Number(hash.get('t')));
  }

  /** Stronger than expectConsistent: the driver is where and what the test says. */
  function expectPlaced(driverId: string, status: IndexedDriverStatus, at: Point): void {
    expectConsistent(driverId);
    expect(liveMemberships(driverId)).toEqual([`${status}:${cellOf(at)}`]);
    const hash = server.hashOf(`${KEY_PREFIX}drv:${driverId}`);
    expect(Number(hash?.get('lat'))).toBeCloseTo(at.lat, 9);
    expect(Number(hash?.get('lng'))).toBeCloseTo(at.lng, 9);
  }

  function expectNowhere(driverId: string): void {
    expect(server.hashOf(`${KEY_PREFIX}drv:${driverId}`)).toBeNull();
    expect(liveMemberships(driverId)).toEqual([]);
  }

  // -------------------------------------------------------------------------
  // One driver, one cell
  // -------------------------------------------------------------------------

  describe('a moving driver is in exactly one cell', () => {
    it('drives across town and is only ever in the cell it is standing in', async () => {
      // ~600 m steps east along Queen St: long enough to cross a res-8 cell
      // most steps, short enough that some steps stay inside one.
      const route = Array.from({ length: 12 }, (_, i) => offset(CITY_HALL, 0, i * 600));
      expect(new Set(route.map(cellOf)).size).toBeGreaterThanOrEqual(6);

      await goOnline(DRIVER_A, route[0]);
      expectPlaced(DRIVER_A, 'online', route[0]);

      for (const point of route.slice(1)) {
        clock.now += 4_000;
        expect(await ping(DRIVER_A, point)).toBe('applied');
        expectPlaced(DRIVER_A, 'online', point);
      }
    });

    it('keeps its one cell through a trip — on_trip while moving, back to online after', async () => {
      const start = offset(CITY_HALL, 0, 0);
      await goOnline(DRIVER_A, start);

      await index.setStatus(DRIVER_A, 'on_trip', RIDE_ID);
      expectPlaced(DRIVER_A, 'on_trip', start);

      let at = start;
      for (let i = 1; i <= 5; i += 1) {
        clock.now += 4_000;
        at = offset(start, i * 700, 0);
        expect(await ping(DRIVER_A, at)).toBe('applied');
        expectPlaced(DRIVER_A, 'on_trip', at);
      }
      expect((await index.get(DRIVER_A))?.rideId).toBe(RIDE_ID);

      await index.setStatus(DRIVER_A, 'online', null);
      expectPlaced(DRIVER_A, 'online', at);
      expect((await index.get(DRIVER_A))?.rideId).toBeNull();
    });

    it('a delayed packet from an old position neither moves the driver nor leaves a second membership', async () => {
      const oldCorner = offset(CITY_HALL, 0, 0);
      const newCorner = offset(CITY_HALL, 1_500, 1_500);
      expect(cellOf(oldCorner)).not.toBe(cellOf(newCorner));

      await goOnline(DRIVER_A, oldCorner, 'online', T0);
      clock.now = T0 + 8_000;
      expect(await ping(DRIVER_A, newCorner, T0 + 8_000)).toBe('applied');

      // The retried packet from 4 s earlier arrives last.
      expect(await ping(DRIVER_A, oldCorner, T0 + 4_000)).toBe('stale');
      expectPlaced(DRIVER_A, 'online', newCorner);

      // A caller who knows the status but holds an older fix: status applies,
      // position does not regress.
      await goOnline(DRIVER_A, oldCorner, 'on_trip', T0 + 2_000);
      expectPlaced(DRIVER_A, 'on_trip', newCorner);
    });

    it('a cold driver resolved from Postgres lands in exactly one cell; an offline answer leaves them in none', async () => {
      const home = offset(CITY_HALL, -800, 300);
      const cold = await index.recordPing(pingAt(DRIVER_B, home, clock.now));
      expect(cold.outcome).toBe('cold');
      expectNowhere(DRIVER_B);

      const placed = await index.recordPing(pingAt(DRIVER_B, home, clock.now), {
        status: 'online',
        rideId: null,
        readAtMs: cold.serverTimeMs,
      });
      expect(placed.outcome).toBe('applied');
      expectPlaced(DRIVER_B, 'online', home);

      // A later Postgres answer (read began after the last status write) that
      // says on_trip, arriving with a ping from a new cell.
      clock.now += 5_000;
      const pickup = offset(home, 1_200, 0);
      const onTrip = await index.recordPing(pingAt(DRIVER_B, pickup, clock.now), {
        status: 'on_trip',
        rideId: RIDE_ID,
        readAtMs: clock.now,
      });
      expect(onTrip.outcome).toBe('applied');
      expectPlaced(DRIVER_B, 'on_trip', pickup);

      clock.now += 5_000;
      const offline = await index.recordPing(pingAt(DRIVER_B, pickup, clock.now), {
        status: 'offline',
        rideId: null,
        readAtMs: clock.now,
      });
      expect(offline.outcome).toBe('offline');
      expectNowhere(DRIVER_B);

      // The offline marker keeps the next ping off Postgres — and out of the map.
      clock.now += 4_000;
      expect(await ping(DRIVER_B, pickup)).toBe('offline');
      expectNowhere(DRIVER_B);
    });

    it('a stale Postgres read cannot pull a driver who just went online back out of the map', async () => {
      const at = offset(CITY_HALL, 200, 200);
      // The read began 500 ms before the go-online was written to the index.
      const readAtMs = clock.now - 500;
      await goOnline(DRIVER_C, at);

      clock.now += 1_000;
      const result = await index.recordPing(pingAt(DRIVER_C, at, clock.now), {
        status: 'offline',
        rideId: null,
        readAtMs,
      });
      expect(result.outcome).toBe('applied');
      expectPlaced(DRIVER_C, 'online', at);

      expect(await index.reconcile([{ driverId: DRIVER_C, status: 'offline', rideId: null }], readAtMs)).toBe(0);
      expectPlaced(DRIVER_C, 'online', at);
    });

    it('reconcile corrects a status that drifted without duplicating the driver', async () => {
      const at = offset(CITY_HALL, -300, 900);
      await goOnline(DRIVER_D, at);

      clock.now += 2_000;
      const readAtMs = await index.serverTimeMs();
      expect(await index.reconcile([{ driverId: DRIVER_D, status: 'on_trip', rideId: RIDE_ID }], readAtMs)).toBe(1);
      expectPlaced(DRIVER_D, 'on_trip', at);

      clock.now += 2_000;
      expect(
        await index.reconcile([{ driverId: DRIVER_D, status: 'offline', rideId: null }], await index.serverTimeMs()),
      ).toBe(1);
      expectNowhere(DRIVER_D);
    });

    it('a driver whose entry expired and who came back elsewhere is found once and counted once', async () => {
      const before = offset(CITY_HALL, 0, 0);
      const after = offset(CITY_HALL, 0, 1_800);
      expect(cellOf(before)).not.toBe(cellOf(after));
      await goOnline(DRIVER_E, before);

      // Phone dead for longer than the entry lives.
      clock.now += ENTRY_TTL_MS + 1_000;
      const cold = await index.recordPing(pingAt(DRIVER_E, after, clock.now));
      expect(cold.outcome).toBe('cold');
      await index.recordPing(pingAt(DRIVER_E, after, clock.now), {
        status: 'online',
        rideId: null,
        readAtMs: cold.serverTimeMs,
      });
      expectPlaced(DRIVER_E, 'online', after);

      // The old cell set still physically holds the member — nothing has
      // inserted into it since — which is exactly why reads must not see it.
      expect(server.zscore(`${KEY_PREFIX}cell:online:${cellOf(before)}`, DRIVER_E)).toBe(T0);

      const found = await index.searchNearby({ ...before, maxRings: 6, limit: 10, maxAgeMs: FRESH_MS });
      expect(found.map((d) => [d.driverId, d.cell])).toEqual([[DRIVER_E, cellOf(after)]]);

      const counts = await index.countOnlineByCell([cellOf(before), cellOf(after)], H3_DISPATCH_RESOLUTION);
      expect(counts.get(cellOf(before))).toBe(0);
      expect(counts.get(cellOf(after))).toBe(1);
    });

    it('holds across a long random interleaving of every write the platform makes', async () => {
      // Deterministic, so a failure reproduces. The mix is weighted towards
      // what production does most (fresh pings) but every path runs hundreds
      // of times: stale packets, cold resolutions with each Postgres answer,
      // status writes, upserts with old fixes, removals, reconciles with reads
      // that began before or after the last status write, and silences long
      // enough to expire an entry.
      const random = seededRandom(0x5eed);
      const drivers = Array.from({ length: 8 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const lastCapture = new Map<string, number>();
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const somewhere = (): Point => offset(CITY_HALL, (random() - 0.5) * 6_000, (random() - 0.5) * 6_000);

      for (let step = 0; step < 1_500; step += 1) {
        const driverId = pick(drivers);
        const roll = random();

        if (roll < 0.4) {
          const capturedAt = clock.now - Math.floor(random() * 1_500);
          const first = await index.recordPing(pingAt(driverId, somewhere(), capturedAt));
          if (first.outcome === 'cold') {
            const status = pick(['online', 'online', 'on_trip', 'offline'] as const);
            await index.recordPing(pingAt(driverId, somewhere(), capturedAt), {
              status,
              rideId: status === 'on_trip' ? RIDE_ID : null,
              readAtMs: first.serverTimeMs,
            });
          }
          lastCapture.set(driverId, Math.max(lastCapture.get(driverId) ?? 0, capturedAt));
        } else if (roll < 0.5) {
          const behind = (lastCapture.get(driverId) ?? clock.now) - 1_000 - Math.floor(random() * 20_000);
          await index.recordPing(pingAt(driverId, somewhere(), behind));
        } else if (roll < 0.6) {
          const status = pick(['online', 'on_trip'] as const);
          await index.setStatus(driverId, status, status === 'on_trip' ? RIDE_ID : null);
        } else if (roll < 0.7) {
          await goOnline(driverId, somewhere(), pick(['online', 'on_trip'] as const), clock.now - Math.floor(random() * 30_000));
        } else if (roll < 0.75) {
          await index.remove(driverId);
        } else if (roll < 0.87) {
          const status = pick(['online', 'on_trip', 'offline'] as const);
          const readAtMs = (await index.serverTimeMs()) - Math.floor(random() * 3_000);
          await index.reconcile([{ driverId, status, rideId: status === 'on_trip' ? RIDE_ID : null }], readAtMs);
        } else if (roll < 0.99) {
          clock.now += Math.floor(random() * 4_000);
        } else {
          clock.now += ENTRY_TTL_MS + Math.floor(random() * 10_000);
        }

        expectConsistent(driverId);
        if (step % 50 === 0) drivers.forEach(expectConsistent);
      }
      drivers.forEach(expectConsistent);
    });
  });

  // -------------------------------------------------------------------------
  // searchNearby
  // -------------------------------------------------------------------------

  describe('searchNearby', () => {
    const originCell = cellOf(CITY_HALL);
    const origin = centreOf(originCell);

    it('returns drivers nearest first, with their true distance and the ring they were found in', async () => {
      const placements: [string, Point][] = [
        [DRIVER_A, offset(origin, 0, 120)],
        [DRIVER_B, offset(origin, 450, 0)],
        [DRIVER_C, offset(origin, -560, -560)],
        [DRIVER_D, offset(origin, 0, -1_500)],
        [DRIVER_E, offset(origin, -2_600, 0)],
      ];
      // Written far-first, so insertion order cannot be what sorts them.
      for (const [id, at] of [...placements].reverse()) await goOnline(id, at);

      const found = await index.searchNearby({ ...origin, maxRings: 6, limit: 5, maxAgeMs: FRESH_MS, status: 'online' });

      expect(found.map((d) => d.driverId)).toEqual([DRIVER_A, DRIVER_B, DRIVER_C, DRIVER_D, DRIVER_E]);
      found.forEach((driver, i) => {
        const at = placements[i][1];
        expect(driver.distanceMeters).toBe(Math.round(metresBetween(origin, at)));
        expect(driver.ring).toBe(gridDistance(originCell, cellOf(at)));
        if (i > 0) expect(driver.distanceMeters).toBeGreaterThan(found[i - 1].distanceMeters);
      });

      const nearestThree = await index.searchNearby({ ...origin, maxRings: 6, limit: 3, maxAgeMs: FRESH_MS });
      expect(nearestThree.map((d) => d.driverId)).toEqual([DRIVER_A, DRIVER_B, DRIVER_C]);
    });

    it('never returns a driver whose last position is older than the freshness window', async () => {
      const kerbside = offset(origin, 40, 0);
      const acrossTown = offset(origin, 0, 700);
      // 90 s old: still held by the index (TTL 120 s), too old to dispatch.
      await goOnline(DRIVER_A, kerbside, 'online', clock.now - 90_000);
      await goOnline(DRIVER_B, acrossTown);

      server.commandLog.length = 0;
      const fresh = await index.searchNearby({ ...origin, maxRings: 3, limit: 5, maxAgeMs: FRESH_MS });
      expect(fresh.map((d) => d.driverId)).toEqual([DRIVER_B]);
      // Stale members are filtered by Redis itself: skipping them costs no hash read.
      expect(server.commandLog.filter((name) => name === 'HMGET')).toHaveLength(1);

      // The same search with a wider window sees both, nearest first — so it
      // was the age filter, not a missing entry, that hid the kerbside driver.
      const lenient = await index.searchNearby({ ...origin, maxRings: 3, limit: 5, maxAgeMs: ENTRY_TTL_MS });
      expect(lenient.map((d) => d.driverId)).toEqual([DRIVER_A, DRIVER_B]);

      clock.now += FRESH_MS + 1;
      expect(await index.searchNearby({ ...origin, maxRings: 3, limit: 5, maxAgeMs: FRESH_MS })).toEqual([]);
    });

    it('filters on status, and trusts the driver hash over a leftover set member', async () => {
      const idle = offset(origin, 300, 0);
      const busy = offset(origin, 50, 0);
      const gone = offset(origin, 20, 0);
      await goOnline(DRIVER_A, idle, 'online');
      await goOnline(DRIVER_B, busy, 'on_trip');
      await goOnline(DRIVER_C, gone, 'online');
      await index.remove(DRIVER_C);

      const search = (status?: IndexedDriverStatus): Promise<string[]> =>
        index
          .searchNearby({ ...origin, maxRings: 3, limit: 10, maxAgeMs: FRESH_MS, status })
          .then((found) => found.map((d) => d.driverId));

      expect(await search('online')).toEqual([DRIVER_A]);
      expect(await search('on_trip')).toEqual([DRIVER_B]);
      expect(await search()).toEqual([DRIVER_B, DRIVER_A]);

      // A member a status transition failed to clean up: the busy driver is
      // still listed in the online set of their cell, freshly scored.
      server.command(['ZADD', `${KEY_PREFIX}cell:online:${cellOf(busy)}`, String(clock.now), DRIVER_B]);
      expect(await search('online')).toEqual([DRIVER_A]);
      const all = await index.searchNearby({ ...origin, maxRings: 3, limit: 10, maxAgeMs: FRESH_MS });
      expect(all.map((d) => [d.driverId, d.status])).toEqual([
        [DRIVER_B, 'on_trip'],
        [DRIVER_A, 'online'],
      ]);

      // A member left behind in a NEARER cell than the driver really is in:
      // the driver is reported once, from the cell their hash names, at the
      // ring that cell is in.
      const twoRingsOut = along(origin, centreOf(gridDiskDistances(originCell, 6)[1][3]), 2);
      expect(gridDistance(originCell, cellOf(twoRingsOut))).toBe(2);
      await goOnline(DRIVER_D, twoRingsOut);
      server.command(['ZADD', `${KEY_PREFIX}cell:online:${originCell}`, String(clock.now), DRIVER_D]);
      const withLeftover = await index.searchNearby({ ...origin, maxRings: 3, limit: 10, maxAgeMs: FRESH_MS, status: 'online' });
      expect(withLeftover.map((d) => [d.driverId, d.cell, d.ring])).toEqual([
        [DRIVER_A, cellOf(idle), 0],
        [DRIVER_D, cellOf(twoRingsOut), 2],
      ]);
    });

    it('reads the whole ring before deciding — a nearer driver in a later cell of the ring still wins', async () => {
      // The ring's cells in the order the service reads them.
      const ringOne = gridDiskDistances(originCell, 6)[1];
      const firstCell = ringOne[0];
      const lastCell = ringOne[ringOne.length - 1];
      const farSideOfFirst = along(origin, centreOf(firstCell), 1.35);
      const nearSideOfLast = along(origin, centreOf(lastCell), 0.62);
      expect(cellOf(farSideOfFirst)).toBe(firstCell);
      expect(cellOf(nearSideOfLast)).toBe(lastCell);
      expect(metresBetween(origin, nearSideOfLast)).toBeLessThan(metresBetween(origin, farSideOfFirst) - 500);

      await goOnline(DRIVER_A, farSideOfFirst);
      await goOnline(DRIVER_B, nearSideOfLast);

      const found = await index.searchNearby({ ...origin, maxRings: 6, limit: 1, maxAgeMs: FRESH_MS, status: 'online' });
      expect(found.map((d) => [d.driverId, d.ring])).toEqual([[DRIVER_B, 1]]);
    });

    it('keeps walking past a ring that has enough drivers when the next ring could hold a closer one', async () => {
      // Pickup just inside the edge its cell shares with neighbour N.
      const neighbour = gridDiskDistances(originCell, 6)[1][0];
      const pickup = along(origin, centreOf(neighbour), 0.45);
      const farCornerOfOwnCell = along(origin, centreOf(neighbour), -0.45);
      const justAcrossTheEdge = along(origin, centreOf(neighbour), 0.55);
      expect(cellOf(pickup)).toBe(originCell);
      expect(cellOf(farCornerOfOwnCell)).toBe(originCell);
      expect(cellOf(justAcrossTheEdge)).toBe(neighbour);
      expect(metresBetween(pickup, justAcrossTheEdge)).toBeLessThan(metresBetween(pickup, farCornerOfOwnCell) / 4);

      await goOnline(DRIVER_A, farCornerOfOwnCell);
      await goOnline(DRIVER_B, justAcrossTheEdge);

      const found = await index.searchNearby({ ...pickup, maxRings: 6, limit: 1, maxAgeMs: FRESH_MS, status: 'online' });
      expect(found.map((d) => [d.driverId, d.ring])).toEqual([[DRIVER_B, 1]]);
    });

    it('the same holds between rings 1 and 2 — and the bound must allow for how far a cell reaches past its centre', async () => {
      const rings = gridDiskDistances(originCell, 6);
      const neighbour = rings[1][0];
      const pickup = along(origin, centreOf(neighbour), 0.45);
      const insideOppositeNeighbour = along(origin, centreOf(neighbour), -0.85);
      const justIntoRingTwo = along(origin, centreOf(neighbour), 1.58);
      expect(cellOf(pickup)).toBe(originCell);
      expect(gridDistance(originCell, cellOf(insideOppositeNeighbour))).toBe(1);
      expect(gridDistance(originCell, cellOf(justIntoRingTwo))).toBe(2);
      const ringOneDriverMeters = metresBetween(pickup, insideOppositeNeighbour);
      expect(metresBetween(pickup, justIntoRingTwo)).toBeLessThan(ringOneDriverMeters - 100);
      // The trap: every ring-2 cell CENTRE is further away than the ring-1
      // driver, so a bound on centres alone would stop and return them. Only a
      // bound that subtracts each cell's reach past its centre keeps looking.
      const nearestRingTwoCentre = Math.min(...rings[2].map((cell) => metresBetween(pickup, centreOf(cell))));
      expect(ringOneDriverMeters).toBeLessThan(nearestRingTwoCentre);

      await goOnline(DRIVER_A, insideOppositeNeighbour);
      await goOnline(DRIVER_B, justIntoRingTwo);

      const found = await index.searchNearby({ ...pickup, maxRings: 6, limit: 1, maxAgeMs: FRESH_MS, status: 'online' });
      expect(found.map((d) => [d.driverId, d.ring])).toEqual([[DRIVER_B, 2]]);
    });

    it('stops once the next ring provably cannot beat what it holds — a driver at the kerb costs one cell read', async () => {
      await goOnline(DRIVER_A, offset(origin, 10, 0));
      // Plenty of drivers further out that a radius ladder would have scanned.
      for (let i = 0; i < 12; i += 1) {
        await goOnline(`f1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, offset(origin, 2_000, i * 300));
      }

      server.commandLog.length = 0;
      const found = await index.searchNearby({ ...origin, maxRings: 6, limit: 1, maxAgeMs: FRESH_MS, status: 'online' });
      expect(found.map((d) => d.driverId)).toEqual([DRIVER_A]);
      expect(server.commandLog.filter((name) => name === 'ZRANGEBYSCORE')).toHaveLength(1);
    });

    it('does not look past maxRings', async () => {
      const threeRingsOut = along(origin, centreOf(gridDiskDistances(originCell, 6)[1][2]), 3);
      expect(gridDistance(originCell, cellOf(threeRingsOut))).toBe(3);
      await goOnline(DRIVER_A, threeRingsOut);

      expect(await index.searchNearby({ ...origin, maxRings: 2, limit: 1, maxAgeMs: FRESH_MS })).toEqual([]);
      const found = await index.searchNearby({ ...origin, maxRings: 3, limit: 1, maxAgeMs: FRESH_MS });
      expect(found.map((d) => [d.driverId, d.ring])).toEqual([[DRIVER_A, 3]]);
    });
  });
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function pingAt(
  driverId: string,
  at: Point,
  recordedAtMs: number,
): { driverId: string; lat: number; lng: number; headingDegrees: number | null; speedMps: number | null; recordedAtMs: number } {
  return { driverId, lat: at.lat, lng: at.lng, headingDegrees: null, speedMps: null, recordedAtMs };
}

function cellOf(at: Point): string {
  return latLngToCell(at.lat, at.lng, H3_DISPATCH_RESOLUTION);
}

function centreOf(cell: string): Point {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

/** A point this many metres north and east of `from`. Flat-earth; exact enough over a few km. */
function offset(from: Point, northMeters: number, eastMeters: number): Point {
  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLng = 111_320 * Math.cos((from.lat * Math.PI) / 180);
  return { lat: from.lat + northMeters / metresPerDegreeLat, lng: from.lng + eastMeters / metresPerDegreeLng };
}

/** `from + f × (to − from)` in degrees; f > 1 continues past `to`, f < 0 goes the other way. */
function along(from: Point, to: Point, f: number): Point {
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

/** The service's haversine (mean Earth radius 6,371,008.8 m), so expected distances match to the metre. */
function metresBetween(a: Point, b: Point): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
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
