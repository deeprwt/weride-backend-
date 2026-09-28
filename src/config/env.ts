import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Single source of truth for environment variables. Boot fails fast on
 * misconfiguration with a clear error — never let a missing var surface later
 * as a mysterious 500.
 *
 * Some fields have additional cross-field rules that zod can't model alone
 * (e.g. JWT_LOCAL_SECRET must differ from .env.example); those run after the
 * schema parse, before we return.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // ---- Identity provider selection ----
  // 'local' — issues + verifies our own HS256 JWTs against JWT_LOCAL_SECRET.
  // 'supabase' — verifies tokens issued by Supabase Auth via JWKS / shared secret.
  AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),

  // Required in local mode. ≥32 chars, never equal to a placeholder.
  JWT_LOCAL_SECRET: z.string().min(32).optional().or(z.literal('')),
  JWT_ISSUER: z.string().default('uride-local'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60), // 15m
  JWT_REFRESH_TTL_MOBILE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(14 * 24 * 60 * 60), // 14d
  JWT_REFRESH_TTL_ADMIN_SECONDS: z.coerce.number().int().positive().default(8 * 60 * 60), // 8h

  // Supabase (required in supabase mode)
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_ANON_KEY: z.string().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),
  SUPABASE_JWT_SECRET: z.string().optional().or(z.literal('')),

  // ---- OTP provider selection ----
  OTP_PROVIDER: z.enum(['local', 'twilio']).default('local'),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(5 * 60), // 5m
  OTP_RATE_PER_PHONE_PER_MIN: z.coerce.number().int().positive().default(5),
  OTP_RATE_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),

  // Local dev: when set, ALSO accepts this fixed code for any phone.
  // Hard-refused when NODE_ENV=production OR AUTH_PROVIDER=supabase OR OTP_PROVIDER=twilio.
  LOCAL_DEV_MAGIC_OTP: z
    .string()
    .regex(/^\d{6}$/, 'LOCAL_DEV_MAGIC_OTP must be 6 digits')
    .optional()
    .or(z.literal('')),

  // Local OTP "SMS" preview via Mailhog SMTP (the developer's inbox at :8025).
  MAILHOG_SMTP_HOST: z.string().default('localhost'),
  MAILHOG_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  LOCAL_OTP_PREVIEW_EMAIL: z.string().email().default('dev-otp-preview@uride.local'),

  // Twilio (required in twilio mode)
  TWILIO_ACCOUNT_SID: z.string().optional().or(z.literal('')),
  TWILIO_AUTH_TOKEN: z.string().optional().or(z.literal('')),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional().or(z.literal('')),

  // Admin password / TOTP
  ADMIN_MIN_PASSWORD_LENGTH: z.coerce.number().int().positive().default(12),
  HIBP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean().default(true)),
  TOTP_ISSUER: z.string().default('WeRide'),
  TOTP_RECOVERY_CODE_COUNT: z.coerce.number().int().positive().default(10),

  // Pricing service
  PRICING_BASE_URL: z.string().url().default('http://localhost:5000'),
  PRICING_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  // ---- Driver document storage (Phase 2) ----
  // 'local' writes to DOCUMENT_STORAGE_PATH on disk — zero cost, works offline,
  // and is the right choice for development only: a container filesystem is
  // ephemeral, so a deployed 'local' loses every KYC document on redeploy.
  // 'supabase' is the deployed driver, writing to a PRIVATE Supabase bucket.
  // 's3' remains unimplemented so a half-configured bucket can never silently
  // swallow KYC uploads.
  DOCUMENT_STORAGE_DRIVER: z.enum(['local', 'supabase', 's3']).default('local'),
  DOCUMENT_STORAGE_PATH: z.string().default('./var/documents'),

  // Required when DOCUMENT_STORAGE_DRIVER=supabase. The bucket must exist and
  // must be PRIVATE — the service-role key bypasses RLS, so the bucket's own
  // public flag is the only thing standing between a licence scan and the open
  // internet.
  SUPABASE_STORAGE_BUCKET: z.string().default('driver-documents'),
  SUPABASE_STORAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // ---- Driver availability / dispatch tuning (Phase 2) ----
  // A driver whose last ping is older than this is invisible to dispatch.
  DRIVER_LOCATION_STALE_SECONDS: z.coerce.number().int().positive().default(60),
  // Hard ceiling on the nearby-driver search radius, regardless of request.
  DRIVER_MAX_SEARCH_RADIUS_METERS: z.coerce.number().int().positive().default(25_000),
  // Drivers must re-confirm they are online at least this often; the sweeper
  // marks anyone quieter than this offline so they stop receiving offers.
  DRIVER_ONLINE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(120),

  // ---- Dispatch / matching (Phase 3) ----
  // The dispatcher is a control loop, not a request handler: every number here
  // is a dial ops turns while watching match rate against rider wait time, so
  // none of them are constants inside MatchingService. Defaults are tuned for a
  // thin launch fleet — few drivers, so search wide and give them time to
  // answer — and want retuning once there is real supply.
  //
  // Kills the background loop. Rides can still be dispatched explicitly (an ops
  // retry, the rides module after a request); nothing re-dispatches on its own
  // and no offer ever expires. Ops-only escape hatch — a platform running with
  // this off matches almost nothing.
  DISPATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean().default(true)),
  // How often the loop looks for expired offers and rides to re-offer. This is
  // the floor on how fast a declined ride reaches the next driver, so it is
  // deliberately short; the query behind it is a partial-index scan.
  DISPATCH_TICK_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  // How long a driver has to answer. Long enough to pick the phone up, short
  // enough that three ignored offers do not cost the rider a minute.
  DISPATCH_OFFER_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  // Waves before the ride is told nobody is coming. MAX_ROUNDS * OFFER_TTL is
  // roughly the worst-case wait before `no_drivers_found`.
  DISPATCH_MAX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  // Drivers offered per wave. Higher matches faster and interrupts more people
  // who are about to lose the race; the one-accepted-per-ride unique index is
  // what makes offering several at once safe.
  DISPATCH_CANDIDATES_PER_ROUND: z.coerce.number().int().min(1).max(20).default(3),
  // Search radius per wave, in metres, widening each round. Entries past the
  // last one repeat it, so a MAX_ROUNDS longer than this ladder means "keep
  // trying at the widest radius".
  DISPATCH_RADIUS_LADDER_METERS: z
    .string()
    .default('3000,6000,10000')
    .transform((raw) => raw.split(',').map((part) => Number(part.trim())))
    .pipe(z.array(z.number().int().positive()).min(1)),
  // H3 rings searched per wave, widening each round: round N reads the pickup's
  // resolution-8 hexagon plus every cell within this many rings of it (1, 2, 3
  // rings = 7, 19, 37 cells; a ring is roughly 0.8–1 km). This decides WHERE a
  // wave looks. DISPATCH_RADIUS_LADDER_METERS above still decides how far away a
  // driver may be for the same round — a hard cap applied after the ring search,
  // because hexagon rings are not circles and a wide ladder here must never
  // offer a driver further out than ops agreed a pickup can be. Entries past the
  // last one repeat it, like the radius ladder. Capped at 20 rings (~1,261
  // cells): past that a wave is scanning a city, not a neighbourhood.
  DISPATCH_RING_LADDER: z
    .string()
    .default('1,2,3')
    .transform((raw) => raw.split(',').map((part) => Number(part.trim())))
    .pipe(z.array(z.number().int().min(0).max(20)).min(1))
    .refine((ladder) => ladder.every((rings, i) => i === 0 || rings > ladder[i - 1]), {
      message:
        'must increase with every round (e.g. 1,2,3) — a later wave searching fewer ' +
        'rings would declare a ride undeliverable with a driver inside the first one.',
    }),
  // Average city speed used to turn metres into an ETA. Straight-line distance
  // with a detour factor is all we have until MAPS_PROVIDER stops being `none`
  // — a routing API is billable, and a wrong-by-a-minute ETA is a far cheaper
  // problem than a surprise invoice. See docs/RUNBOOK.md §cost.
  DISPATCH_AVERAGE_SPEED_KMH: z.coerce.number().int().min(5).max(120).default(30),
  // Offers expired and rides re-dispatched per tick. Bounds the work one tick
  // can do so a backlog is drained over several ticks instead of in one burst
  // that starves the connection pool of everything else.
  DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  // ---- Geo hot path: live driver index + batched location trail ----
  // A location ping is a Redis write and nothing else. The driver's live
  // position goes into the H3 index (what dispatch, surge and live ETA read);
  // the point itself joins a Redis queue that LocationFlushWorker drains into
  // Postgres in bulk. These dials trade Postgres load against trail fidelity
  // and against how long a Postgres outage Redis can absorb.
  //
  // How often the flush worker drains the queue. Together with the batch size
  // this is the drain rate: BATCH_SIZE / (TICK_MS / 1000) points per second must
  // stay above the fleet's ping rate (online drivers / ping interval), or the
  // backlog only ever grows. Defaults drain 2,000/s — 10k drivers at one ping
  // per 5 s — before sampling throws most of it away.
  GEO_FLUSH_TICK_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  // Points read per tick, and so the most one tick can write. Capped at 4,000
  // because the trail INSERT binds 8 parameters a row and Postgres refuses a
  // statement past 65,535; 4,000 keeps clear of it with room to spare.
  GEO_FLUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(4_000).default(2_000),
  // Ceiling on the queue while Postgres cannot take writes. Past it the OLDEST
  // points are dropped (loudly) rather than letting Redis run out of memory —
  // Redis also holds sessions, rate limits and dispatch locks, and losing those
  // is an outage where losing old breadcrumbs is not. ~250 bytes a point, so the
  // default is roughly 125 MB.
  GEO_FLUSH_QUEUE_MAX_POINTS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(20_000_000)
    .default(500_000),
  // Points recorded with no ride keep at most one per driver per this many
  // seconds of capture time. Points on a ride are never sampled: they are the
  // evidence in a fare dispute. See LocationFlushWorker for the storage math.
  GEO_IDLE_TRAIL_SAMPLE_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
  // driver_availability.last_location / last_ping_at are refreshed at most this
  // often per driver. Dispatch no longer reads them; the admin dashboard and the
  // heartbeat sweeper do, and neither needs a fresher view than this.
  GEO_AVAILABILITY_REFRESH_SECONDS: z.coerce.number().int().min(1).max(300).default(15),

  // External providers (Phase 3+)
  // First billable dependency — see docs/RUNBOOK.md §cost. Required once
  // MAPS_PROVIDER=google; the 'none' provider keeps local dev free.
  MAPS_PROVIDER: z.enum(['none', 'google']).default('none'),
  GOOGLE_MAPS_API_KEY: z.string().optional().or(z.literal('')),
  STRIPE_SECRET_KEY: z.string().optional().or(z.literal('')),
  STRIPE_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),

  // Observability
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  OTEL_SERVICE_NAME: z.string().default('uride-api'),

  // Security
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[uride-api] Invalid environment variables:\n${issues}`);
  }
  const env = parsed.data;

  // --- Cross-field guards (Phase 1 requirements) ---
  enforceJwtLocalSecret(env);
  enforceAuthProviderCompleteness(env);
  enforceOtpProviderCompleteness(env);
  enforceMagicOtpScope(env);
  enforceMapsProviderCompleteness(env);
  enforceStorageDriverSupported(env);
  enforceDispatchLadder(env);
  enforceGeoRefreshWithinHeartbeat(env);

  cached = env;
  return cached;
}

/** Test-only — clear cache between tests that mutate process.env. */
export function _resetEnvCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------

function enforceJwtLocalSecret(env: Env): void {
  if (env.AUTH_PROVIDER !== 'local') return;
  const secret = env.JWT_LOCAL_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error(
      '[uride-api] AUTH_PROVIDER=local requires JWT_LOCAL_SECRET (>=32 chars). ' +
        'Generate one with: openssl rand -base64 48',
    );
  }
  const placeholders = collectEnvExamplePlaceholders('JWT_LOCAL_SECRET');
  if (placeholders.has(secret)) {
    throw new Error(
      '[uride-api] JWT_LOCAL_SECRET matches a placeholder from .env.example. ' +
        'Refusing to boot with a known-public secret.',
    );
  }
}

function enforceAuthProviderCompleteness(env: Env): void {
  if (env.AUTH_PROVIDER === 'supabase') {
    if (!env.SUPABASE_JWT_SECRET) {
      throw new Error(
        '[uride-api] AUTH_PROVIDER=supabase requires SUPABASE_JWT_SECRET.',
      );
    }
    if (!env.SUPABASE_URL) {
      throw new Error('[uride-api] AUTH_PROVIDER=supabase requires SUPABASE_URL.');
    }
  }
}

function enforceOtpProviderCompleteness(env: Env): void {
  if (env.OTP_PROVIDER === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error(
        '[uride-api] OTP_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, ' +
          'TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.',
      );
    }
  }
}

function enforceMagicOtpScope(env: Env): void {
  if (!env.LOCAL_DEV_MAGIC_OTP) return;
  if (env.NODE_ENV === 'production') {
    throw new Error('[uride-api] LOCAL_DEV_MAGIC_OTP is forbidden when NODE_ENV=production.');
  }
  if (env.AUTH_PROVIDER === 'supabase') {
    throw new Error(
      '[uride-api] LOCAL_DEV_MAGIC_OTP is forbidden when AUTH_PROVIDER=supabase.',
    );
  }
  if (env.OTP_PROVIDER === 'twilio') {
    throw new Error('[uride-api] LOCAL_DEV_MAGIC_OTP is forbidden when OTP_PROVIDER=twilio.');
  }
}

/**
 * Google Maps is the platform's first billable dependency. Booting with
 * MAPS_PROVIDER=google and no key would not fail here — it would fail later, as
 * every geocode and route request silently degrading to an error mid-ride. Fail
 * at boot instead.
 */
function enforceMapsProviderCompleteness(env: Env): void {
  if (env.MAPS_PROVIDER !== 'google') return;
  if (!env.GOOGLE_MAPS_API_KEY) {
    throw new Error(
      '[uride-api] MAPS_PROVIDER=google requires GOOGLE_MAPS_API_KEY. ' +
        'This is a BILLABLE provider — see docs/RUNBOOK.md before enabling it. ' +
        'Use MAPS_PROVIDER=none for free local development.',
    );
  }
  const placeholders = collectEnvExamplePlaceholders('GOOGLE_MAPS_API_KEY');
  if (placeholders.has(env.GOOGLE_MAPS_API_KEY)) {
    throw new Error(
      '[uride-api] GOOGLE_MAPS_API_KEY matches the placeholder in .env.example. ' +
        'Refusing to boot with a known-public key.',
    );
  }
}

/**
 * The s3 storage driver is declared in the enum so the config shape is stable,
 * but there is no implementation yet. Refuse at boot rather than accepting KYC
 * uploads into a driver that cannot persist them.
 */
function enforceStorageDriverSupported(env: Env): void {
  if (env.DOCUMENT_STORAGE_DRIVER === 's3') {
    throw new Error(
      '[uride-api] DOCUMENT_STORAGE_DRIVER=s3 is not implemented yet. ' +
        'Use DOCUMENT_STORAGE_DRIVER=supabase for object storage, or =local for development.',
    );
  }

  if (env.DOCUMENT_STORAGE_DRIVER === 'supabase') {
    if (!env.SUPABASE_URL) {
      throw new Error(
        '[uride-api] DOCUMENT_STORAGE_DRIVER=supabase requires SUPABASE_URL ' +
          '(e.g. https://<ref>.supabase.co).',
      );
    }
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        '[uride-api] DOCUMENT_STORAGE_DRIVER=supabase requires SUPABASE_SERVICE_ROLE_KEY. ' +
          'The anon key cannot write to a private bucket.',
      );
    }
    // A service-role key in the wrong field is the one mistake here that fails
    // open: the anon key is safe to leak and would quietly 403 on every upload,
    // while the operator believes storage is configured.
    if (env.SUPABASE_SERVICE_ROLE_KEY === env.SUPABASE_ANON_KEY) {
      throw new Error(
        '[uride-api] SUPABASE_SERVICE_ROLE_KEY is set to the anon key. ' +
          'KYC uploads would fail on every request.',
      );
    }
  }
}

/**
 * The dispatch radius ladder has to widen, and it has to stay inside the ceiling
 * GeoService enforces.
 *
 * Both failures are silent at runtime, which is why they are boot errors.
 * `findNearbyDrivers` clamps any radius above DRIVER_MAX_SEARCH_RADIUS_METERS,
 * so a ladder ending at 40 km on a 25 km ceiling would look like three
 * identical waves and nobody would know why the search stopped widening. A
 * ladder that does not ascend is the same mistake spelled differently: later
 * rounds would search a smaller area than earlier ones, and a ride would be
 * declared undeliverable while a driver sat inside the first round's radius.
 */
function enforceDispatchLadder(env: Env): void {
  const ladder = env.DISPATCH_RADIUS_LADDER_METERS;
  for (let i = 1; i < ladder.length; i += 1) {
    if (ladder[i] <= ladder[i - 1]) {
      throw new Error(
        '[uride-api] DISPATCH_RADIUS_LADDER_METERS must increase with every round ' +
          `(got ${ladder.join(', ')}). Each wave searches wider than the last.`,
      );
    }
  }
  const widest = ladder[ladder.length - 1];
  if (widest > env.DRIVER_MAX_SEARCH_RADIUS_METERS) {
    throw new Error(
      `[uride-api] DISPATCH_RADIUS_LADDER_METERS reaches ${widest}m but ` +
        `DRIVER_MAX_SEARCH_RADIUS_METERS caps every search at ` +
        `${env.DRIVER_MAX_SEARCH_RADIUS_METERS}m. Raise the cap or lower the ladder.`,
    );
  }
}

/**
 * The availability refresh has to stay well inside the heartbeat.
 *
 * Pings no longer write driver_availability; LocationFlushWorker refreshes
 * `last_ping_at` at most every GEO_AVAILABILITY_REFRESH_SECONDS, one flush tick
 * after the ping. The heartbeat sweeper takes anyone whose `last_ping_at` is
 * older than DRIVER_ONLINE_HEARTBEAT_SECONDS offline. Set the refresh too close
 * to the heartbeat and the sweeper starts taking drivers offline WHILE they are
 * pinging — nothing errors, drivers just keep being told to go online again.
 * Two refreshes plus a tick is the smallest margin that survives one refresh
 * being lost to a failed batch.
 */
function enforceGeoRefreshWithinHeartbeat(env: Env): void {
  const worstLagSeconds =
    env.GEO_AVAILABILITY_REFRESH_SECONDS * 2 + Math.ceil(env.GEO_FLUSH_TICK_MS / 1000);
  if (worstLagSeconds > env.DRIVER_ONLINE_HEARTBEAT_SECONDS) {
    throw new Error(
      `[uride-api] GEO_AVAILABILITY_REFRESH_SECONDS=${env.GEO_AVAILABILITY_REFRESH_SECONDS} ` +
        `(x2, plus a ${env.GEO_FLUSH_TICK_MS}ms flush tick) exceeds ` +
        `DRIVER_ONLINE_HEARTBEAT_SECONDS=${env.DRIVER_ONLINE_HEARTBEAT_SECONDS}. ` +
        'The heartbeat sweeper would take drivers offline while they are still pinging.',
    );
  }
}

/**
 * Reads .env.example (and Phase-0-style siblings) and collects the literal value
 * shown for the given key. Used to refuse boot when an operator has copy-pasted
 * a placeholder secret into a real .env file. Returns an empty set if the file
 * isn't found (e.g. in a packaged container).
 */
function collectEnvExamplePlaceholders(key: string): Set<string> {
  const found = new Set<string>();
  const candidates = [
    resolve(process.cwd(), '.env.example'),
    resolve(process.cwd(), 'apps/api/.env.example'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const contents = readFileSync(path, 'utf8');
      for (const line of contents.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m && m[1] === key) {
          const v = m[2].trim().replace(/^["']|["']$/g, '');
          if (v) found.add(v);
        }
      }
    } catch {
      // best-effort
    }
  }
  return found;
}
