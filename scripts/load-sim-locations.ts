/* eslint-disable no-console */
/**
 * load-sim-locations — how much of the location firehose still reaches Postgres?
 *
 *   ┌──────────────────────────── LOCAL DOCKER DATABASE ONLY ────────────────────────────┐
 *   │ This script CREATES throwaway driver accounts in the database it is given, drives  │
 *   │ them at a running API, counts what lands in driver_locations, and then DELETES     │
 *   │ everything it created. It is for the docker stack in infra/docker-compose.yml      │
 *   │ (Postgres on :55432, Redis on :56379) and nothing else.                             │
 *   │                                                                                    │
 *   │ NEVER run it against Supabase. It refuses to start unless DATABASE_URL, REDIS_URL  │
 *   │ and the API are all on this machine, and it aborts before sending load if the API  │
 *   │ turns out to be using a different database than the one it seeded. Those guards   │
 *   │ are a seatbelt, not a licence: a hosted pooler is precisely what this would load,  │
 *   │ and the accounts it writes are real rows.                                          │
 *   └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * THE HEADLINE is the ratio of pings accepted to rows written. Before the H3 index
 * and the batched trail, every ping was a Postgres transaction that inserted a
 * driver_locations row and upserted driver_availability: one row per ping, 1 : 1,
 * forever. Now a ping is a Redis write; LocationFlushWorker writes the trail in bulk,
 * keeping every point recorded on a ride (fare evidence) and one idle point per driver
 * per GEO_IDLE_TRAIL_SAMPLE_SECONDS. With the defaults (30 s window, the app's 4 s
 * cadence) an idle fleet should land near 7.5 : 1 and on-trip drivers at exactly 1 : 1.
 *
 * Also reported:
 *   - accepted pings/sec and p50 / p95 / p99 latency of POST /v1/drivers/me/location;
 *   - Postgres transactions per accepted ping, from pg_stat_database, corrected for the
 *     background traffic measured in a quiet baseline window first. This is the number
 *     that shows whether the request path itself still talks to Postgres.
 *
 * PREREQUISITES
 *   1. docker compose -f infra/docker-compose.yml up -d
 *   2. backend/.env DATABASE_URL and REDIS_URL pointing at that stack, migrations applied.
 *   3. The API running against the SAME database and Redis, with AUTH_PROVIDER=local, and
 *      with the global per-IP limiter raised for the run:
 *          RATE_LIMIT_MAX=1000000 npm run dev
 *      Every simulated driver shares this machine's IP, so the default 120 requests/min
 *      would reject almost the whole simulation. The script detects that and stops.
 *
 * USAGE (from backend/, in Git Bash)
 *   npx ts-node --transpile-only --skipProject \
 *     --compilerOptions '{"module":"commonjs","target":"es2022","esModuleInterop":true}' \
 *     scripts/load-sim-locations.ts [drivers] [options]
 *
 *   --skipProject because ts-node cannot follow tsconfig.json's `extends` through the
 *   symlinked @uride/config package (`-P tsconfig.json` fails with TS5083 — seed:admin
 *   has the same problem). `npx tsc --noEmit` still type-checks this file.
 *
 *   drivers                 simulated drivers (default 500)
 *   --duration <seconds>    how long to ping (default 60)
 *   --interval <seconds>    seconds between one driver's pings (default 4, the app's cadence)
 *   --on-trip <fraction>    share of drivers simulated as on a trip (default 0.1)
 *   --baseline <seconds>    quiet window for the Postgres transaction baseline (default 15;
 *                           0 skips the transaction metric)
 *   --drain-timeout <s>     how long to wait for the trail queue to empty (default 120)
 *   --api <url>             API base URL (default http://localhost:$PORT)
 *   --cleanup               delete leftovers of earlier runs (e.g. after a crash) and exit
 *
 * WHAT IT TOUCHES, AND UNDOES
 *   Postgres: users (email @load-sim.uride.invalid — RFC 2606, never a real mailbox),
 *   driver_profiles (kyc_status 'not_started', so dispatch's eligibility check refuses
 *   them), driver_availability (seeded online/on_trip — on-trip rows carry a random ride
 *   id that matches no ride), and the driver_locations rows the API writes for them.
 *   Redis: their live-index entries, offline markers, sampling/refresh/rate-limit keys.
 *   The fleet is parked around Sudbury, ON, so it cannot show up as supply in a dev
 *   rider's Toronto surge zone while it runs. Everything is deleted at the end, on
 *   Ctrl+C, and on failure; `--cleanup` removes anything a crashed run left behind.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { SignJWT } from 'jose';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RFC 2606 reserves .invalid: these addresses can never belong to a person. */
