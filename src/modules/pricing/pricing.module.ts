import { Module } from '@nestjs/common';
import { z } from 'zod';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import { GeoModule } from '../geo/geo.module';
import { H3DriverIndexService } from '../geo/h3-driver-index.service';
import { RouteEstimatorService } from './route-estimator.service';
import { SurgeService } from './surge.service';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Pricing dials, read once at boot.
 *
 * These live here rather than in config/env.ts for now; the maps provider and
 * its key are the exception and are read through loadEnv(), because env.ts
 * already refuses to boot with MAPS_PROVIDER=google and no real key, and that
 * guard is worth more than keeping every setting in one place.
 *
 * Every surge number is a dial ops turns while watching conversion against
 * rider wait time — none of them is a constant inside SurgeService. The
 * defaults are a starting point for a thin launch fleet and want retuning
 * against real demand.
 */
const PricingEnvSchema = z
  .object({
    // Kill switch. Off means every quote is priced at 1.0x. Demand is still
    // counted while it is off, so switching surge on mid-evening prices from a
    // warm window instead of ten minutes of undercounted demand.
    SURGE_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== 'false')
      .pipe(z.boolean().default(true)),
    // Rolling window demand is summed over, in whole minutes. Shorter reacts
    // faster to a concert letting out and is noisier everywhere else.
    SURGE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    // Hard cap on the zone multiplier. The pricing service clamps at 3.0 on its
    // own, so anything above that would be silently ignored — refused at boot
    // instead. Rounded DOWN to 0.1, because riders are shown multipliers to one
    // decimal and a cap of 2.26 must not become 2.3 — the cap is the most ops
    // signed off on. The epsilon keeps 2.3 (22.999…96 in binary) at 2.3.
    SURGE_MAX_MULTIPLIER: z.coerce
      .number()
      .min(1)
      .max(3)
      .default(2.5)
      .transform((v) => Math.floor(v * 10 + 1e-9) / 10),
    // Requests-in-window per idle driver at which surge begins. Below this the
    // neighbourhood is served and the price is the base price.
    SURGE_RATIO_THRESHOLD: z.coerce.number().positive().max(100).default(1.25),
    // Ratio at which the multiplier reaches SURGE_MAX_MULTIPLIER. The ramp
    // between the two is an S-curve, so crossing either end is never a step.
    SURGE_RATIO_AT_MAX: z.coerce.number().positive().max(1000).default(4),
    // Ride requests (one per rider) in the neighbourhood before surge may apply
    // at all. Two people and no drivers is a ratio of 2; it is not a shortage
    // worth repricing a neighbourhood for.
    SURGE_MIN_DEMAND: z.coerce.number().int().min(0).max(10_000).default(3),
    // Time constant of the per-zone moving average, in seconds. A step change in
    // demand moves the quoted multiplier ~63% of the way in one constant and ~95%
    // in three, so two quotes seconds apart see it barely move. 0 disables
    // smoothing.
    SURGE_SMOOTHING_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),

    // Road distance / straight-line distance, used when no routing provider is
    // configured or it fails. Road distance in a grid city typically runs 1.2 to
    // 1.4 times straight-line; 1.35 errs slightly long, because an estimate that
    // under-quotes is the one that ends in a dispute at the dropoff.
    ROUTE_DETOUR_FACTOR: z.coerce.number().min(1).max(3).default(1.35),
    // Average speed for the estimated duration. 28 km/h matches the tariff's
    // historic assumption (fares.py AVG_SPEED_KMH), so switching to the detour
    // estimate changes distance and nothing else about a quote.
    ROUTE_AVERAGE_SPEED_KMH: z.coerce.number().min(5).max(120).default(28),
    // Budget for one Routes API call. Tight on purpose: the quote is waiting on
    // it, and a slow Google must degrade to the estimate, never to a spinner.
    ROUTE_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(1200),
    // How long a computed route is reused for pickup/dropoff pins within ~100 m.
    // Minimum 30 s: this cache is what stops a rider dragging a pin from billing
    // a request per frame, and it must not be possible to switch that off by
    // accident.
    //
    // 30 minutes by default. Road geometry and free-flow distance between two
    // fixed points do not change on a five-minute horizon, so the old 300 s
    // bought nothing but repeat billing. Lower it only if ROUTE_TRAFFIC_AWARE
    // is on and you want the cached duration to track congestion closely.
    ROUTE_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(1800),
    // Traffic-aware routing bills at a higher Google tier than static routing.
    // It changes the DURATION only — distance, which dominates the fare, is
    // identical either way. Off by default: the cheaper tier keeps fares just
    // as accurate and only makes the quoted ETA less congestion-sensitive.
    // Turn on if you advertise arrival times and accept the bill.
    ROUTE_TRAFFIC_AWARE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((cfg, ctx) => {
    // Same class of mistake as a dispatch ladder that does not widen: a ramp
    // that ends before it starts would make every shortage jump straight to the
    // cap, and nothing at runtime would say why.
    if (cfg.SURGE_RATIO_AT_MAX <= cfg.SURGE_RATIO_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SURGE_RATIO_AT_MAX'],
        message: `must be greater than SURGE_RATIO_THRESHOLD (${cfg.SURGE_RATIO_THRESHOLD})`,
      });
    }
  });

