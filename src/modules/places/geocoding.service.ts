import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.module';
import { GeocodingProvider, type PlaceSuggestion, type ResolvedPlace } from './geocoding.types';
import type { PlacesConfig } from './places.module';

/**
 * GeocodingService — the app's only route to address search.
 *
 * It exists because the rider app used to call a geocoder straight from the
 * phone. That arrangement had no cache, no way to change provider without
 * shipping a new build, and — the day a paid provider is enabled — would have
 * put an API key in an artifact anyone can unzip.
 *
 * Cost control is the whole point of the cache. Autocomplete fires per
 * keystroke, so the same prefixes recur constantly, both within one rider's
 * typing and across every rider in a city ("king", "kin", "ki"). Caching on the
 * normalised query plus a coarse location bucket collapses all of that into one
 * upstream call per distinct prefix per TTL.
 *
 * Failure is always an empty list, never an exception. A geocoder being slow or
 * rate-limited must degrade the suggestion list, not break the search screen —
 * the rider can still pick their point on the map.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  /**
   * Collapses identical in-flight queries within one process. Two riders typing
   * the same prefix in the same second should cost one upstream call, not two;
   * the cache only helps once the first response has landed.
   */
  private readonly inFlight = new Map<string, Promise<PlaceSuggestion[]>>();

  constructor(
    private readonly redis: RedisService,
    private readonly provider: GeocodingProvider,
    private readonly config: PlacesConfig,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async autocomplete(input: {
    query: string;
    lat: number | null;
    lng: number | null;
    sessionToken: string | null;
    language: string;
  }): Promise<PlaceSuggestion[]> {
    const normalised = normaliseQuery(input.query);
    if (normalised.length < this.config.minQueryLength) return [];

    const key = cacheKey(this.provider.name, normalised, input.lat, input.lng);

    const cached = await this.readCache(key);
    if (cached) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = this.fetchAndCache(key, {
      query: input.query.trim(),
      lat: input.lat,
      lng: input.lng,
      sessionToken: input.sessionToken,
      language: input.language,
      countries: this.config.countries,
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, lookup);
    return lookup;
  }

  /**
   * Turn a chosen suggestion into a point.
   *
   * Providers that return coordinates inline never reach here — the client
   * already has what it needs. For those that do not, this is the one billed
   * lookup per search session, which is why it happens on selection rather than
   * per row of the list.
   */
  async resolve(id: string, sessionToken: string | null): Promise<ResolvedPlace | null> {
    const key = `uride:place:resolve:v1:${this.provider.name}:${id}`;
    try {
      const raw = await this.redis.client.get(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (isResolved(parsed)) return parsed;
      }
    } catch (error) {
      this.logger.debug(`Resolve cache read failed: ${describe(error)}`);
    }

    let resolved: ResolvedPlace | null;
    try {
      resolved = await this.provider.resolve(id, sessionToken);
    } catch (error) {
      this.logger.warn(`Place resolve failed: ${describe(error)}`);
      return null;
    }
    if (!resolved) return null;

    try {
      // A place's coordinates are effectively immutable, so this is cached far
      // longer than a suggestion list: the same saved destination should not be
      // re-billed every time someone books it.
      await this.redis.client.set(
        key,
        JSON.stringify(resolved),
        'EX',
        this.config.resolveCacheTtlSeconds,
      );
    } catch (error) {
      this.logger.debug(`Resolve cache write failed: ${describe(error)}`);
    }
    return resolved;
  }

  /**
   * Reverse geocode, cached hard on a rounded point.
   *
   * This fires on every map settle, so the pin drag that used to bill (or
   * rate-limit) a request per frame now collapses onto ~11 m buckets. Rounding
   * to four decimals is deliberate: finer would miss the cache on every frame
   * of a drag, coarser would label the wrong side of a street.
   */
  async reverse(lat: number, lng: number, language: string): Promise<string | null> {
    const key = `uride:place:rev:v1:${this.provider.name}:${lat.toFixed(4)},${lng.toFixed(4)}:${language}`;
    try {
      const cached = await this.redis.client.get(key);
      if (cached !== null && cached.length > 0) return cached;
    } catch (error) {
      this.logger.debug(`Reverse cache read failed: ${describe(error)}`);
    }

    let label: string | null;
    try {
      label = await this.provider.reverse(lat, lng, language);
    } catch (error) {
      this.logger.warn(`Reverse geocode failed: ${describe(error)}`);
      return null;
    }
    if (!label) return null;

    try {
      await this.redis.client.set(key, label, 'EX', this.config.resolveCacheTtlSeconds);
    } catch (error) {
      this.logger.debug(`Reverse cache write failed: ${describe(error)}`);
    }
    return label;
  }

  private async fetchAndCache(
    key: string,
    query: Parameters<GeocodingProvider['autocomplete']>[0],
  ): Promise<PlaceSuggestion[]> {
    let suggestions: PlaceSuggestion[];
    try {
      suggestions = await this.provider.autocomplete(query);
    } catch (error) {
      // Providers are written not to throw; this is belt and braces so a bug in
      // one cannot take down the search screen.
      this.logger.warn(`Autocomplete failed: ${describe(error)}`);
      return [];
    }

    // Empty results are NOT cached. A zero-result response is usually a
    // transient failure — a rate limit, a timeout — and caching it would pin
    // "no results" in front of every rider typing that prefix for the whole TTL.
    if (suggestions.length === 0) return [];

    try {
      await this.redis.client.set(
        key,
        JSON.stringify(suggestions),
        'EX',
        this.config.cacheTtlSeconds,
      );
    } catch (error) {
      this.logger.debug(`Autocomplete cache write failed: ${describe(error)}`);
    }
    return suggestions;
  }

  private async readCache(key: string): Promise<PlaceSuggestion[] | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const rows = parsed.filter(isSuggestion);
      return rows.length > 0 ? rows : null;
    } catch (error) {
      this.logger.debug(`Autocomplete cache read failed: ${describe(error)}`);
      return null;
    }
  }
}

/**
 * Case and whitespace folded so "King St", "king st" and "king  st" share one
 * entry. Not accent-folded: in fr-CA "Montreal" and "Montréal" can rank
 * differently, and collapsing them would serve the wrong list.
 */
function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Location is bucketed to ~11 km. Fine enough that a Toronto rider and an
 * Ottawa rider typing "king st" get separately-biased lists, coarse enough that
 * moving down the street does not miss the cache.
 */
function cacheKey(
  provider: string,
  normalised: string,
  lat: number | null,
  lng: number | null,
): string {
  const bucket =
    lat === null || lng === null ? 'anywhere' : `${lat.toFixed(1)},${lng.toFixed(1)}`;
  // Hashed rather than inlined: a raw query can contain anything a keyboard
  // produces, including the ':' this key is delimited with.
  return `uride:place:ac:v1:${provider}:${bucket}:${hash(normalised)}`;
}

/** FNV-1a. Not cryptographic — this only has to avoid collisions in a cache. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function isSuggestion(value: unknown): value is PlaceSuggestion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.primaryText === 'string' &&
    typeof v.secondaryText === 'string' &&
    (v.lat === null || typeof v.lat === 'number') &&
    (v.lng === null || typeof v.lng === 'number')
  );
}

function isResolved(value: unknown): value is ResolvedPlace {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.lat === 'number' &&
    typeof v.lng === 'number'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