const EMAIL_DOMAIN = 'load-sim.uride.invalid';

/** Redis keys this script reads or cleans. Mirrors geo.service.ts / location-flush.worker.ts. */
const TRAIL_QUEUE_KEY = 'uride:geo:trail:queue';
const TRAIL_INFLIGHT_KEY = 'uride:geo:trail:inflight';
const INDEX_PREFIX = 'uride:geo:idx:';

/** Downtown Sudbury, ON — far from anything a dev rider in Toronto will request. */
const FLEET_CENTRE = { lat: 46.4917, lng: -80.993 };
const FLEET_SPREAD_DEGREES = 0.05;

/** Hosts that are this machine. Anything else is refused. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/** The per-driver route limit is 120/min; stay clear of it. */
const MIN_INTERVAL_SECONDS = 0.6;

/** If more than this share of the first seconds' pings are 429s, the global IP limiter is in the way. */
const LIMITER_ABORT_SHARE = 0.05;
const LIMITER_CHECK_AFTER_MS = 5_000;

const INSERT_CHUNK = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Options {
  drivers: number;
  durationSeconds: number;
  intervalSeconds: number;
  onTripShare: number;
  baselineSeconds: number;
  drainTimeoutSeconds: number;
  apiBaseUrl: string;
  cleanupOnly: boolean;
}

interface SimDriver {
  id: string;
  email: string;
  token: string;
  onTrip: boolean;
  lat: number;
  lng: number;
  headingDegrees: number;
}

interface RunStats {
  sent: number;
  accepted: number;
  acceptedOnTrip: number;
  acceptedIdle: number;
  networkErrors: number;
  byStatus: Map<number, number>;
  /** Accepted requests only. */
  latenciesMs: number[];
  startedAtMs: number;
  endedAtMs: number;
}

interface ResolvedEnv {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  flushTickMs: number;
  idleSampleSeconds: number;
}

