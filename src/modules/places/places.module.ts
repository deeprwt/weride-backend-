import { Module } from '@nestjs/common';
import { z } from 'zod';
import { RedisService } from '../../common/redis/redis.module';
import { GeocodingProvider } from './geocoding.types';
import { GeocodingService } from './geocoding.service';
import { PhotonProvider } from './photon.provider';
import { GooglePlacesProvider } from './google-places.provider';
import { PlacesController } from './places.controller';

/**
 * Address search configuration.
 *
 * Parsed here rather than in the global env schema for the same reason pricing
 * is: these knobs only mean anything to this module, and a reader of env.ts
 * should not have to understand geocoding to understand the app's boot.
 */
const PlacesEnvSchema = z.object({
  // 'photon' is free and needs no account, which is what makes it the default.
  // 'google' has materially better coverage of shops and businesses and is
  // BILLABLE per session — see the provider for how the bill is bounded.
  PLACES_PROVIDER: z.enum(['photon', 'google']).default('photon'),

  PHOTON_BASE_URL: z.string().url().default('https://photon.komoot.io'),

  // Every upstream call sits in the render path of a search box, so this is
  // short by design: a suggestion that arrives after the rider has typed three
  // more characters is worse than no suggestion at all.
  PLACES_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2500),

  // Autocomplete fires per keystroke and prefixes repeat constantly, both for
  // one rider and across a city. Ten minutes turns a whole city's typing of
  // "king" into one upstream call.
  PLACES_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),

  // A place's coordinates do not move. Cached for a day so booking the same
  // saved destination repeatedly is not re-billed on the paid provider.
  PLACES_RESOLVE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(604_800)
    .default(86_400),

  // Below three characters every provider returns noise, and the request is
  // pure cost. Enforced server-side so a client bug cannot bypass it.
  PLACES_MIN_QUERY_LENGTH: z.coerce.number().int().min(2).max(8).default(3),

  PLACES_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(8),

  // Comma-separated ISO-3166-1 alpha-2. Empty means worldwide. This is a bias
  // and a light filter, never a hard restriction on an exact match.
  PLACES_COUNTRIES: z.string().default('ca'),
});

export interface PlacesConfig {
  provider: 'photon' | 'google';
  timeoutMs: number;
  cacheTtlSeconds: number;
  resolveCacheTtlSeconds: number;
  minQueryLength: number;
  maxResults: number;
  countries: readonly string[];
}

function loadPlacesConfig(): PlacesConfig & { photonBaseUrl: string } {
  const parsed = PlacesEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`[uride-api] Invalid places configuration:\n${issues.join('\n')}`);
  }
  const env = parsed.data;
  return {
    provider: env.PLACES_PROVIDER,
    photonBaseUrl: env.PHOTON_BASE_URL,
    timeoutMs: env.PLACES_TIMEOUT_MS,
    cacheTtlSeconds: env.PLACES_CACHE_TTL_SECONDS,
    resolveCacheTtlSeconds: env.PLACES_RESOLVE_CACHE_TTL_SECONDS,
    minQueryLength: env.PLACES_MIN_QUERY_LENGTH,
    maxResults: env.PLACES_MAX_RESULTS,
    countries: env.PLACES_COUNTRIES.split(',')
      .map((c) => c.trim())
      .filter((c) => c.length === 2),
  };
}

/**
 * Address search. Swapping providers is an environment variable, not a deploy
 * of new code — the same shape as MAPS_PROVIDER and DOCUMENT_STORAGE_DRIVER.
 */
@Module({
  controllers: [PlacesController],
  providers: [
    {
      provide: GeocodingProvider,
      inject: [],
      useFactory: (): GeocodingProvider => {
        const config = loadPlacesConfig();
        if (config.provider === 'google') {
          const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
          // Booting google-without-a-key would look healthy and return an empty
          // list for every search, which reads as "no results" rather than
          // "misconfigured". Refuse instead.
          if (apiKey.length === 0) {
            throw new Error(
              '[uride-api] PLACES_PROVIDER=google requires GOOGLE_MAPS_API_KEY. ' +
                'Use PLACES_PROVIDER=photon for the free provider.',
            );
          }
          return new GooglePlacesProvider(apiKey, config.timeoutMs);
        }
        return new PhotonProvider(config.photonBaseUrl, config.timeoutMs, config.maxResults);
      },
    },
    {
      provide: GeocodingService,
      inject: [RedisService, GeocodingProvider],
      useFactory: (redis: RedisService, provider: GeocodingProvider): GeocodingService =>
        new GeocodingService(redis, provider, loadPlacesConfig()),
    },
  ],
  exports: [GeocodingService],
})
export class PlacesModule {}