export interface SurgeConfig {
  enabled: boolean;
  windowMinutes: number;
  /** Already rounded down to one decimal. */
  maxMultiplier: number;
  ratioThreshold: number;
  ratioAtMax: number;
  minDemand: number;
  smoothingSeconds: number;
}

export interface RouteConfig {
  provider: 'none' | 'google';
  /** Present only when provider is 'google'. Never log this object. */
  googleApiKey: string | null;
  detourFactor: number;
  averageSpeedKmh: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  /** Ask Google for a congestion-aware duration. Bills at a higher tier. */
  trafficAware: boolean;
}

export interface PricingConfig {
  surge: SurgeConfig;
  route: RouteConfig;
}

/** DI token for the parsed config. */
export const PRICING_CONFIG = Symbol('uride:pricing-config');

/**
 * Parse pricing settings. Throws with every problem listed, like loadEnv(), so
 * a bad value fails the boot instead of surfacing as a strange price.
 */
export function loadPricingConfig(source: NodeJS.ProcessEnv = process.env): PricingConfig {
  const parsed = PricingEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[uride-api] Invalid pricing configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const env = loadEnv();
  const googleApiKey = env.GOOGLE_MAPS_API_KEY ? env.GOOGLE_MAPS_API_KEY : null;
  if (env.MAPS_PROVIDER === 'google' && googleApiKey === null) {
    // loadEnv() already refuses this; restated so the type below is honest.
    throw new Error('[uride-api] MAPS_PROVIDER=google requires GOOGLE_MAPS_API_KEY.');
  }

  return {
    surge: {
      enabled: cfg.SURGE_ENABLED,
      windowMinutes: cfg.SURGE_WINDOW_MINUTES,
      maxMultiplier: cfg.SURGE_MAX_MULTIPLIER,
      ratioThreshold: cfg.SURGE_RATIO_THRESHOLD,
      ratioAtMax: cfg.SURGE_RATIO_AT_MAX,
      minDemand: cfg.SURGE_MIN_DEMAND,
      smoothingSeconds: cfg.SURGE_SMOOTHING_SECONDS,
    },
    route: {
      provider: env.MAPS_PROVIDER,
      googleApiKey: env.MAPS_PROVIDER === 'google' ? googleApiKey : null,
      detourFactor: cfg.ROUTE_DETOUR_FACTOR,
      averageSpeedKmh: cfg.ROUTE_AVERAGE_SPEED_KMH,
      timeoutMs: cfg.ROUTE_TIMEOUT_MS,
      cacheTtlSeconds: cfg.ROUTE_CACHE_TTL_SECONDS,
      trafficAware: cfg.ROUTE_TRAFFIC_AWARE,
    },
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Dynamic pricing inputs — zone surge on H3 hexagons and road distance.
 *
 * This module measures; it does not price. The fare itself stays in the Python
 * pricing service (and its mirrored fallback in PricingClient), which receives
 * the multiplier and the route as inputs. Keeping the tariff in one pure
 * function is what lets the fallback quote the same cents as the service.
 *
 * Both services are built by typed factories rather than class injection. They
 * take their slice of config as a plain constructor argument, which keeps them
 * constructible in a test without a Nest container, and it means neither file
 * imports a runtime value from this one — a DI token imported the other way
 * would be a require cycle that leaves the token undefined at decoration time.
 * The factories' return types make the compiler check the wiring, the same
 * reason MatchingModule binds its port with a factory.
 *
 * GeoModule is imported for H3DriverIndexService, the live driver index surge
 * reads supply from. RedisModule is @Global.
 */
@Module({
  imports: [GeoModule],
  providers: [
    { provide: PRICING_CONFIG, useFactory: (): PricingConfig => loadPricingConfig() },
    {
      provide: SurgeService,
      inject: [RedisService, H3DriverIndexService, PRICING_CONFIG],
      useFactory: (
        redis: RedisService,
        index: H3DriverIndexService,
        config: PricingConfig,
      ): SurgeService => new SurgeService(redis, index, config.surge),
    },
    {
      provide: RouteEstimatorService,
      inject: [RedisService, PRICING_CONFIG],
      useFactory: (redis: RedisService, config: PricingConfig): RouteEstimatorService =>
        new RouteEstimatorService(redis, config.route),
    },
  ],
  exports: [SurgeService, RouteEstimatorService],
})
export class PricingModule {}