class Refusal extends Error {}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Every guard runs before a single connection is opened.
  const env = resolveEnvironment(options);

  const prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } } });
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();

  try {
    await assertLocalSchema(prisma);
    if (options.cleanupOnly) {
      const ids = await leftoverDriverIds(prisma);
      await cleanup(prisma, redis, ids);
      return;
    }
    await simulate(options, env, prisma, redis);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

async function simulate(options: Options, env: ResolvedEnv, prisma: PrismaClient, redis: Redis): Promise<void> {
  const fleet = await buildFleet(options, env);
  let seeded = false;
  let interrupted = false;

  const onInterrupt = (): void => {
    if (interrupted) {
      console.log('\nForced exit. Run with --cleanup to remove what this run left behind.');
      process.exit(130);
    }
    interrupted = true;
    console.log('\nInterrupted — stopping pings, waiting for the trail to drain, then cleaning up (Ctrl+C again to force)…');
  };
  process.on('SIGINT', onInterrupt);

  try {
    console.log(`Seeding ${fleet.length} simulated drivers (${fleet.filter((d) => d.onTrip).length} on a trip)…`);
    await seed(prisma, fleet);
    seeded = true;

    await preflight(options, redis, fleet);

    const baselinePerSecond = options.baselineSeconds > 0 ? await measureBaseline(prisma, options.baselineSeconds) : null;
    const xactsBefore = baselinePerSecond === null ? null : await postgresTransactions(prisma);

    console.log(
      `Pinging: ${fleet.length} drivers every ${options.intervalSeconds}s for ${options.durationSeconds}s ` +
        `(offered load ${(fleet.length / options.intervalSeconds).toFixed(0)} pings/s) → ${options.apiBaseUrl}`,
    );
    const stats = await run(options, fleet, () => interrupted);

    console.log('Waiting for the flush worker to drain the trail queue…');
    const drained = await waitForDrain(redis, env.flushTickMs, options.drainTimeoutSeconds);
    // Interrupted: the numbers describe a partial run, so skip straight to cleanup.
    if (interrupted) return;

    // Idle backends report their transaction counts to pg_stat on a ~10 s
    // cadence; waiting it out keeps the tail of the run in the measurement.
    if (xactsBefore !== null) await sleep(11_000);
    const xactsAfter = xactsBefore === null ? null : await postgresTransactions(prisma);
    const measuredWindowSeconds = (Date.now() - stats.startedAtMs) / 1000;

    const rows = await countTrailRows(prisma, fleet.map((d) => d.id));
    report({
      options,
      env,
      fleet,
      stats,
      rows,
      drained,
      transactions:
        xactsBefore === null || xactsAfter === null || baselinePerSecond === null
          ? null
          : {
              total: xactsAfter - xactsBefore,
              background: baselinePerSecond * measuredWindowSeconds,
            },
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    if (seeded) await cleanup(prisma, redis, fleet.map((d) => d.id));
  }
}

// ---------------------------------------------------------------------------
// Arguments and safety guards
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    drivers: 500,
    durationSeconds: 60,
    intervalSeconds: 4,
    onTripShare: 0.1,
    baselineSeconds: 15,
    drainTimeoutSeconds: 120,
    apiBaseUrl: '',
    cleanupOnly: false,
  };
  const number = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value) || value < min || value > max) {
      fail(`${flag} must be a number between ${min} and ${max} (got ${raw ?? 'nothing'}).`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    switch (arg) {
      case '--duration':
        options.durationSeconds = number(arg, next, 5, 3_600);
        i += 1;
        break;
      case '--interval':
        options.intervalSeconds = number(arg, next, MIN_INTERVAL_SECONDS, 60);
        i += 1;
        break;
      case '--on-trip':
        options.onTripShare = number(arg, next, 0, 1);
        i += 1;
        break;
      case '--baseline':
        options.baselineSeconds = number(arg, next, 0, 300);
        i += 1;
        break;
      case '--drain-timeout':
        options.drainTimeoutSeconds = number(arg, next, 5, 3_600);
        i += 1;
        break;
      case '--api':
        options.apiBaseUrl = next ?? '';
        i += 1;
        break;
      case '--cleanup':
        options.cleanupOnly = true;
        break;
      case '--help':
      case '-h':
        console.log('See the header of backend/scripts/load-sim-locations.ts for usage.');
        process.exit(0);
        break;
      default:
        if (/^\d+$/.test(arg)) options.drivers = number('drivers', arg, 1, 100_000);
        else fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Load backend/.env (shell variables win, as they do for the API) and refuse
 * anything that is not the local docker stack.
 */
function resolveEnvironment(options: Options): ResolvedEnv {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV is production.');

  const databaseUrl = requireLocalUrl('DATABASE_URL', process.env.DATABASE_URL);
  const redisUrl = requireLocalUrl('REDIS_URL', process.env.REDIS_URL);
  options.apiBaseUrl = requireLocalUrl(
    '--api',
    options.apiBaseUrl || `http://localhost:${process.env.PORT ?? '4000'}`,
  ).replace(/\/+$/, '');

  if ((process.env.AUTH_PROVIDER ?? 'local') !== 'local') {
    refuse('AUTH_PROVIDER is not local; the simulation signs its drivers’ tokens with JWT_LOCAL_SECRET.');
  }
  const jwtSecret = process.env.JWT_LOCAL_SECRET ?? '';
  if (jwtSecret.length < 32) refuse('JWT_LOCAL_SECRET is missing or shorter than 32 characters.');

  return {
    databaseUrl,
    redisUrl,
    jwtSecret,
    jwtIssuer: process.env.JWT_ISSUER || 'uride-local',
    flushTickMs: Number(process.env.GEO_FLUSH_TICK_MS) || 1_000,
    idleSampleSeconds: Number(process.env.GEO_IDLE_TRAIL_SAMPLE_SECONDS) || 30,
  };
}

function requireLocalUrl(name: string, raw: string | undefined): string {
  if (!raw) refuse(`${name} is not set.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse(`${name} is not a valid URL.`);
  }
  if (/supabase/i.test(url.hostname) || /pgbouncer=true/i.test(url.search)) {
    refuse(
      `${name} points at Supabase (${url.hostname}). This simulation is for the local docker ` +
        'database only — point backend/.env at infra/docker-compose.yml first.',
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    refuse(`${name} host "${url.hostname}" is not this machine. Local docker stack only.`);
  }
  return raw;
}

/**
 * Belt and braces after the URL check, before anything is written: the database
 * must be WeRide's, must not be a Supabase project (every one has the
 * supabase_admin role), and must be served from a local container.
 */
async function assertLocalSchema(prisma: PrismaClient): Promise<void> {
  const [row] = await prisma.$queryRaw<{ has_trail: boolean; supabase: boolean; server: string | null }[]>`
    SELECT to_regclass('public.driver_locations') IS NOT NULL AS "has_trail",
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') AS "supabase",
           host(inet_server_addr()) AS "server"
  `;
  if (row?.supabase) refuse('this database is a Supabase project. Local docker database only.');
  if (!row?.has_trail) refuse('driver_locations does not exist here — run the migrations against the local database.');
  const server = row.server;
  // Unix socket (null), loopback, or the docker bridge the port is published through.
  if (server !== null && !/^(127\.|::1$|172\.|192\.168\.|10\.)/.test(server)) {
    refuse(`the database server reports address ${server}, which is not a local docker container.`);
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function buildFleet(options: Options, env: ResolvedEnv): Promise<SimDriver[]> {
  const secret = new TextEncoder().encode(env.jwtSecret);
  const expiresAt = Math.floor(Date.now() / 1000) + options.durationSeconds + options.drainTimeoutSeconds + 900;
  const onTripCount = Math.round(options.drivers * options.onTripShare);
  const runTag = randomUUID().slice(0, 8);

  const fleet: SimDriver[] = [];
  for (let i = 0; i < options.drivers; i += 1) {
    const id = randomUUID();
    const token = await new SignJWT({ roles: ['driver'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(id)
      .setJti(randomUUID())
      .setIssuer(env.jwtIssuer)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(secret);
    fleet.push({
      id,
      email: `driver-${runTag}-${i}@${EMAIL_DOMAIN}`,
      token,
      onTrip: i < onTripCount,
      lat: FLEET_CENTRE.lat + (Math.random() - 0.5) * 2 * FLEET_SPREAD_DEGREES,
      lng: FLEET_CENTRE.lng + (Math.random() - 0.5) * 2 * FLEET_SPREAD_DEGREES,
      headingDegrees: Math.random() * 360,
    });
  }
  return fleet;
}

async function seed(prisma: PrismaClient, fleet: readonly SimDriver[]): Promise<void> {
  for (let i = 0; i < fleet.length; i += INSERT_CHUNK) {
    const chunk = fleet.slice(i, i + INSERT_CHUNK);
    await prisma.$transaction([
      prisma.$executeRaw`
        INSERT INTO "users" ("id", "email", "full_name")
        VALUES ${Prisma.join(chunk.map((d) => Prisma.sql`(${d.id}::uuid, ${d.email}, 'Load simulation driver')`))}
      `,
      prisma.$executeRaw`
        INSERT INTO "driver_profiles" ("user_id")
        VALUES ${Prisma.join(chunk.map((d) => Prisma.sql`(${d.id}::uuid)`))}
      `,
      // Seeded straight into their shift: the eligibility checklist behind
      // POST /online is not what this measures, and kyc_status 'not_started'
      // keeps dispatch from ever offering them a ride.
      prisma.$executeRaw`
        INSERT INTO "driver_availability" ("driver_id", "status", "current_ride_id", "went_online_at")
        VALUES ${Prisma.join(
          chunk.map((d) =>
            d.onTrip
              ? Prisma.sql`(${d.id}::uuid, 'on_trip', ${randomUUID()}::uuid, now())`
              : Prisma.sql`(${d.id}::uuid, 'online', NULL, now())`,
          ),
        )}
      `,
    ]);
  }
}

/**
 * One real ping before any load: proves the API is up, accepts our tokens, and
 * — the one that matters — reads the database this script seeded and the Redis
 * this script watches. An API on Supabase answers driver_not_found for a driver
 * that exists only locally, and nothing further is sent.
 */
async function preflight(options: Options, redis: Redis, fleet: readonly SimDriver[]): Promise<void> {
  const health = await fetch(`${options.apiBaseUrl}/healthz`).catch(() => null);
  if (!health?.ok) refuse(`the API at ${options.apiBaseUrl} is not answering /healthz.`);

  const probe = fleet[0];
  if (!probe) refuse('no drivers to simulate.');
  const response = await sendPing(options, probe);
  const body = await response.text();
  if (response.status === 401) {
    refuse('the API rejected the simulation’s token — its JWT_LOCAL_SECRET or JWT_ISSUER differs from backend/.env.');
  }
  if (response.status === 404) {
    refuse(
      `the API answered ${body.slice(0, 120)} for a driver this script just created. It is not using ` +
        'this database — most likely it is running against Supabase. Restart it against the local docker DB.',
    );
  }
  if (response.status === 429) {
    refuse('the API rate-limited the very first ping. Restart it with RATE_LIMIT_MAX=1000000 for the run.');
  }
  if (!response.ok) refuse(`the probe ping failed with HTTP ${response.status}: ${body.slice(0, 200)}`);

  if ((await redis.exists(`uride:rl:location-ping:${probe.id}`)) !== 1) {
    refuse('the API is not using the Redis in REDIS_URL — the trail drain and cleanup would watch the wrong one.');
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run(options: Options, fleet: readonly SimDriver[], stopped: () => boolean): Promise<RunStats> {
  const stats: RunStats = {
    sent: 0,
    accepted: 0,
    acceptedOnTrip: 0,
    acceptedIdle: 0,
    networkErrors: 0,
    byStatus: new Map(),
    latenciesMs: [],
    startedAtMs: Date.now(),
    endedAtMs: 0,
  };
  const intervalMs = options.intervalSeconds * 1000;
  const endsAtMs = stats.startedAtMs + options.durationSeconds * 1000;
  let limiterTripped = false;
  const halted = (): boolean => limiterTripped || stopped();

  const limiterWatch = setTimeout(() => {
    const limited = stats.byStatus.get(429) ?? 0;
    if (stats.sent > 0 && limited / stats.sent > LIMITER_ABORT_SHARE) limiterTripped = true;
  }, LIMITER_CHECK_AFTER_MS);

  const progress = setInterval(() => {
    const elapsed = (Date.now() - stats.startedAtMs) / 1000;
    console.log(`  ${elapsed.toFixed(0)}s  sent ${stats.sent}  accepted ${stats.accepted}  errors ${stats.sent - stats.accepted}`);
  }, 10_000);

  const driveOne = async (driver: SimDriver): Promise<void> => {
    // Spread first pings across one interval, as a fleet that came online over time would.
    let nextAtMs = stats.startedAtMs + Math.random() * intervalMs;
    while (nextAtMs < endsAtMs && !halted()) {
      const waitMs = nextAtMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      if (halted()) return;

      advance(driver, options.intervalSeconds);
      stats.sent += 1;
      const startedAt = performance.now();
      try {
        const response = await sendPing(options, driver);
        await response.arrayBuffer();
        const elapsedMs = performance.now() - startedAt;
        stats.byStatus.set(response.status, (stats.byStatus.get(response.status) ?? 0) + 1);
        if (response.ok) {
          stats.accepted += 1;
          if (driver.onTrip) stats.acceptedOnTrip += 1;
          else stats.acceptedIdle += 1;
          stats.latenciesMs.push(elapsedMs);
        }
      } catch {
        stats.networkErrors += 1;
      }
      // Closed loop: a slow API delays this driver's next ping rather than
      // letting pings stack up — the offered load never exceeds fleet / interval.
      nextAtMs = Math.max(nextAtMs + intervalMs, Date.now());
    }
  };

  await Promise.all(fleet.map(driveOne));
  clearTimeout(limiterWatch);
  clearInterval(progress);
  stats.endedAtMs = Date.now();

  if (limiterTripped) {
    refuse(
      `${stats.byStatus.get(429) ?? 0} of the first ${stats.sent} pings were rejected with 429. The API's global ` +
        'per-IP limiter (RATE_LIMIT_MAX) is throttling the simulation, which shares one IP. Restart the API ' +
        'with RATE_LIMIT_MAX=1000000 for the run.',
    );
  }
  return stats;
}

function sendPing(options: Options, driver: SimDriver): Promise<Response> {
  return fetch(`${options.apiBaseUrl}/v1/drivers/me/location`, {
    method: 'POST',
    headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      location: { lat: driver.lat, lng: driver.lng },
      headingDegrees: driver.headingDegrees,
      speedMps: driver.onTrip ? 11 : 0.5,
      accuracyMeters: 6,
      recordedAt: new Date().toISOString(),
    }),
  });
}

