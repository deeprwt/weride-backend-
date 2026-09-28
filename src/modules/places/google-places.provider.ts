import { Logger } from '@nestjs/common';
import {
  GeocodingProvider,
  type AutocompleteQuery,
  type PlaceSuggestion,
  type ResolvedPlace,
} from './geocoding.types';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const REVERSE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Google Places — the paid path, for when OSM's coverage of shops and
 * businesses is not good enough.
 *
 * Two cost properties drive this implementation:
 *
 * 1. **Sessions, not keystrokes.** Autocomplete is billed per session when a
 *    session token is supplied and per request when it is not. Typing fifteen
 *    characters is one billable unit or fifteen, decided entirely by whether
 *    this header is set — so the token is threaded through from the client and
 *    passed verbatim. A session ends at the Details call, which is why the same
 *    token must accompany `resolve()`.
 *
 * 2. **Coordinates are a second call.** Autocomplete returns a place id, not a
 *    point. Fetching Details per suggestion per keystroke would multiply the
 *    bill by the length of the list; so suggestions come back with null
 *    coordinates and exactly one Details call happens, on selection.
 *
 * The field mask is as narrow as the API allows, because Details is billed by
 * SKU tier and the tier is set by the most expensive field requested. Asking
 * for `location` and `displayName` keeps it in the cheapest tier; adding
 * something like `reviews` would silently move every lookup up a tier.
 *
 * The key travels in a header, never a query string, and is never logged.
 */
export class GooglePlacesProvider extends GeocodingProvider {
  readonly name = 'google';
  private readonly logger = new Logger(GooglePlacesProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    const body: Record<string, unknown> = {
      input: query.query,
      languageCode: query.language,
    };
    if (query.sessionToken) body.sessionToken = query.sessionToken;
    if (query.countries.length > 0) {
      // Google caps this list; more than five is rejected outright.
      body.includedRegionCodes = query.countries.slice(0, 5).map((c) => c.toLowerCase());
    }
    if (query.lat !== null && query.lng !== null) {
      body.locationBias = {
        circle: { center: { latitude: query.lat, longitude: query.lng }, radius: 30_000 },
      };
    }

    let response: Response;
    try {
      response = await fetch(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
          'x-goog-fieldmask':
            'suggestions.placePrediction.placeId,' +
            'suggestions.placePrediction.structuredFormat',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Places autocomplete failed: ${describe(error)}`);
      return [];
    }
    if (!response.ok) {
      // Status only: Google echoes the request, including the input, in errors.
      this.logger.warn(`Places autocomplete responded ${response.status}`);
      await response.body?.cancel().catch(() => undefined);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return [];
    }
    return parseSuggestions(parsed);
  }

  async resolve(id: string, sessionToken: string | null): Promise<ResolvedPlace | null> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) return null;

    const url = new URL(`${DETAILS_URL}/${id}`);
    if (sessionToken) url.searchParams.set('sessionToken', sessionToken);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'x-goog-api-key': this.apiKey,
          'x-goog-fieldmask': 'id,location,displayName,formattedAddress',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Place details failed: ${describe(error)}`);
      return null;
    }
    if (!response.ok) {
      this.logger.warn(`Place details responded ${response.status}`);
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return null;
    }
    return parseDetails(id, parsed);
  }

  /**
   * Reverse geocoding is the classic Geocoding API, not Places — a separate
   * billable SKU. It fires on every map settle, so the service caches it hard
   * on a rounded coordinate; without that, dragging the pin would bill a
   * request per frame.
   */
  async reverse(lat: number, lng: number, language: string): Promise<string | null> {
    const url = new URL(REVERSE_URL);
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('language', language);
    url.searchParams.set('key', this.apiKey);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        this.logger.warn(`Reverse geocode responded ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.results) || body.results.length === 0) {
        return null;
      }
      const first: unknown = body.results[0];
      const formatted = isRecord(first) ? str(first.formatted_address) : '';
      return formatted.length > 0 ? formatted : null;
    } catch (error) {
      this.logger.warn(`Reverse geocode failed: ${describe(error)}`);
      return null;
    }
  }
}

function parseSuggestions(body: unknown): PlaceSuggestion[] {
  if (!isRecord(body) || !Array.isArray(body.suggestions)) return [];

  const out: PlaceSuggestion[] = [];
  for (const entry of body.suggestions) {
    if (!isRecord(entry)) continue;
    const prediction = isRecord(entry.placePrediction) ? entry.placePrediction : null;
    if (!prediction) continue;

    const placeId = str(prediction.placeId);
    if (!placeId) continue;

    const format = isRecord(prediction.structuredFormat) ? prediction.structuredFormat : {};
    const primaryText = textOf(format.mainText);
    if (!primaryText) continue;

    out.push({
      id: placeId,
      primaryText,
      secondaryText: textOf(format.secondaryText),
      // Deliberately null: see the class comment. Resolved once, on selection.
      lat: null,
      lng: null,
    });
  }
  return out;
}

function parseDetails(id: string, body: unknown): ResolvedPlace | null {
  if (!isRecord(body)) return null;
  const location = isRecord(body.location) ? body.location : null;
  const lat = typeof location?.latitude === 'number' ? location.latitude : null;
  const lng = typeof location?.longitude === 'number' ? location.longitude : null;
  if (lat === null || lng === null) return null;

  const name = textOf(body.displayName);
  const formatted = str(body.formattedAddress);
  const label = name && formatted ? `${name}, ${formatted}` : name || formatted;
  if (!label) return null;

  return { id, label, lat, lng };
}

/** Google wraps display strings as `{ text: string }` in the v1 API. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isRecord(value) && typeof value.text === 'string') return value.text.trim();
  return '';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