/** Drift along a wandering heading at city speed, bounded to the fleet's box. */
function advance(driver: SimDriver, intervalSeconds: number): void {
  const metres = (driver.onTrip ? 11 : 2) * intervalSeconds;
  driver.headingDegrees = (driver.headingDegrees + (Math.random() - 0.5) * 40 + 360) % 360;
  const radians = (driver.headingDegrees * Math.PI) / 180;
  driver.lat += (Math.cos(radians) * metres) / 111_320;
  driver.lng += (Math.sin(radians) * metres) / (111_320 * Math.cos((driver.lat * Math.PI) / 180));
  if (Math.abs(driver.lat - FLEET_CENTRE.lat) > FLEET_SPREAD_DEGREES) driver.lat = FLEET_CENTRE.lat;
  if (Math.abs(driver.lng - FLEET_CENTRE.lng) > FLEET_SPREAD_DEGREES) driver.lng = FLEET_CENTRE.lng;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function waitForDrain(redis: Redis, flushTickMs: number, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  await sleep(flushTickMs * 2);
  let emptyPolls = 0;
  while (Date.now() < deadline) {
    const [queued, inflight] = await Promise.all([redis.llen(TRAIL_QUEUE_KEY), redis.llen(TRAIL_INFLIGHT_KEY)]);
    emptyPolls = queued + inflight === 0 ? emptyPolls + 1 : 0;
    // Two empty polls a tick apart: the last claimed batch has been written and released.
    if (emptyPolls >= 2) return true;
    await sleep(Math.max(250, flushTickMs / 2));
  }
  return false;
}

async function countTrailRows(prisma: PrismaClient, ids: readonly string[]): Promise<{ total: number; onTrip: number }> {
  const [row] = await prisma.$queryRaw<{ total: bigint; on_trip: bigint }[]>`
    SELECT count(*) AS "total", count(*) FILTER (WHERE "ride_id" IS NOT NULL) AS "on_trip"
      FROM "driver_locations"
     WHERE "driver_id" = ANY(${[...ids]}::uuid[])
  `;
  return { total: Number(row?.total ?? 0), onTrip: Number(row?.on_trip ?? 0) };
}

async function postgresTransactions(prisma: PrismaClient): Promise<number> {
  const [row] = await prisma.$queryRaw<{ xacts: bigint }[]>`
    SELECT (xact_commit + xact_rollback) AS "xacts" FROM pg_stat_database WHERE datname = current_database()
  `;
  return Number(row?.xacts ?? 0);
}

async function measureBaseline(prisma: PrismaClient, seconds: number): Promise<number> {
  console.log(`Measuring background Postgres traffic for ${seconds}s (no pings)…`);
  // Let the probe ping's and the seeding's own transactions reach pg_stat first.
  await sleep(11_000);
  const before = await postgresTransactions(prisma);
  await sleep(seconds * 1000);
  const after = await postgresTransactions(prisma);
  return Math.max(0, after - before) / seconds;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function report(input: {
  options: Options;
  env: ResolvedEnv;
  fleet: readonly SimDriver[];
  stats: RunStats;
  rows: { total: number; onTrip: number };
  drained: boolean;
  transactions: { total: number; background: number } | null;
}): void {
  const { options, env, fleet, stats, rows, drained, transactions } = input;
  const seconds = Math.max(0.001, (stats.endedAtMs - stats.startedAtMs) / 1000);
  const latencies = [...stats.latenciesMs].sort((a, b) => a - b);
  const idleRows = rows.total - rows.onTrip;
  const ratio = (pings: number, written: number): string =>
    written === 0 ? (pings === 0 ? '—' : `${fmt(pings)} : 0`) : `${(pings / written).toFixed(2)} : 1`;
  const share = (written: number, pings: number): string =>
    pings === 0 ? '—' : `${((written / pings) * 100).toFixed(1)}%`;
  const idleDrivers = fleet.filter((d) => !d.onTrip).length;
  const expectedIdleRows = idleDrivers * Math.ceil(options.durationSeconds / env.idleSampleSeconds);

  const rule = '═'.repeat(78);
  console.log(`\n${rule}`);
  console.log(`  PINGS → POSTGRES ROWS    ${fmt(stats.accepted)} pings accepted → ${fmt(rows.total)} driver_locations rows`);
  console.log(`                           ${ratio(stats.accepted, rows.total)}   (${share(rows.total, stats.accepted)} of pings became a row; was 100%)`);
  console.log(rule);
  console.log(
    `  on a trip   ${pad(fmt(stats.acceptedOnTrip), 9)} pings → ${pad(fmt(rows.onTrip), 9)} rows  ${pad(ratio(stats.acceptedOnTrip, rows.onTrip), 12)}` +
      ' every point kept (fare evidence)',
  );
  console.log(
    `  idle        ${pad(fmt(stats.acceptedIdle), 9)} pings → ${pad(fmt(idleRows), 9)} rows  ${pad(ratio(stats.acceptedIdle, idleRows), 12)}` +
      ` 1 per driver per ${env.idleSampleSeconds}s (expect ≤ ~${fmt(expectedIdleRows)})`,
  );
  console.log('');
  console.log(`  accepted     ${(stats.accepted / seconds).toFixed(1)} pings/s over ${seconds.toFixed(1)}s   (offered ${(fleet.length / options.intervalSeconds).toFixed(1)}/s)`);
  console.log(
    `  latency      p50 ${ms(percentile(latencies, 50))}   p95 ${ms(percentile(latencies, 95))}   ` +
      `p99 ${ms(percentile(latencies, 99))}   max ${ms(latencies[latencies.length - 1] ?? Number.NaN)}`,
  );
  const statuses = [...stats.byStatus.entries()].sort(([a], [b]) => a - b).map(([code, n]) => `${code}×${fmt(n)}`);
  console.log(`  responses    ${statuses.join('  ') || 'none'}${stats.networkErrors ? `  network errors×${fmt(stats.networkErrors)}` : ''}`);

  if (transactions) {
    const attributable = Math.max(0, transactions.total - transactions.background);
    console.log(
      `  Postgres     ${fmt(Math.round(attributable))} transactions attributable to the run ` +
        `(${fmt(transactions.total)} total − ~${fmt(Math.round(transactions.background))} background) ` +
        `= ${stats.accepted === 0 ? '—' : (attributable / stats.accepted).toFixed(3)} per ping`,
    );
    console.log(
      `               ${fleet.length} of those are expected once per driver (first ping resolves status); ` +
        'anything near 1.0 per ping means the request path still reads or writes Postgres per ping.',
    );
  }
  if (!drained) {
    console.log(
      `\n  WARNING  the trail queue did not drain within ${options.drainTimeoutSeconds}s, so the row count is a floor. ` +
        'Points still queued for these drivers can land after cleanup — run with --cleanup once the queue is empty.',
    );
  }
  console.log(`${rule}\n`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function leftoverDriverIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id" FROM "users" WHERE "email" LIKE ${`%@${EMAIL_DOMAIN}`}
  `;
  return rows.map((r) => r.id);
}

async function cleanup(prisma: PrismaClient, redis: Redis, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }
  let trailRows = 0;
  let users = 0;
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    const chunk = ids.slice(i, i + INSERT_CHUNK);
    // driver_locations has no foreign key (it is partitioned), so it goes first
    // and explicitly; users cascades to driver_profiles and driver_availability.
    trailRows += await prisma.$executeRaw`DELETE FROM "driver_locations" WHERE "driver_id" = ANY(${chunk}::uuid[])`;
    users += await prisma.$executeRaw`
      DELETE FROM "users" WHERE "id" = ANY(${chunk}::uuid[]) AND "email" LIKE ${`%@${EMAIL_DOMAIN}`}
    `;

    const cells = redis.pipeline();
    for (const id of chunk) cells.hmget(`${INDEX_PREFIX}drv:${id}`, 'st', 'cell');
    const placements = (await cells.exec()) ?? [];
    const removal = redis.pipeline();
    chunk.forEach((id, j) => {
      const reply = placements[j]?.[1];
      if (Array.isArray(reply) && typeof reply[0] === 'string' && typeof reply[1] === 'string') {
        removal.zrem(`${INDEX_PREFIX}cell:${reply[0]}:${reply[1]}`, id);
      }
      removal.del(
        `${INDEX_PREFIX}drv:${id}`,
        `${INDEX_PREFIX}off:${id}`,
        `uride:geo:trail:sampled:${id}`,
        `uride:geo:avail:refreshed:${id}`,
        `uride:rl:location-ping:${id}`,
        `uride:rl:location-ping-batch:${id}`,
      );
    });
    await removal.exec();
  }
  console.log(`Cleaned up: ${fmt(users)} simulated drivers, ${fmt(trailRows)} driver_locations rows, their Redis keys.`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function fmt(n: number): string {
  return n.toLocaleString('en-CA');
}

function ms(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : '—';
}

function pad(text: string, width: number): string {
  return text.padStart(width);
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

function fail(reason: string): never {
  console.error(`load-sim-locations: ${reason}`);
  process.exit(2);
}

main().catch((error: unknown) => {
  if (error instanceof Refusal) {
    console.error(`\nload-sim-locations REFUSED: ${error.message}\n`);
    process.exit(3);
  }
  console.error(error);
  process.exit(1);
});
