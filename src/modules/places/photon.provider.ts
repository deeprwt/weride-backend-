import { Logger } from '@nestjs/common';
import {
  GeocodingProvider,
  type AutocompleteQuery,
  type PlaceSuggestion,
  type ResolvedPlace,
} from './geocoding.types';

/**
 * Photon — OpenStreetMap data served by a type-ahead engine.
 *
 * This is the free default, and it exists because the app previously called
 * Nominatim directly from the phone. Nominatim is a geocoder: it resolves
 * reasonably complete addresses. It does not do prefix or fuzzy matching, which
 * is why typing three characters of a place name returned nothing useful.
 * Photon indexes the same OSM data in Elasticsearch specifically for
 * autocomplete, so partial input ranks sensibly.
 *
 * It also ends a policy problem. Nominatim's usage terms forbid autocomplete
 * querying and cap roughly one request per second across all users of an app —
 * limits the old client-side implementation was already violating and would
 * have started failing under at launch.
 *
 * Coordinates arrive inline, so `resolve()` is a no-op. That matters for cost
 * on the Google path, where a selection costs a second billed call.
 *
 * Coverage is honest OSM coverage: strong on roads and localities, thinner on
 * individual businesses than a commercial index. Set PLACES_PROVIDER=google
 * when that gap matters more than the bill.
 */
export class PhotonProvider extends GeocodingProvider {
  readonly name = 'photon';
  private readonly logger = new Logger(PhotonProvider.name);

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly limit: number,
  ) {
    super();
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    const url = new URL('/api', this.baseUrl);
    url.searchParams.set('q', query.query);
    url.searchParams.set('limit', String(this.limit));
    url.searchParams.set('lang', photonLanguage(query.language));
    // Location bias, not a filter: a rider in Toronto searching "King St"
    // should see the local one first, but must still be able to find one in
    // Ottawa by typing more.
    //
    // `location_bias_scale` defaults to 0.2, which in testing was weak enough
    // that a query with no strong local match returned results on other
    // continents. 0.9 pulls hard toward the rider without hard-filtering.
    // It cannot conjure coverage: where OSM does not have the place, nothing
    // here helps, which is what PLACES_PROVIDER=google is for.
    if (query.lat !== null && query.lng !== null) {
      url.searchParams.set('lat', String(query.lat));
      url.searchParams.set('lon', String(query.lng));
      url.searchParams.set('location_bias_scale', '0.9');
      // Roughly city scale. Photon's default of 16 biases to street level,
      // which is too tight for "somewhere across town".
      url.searchParams.set('zoom', '12');
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Photon request failed: ${describe(error)}`);
      return [];
    }
    if (!response.ok) {
      this.logger.warn(`Photon responded ${response.status}`);
      return [];
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return [];
    }
    return parseFeatureCollection(body, query.countries);
  }

  /** Photon hands back coordinates with the suggestion, so nothing to resolve. */
  async resolve(): Promise<ResolvedPlace | null> {
    return null;
  }

  async reverse(lat: number, lng: number, language: string): Promise<string | null> {
    const url = new URL('/reverse', this.baseUrl);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('limit', '1');
    url.searchParams.set('lang', photonLanguage(language));

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const rows = parseFeatureCollection(await response.json(), []);
      if (rows.length === 0) return null;
      const [first] = rows;
      return first.secondaryText
        ? `${first.primaryText}, ${first.secondaryText}`
        : first.primaryText;
    } catch (error) {
      this.logger.warn(`Photon reverse failed: ${describe(error)}`);
      return null;
    }
  }
}

/** Photon takes a bare two-letter code; `en-CA` would be rejected. */
function photonLanguage(language: string): string {
  const base = language.slice(0, 2).toLowerCase();
  // Photon ships these indexes; anything else falls back to default naming.
  return ['en', 'fr', 'de', 'it'].includes(base) ? base : 'en';
}

function parseFeatureCollection(
  body: unknown,
  countries: readonly string[],
): PlaceSuggestion[] {
  if (!isRecord(body) || !Array.isArray(body.features)) return [];

  const wanted = countries.map((c) => c.toUpperCase());
  const out: PlaceSuggestion[] = [];

  for (const feature of body.features) {
    if (!isRecord(feature)) continue;
    const props = isRecord(feature.properties) ? feature.properties : {};
    const geometry = isRecord(feature.geometry) ? feature.geometry : {};
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    // GeoJSON is [lng, lat]. Reversing these silently puts Toronto in Somalia.
    const lng = typeof coords?.[0] === 'number' ? coords[0] : null;
    const lat = typeof coords?.[1] === 'number' ? coords[1] : null;
    if (lat === null || lng === null) continue;

    const country = typeof props.countrycode === 'string' ? props.countrycode.toUpperCase() : '';
    // A bias list that is set should still not hide an exact match the rider
    // typed in full, so this filters only when the provider told us the country.
    if (wanted.length > 0 && country.length > 0 && !wanted.includes(country)) continue;

    const primaryText = primaryOf(props);
    if (primaryText.length === 0) continue;

    out.push({
      id: suggestionId(props, lat, lng),
      primaryText,
      secondaryText: secondaryOf(props),
      lat,
      lng,
    });
  }
  return out;
}

/** The name if it has one, else the street line — never an empty row. */
function primaryOf(props: Record<string, unknown>): string {
  const name = str(props.name);
  if (name) return name;
  const street = str(props.street);
  const house = str(props.housenumber);
  if (street) return house ? `${house} ${street}` : street;
  return str(props.city) || str(props.state) || '';
}

/** Everything after the name, deduplicated and in widening order. */
function secondaryOf(props: Record<string, unknown>): string {
  const parts = [
    str(props.street) && str(props.name) ? str(props.street) : '',
    str(props.district),
    str(props.city),
    str(props.state),
    str(props.postcode),
    str(props.country),
  ].filter((p) => p.length > 0);

  const seen = new Set<string>();
  return parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true))).join(', ');
}

/**
 * Stable id from OSM identity when present, coordinates otherwise. Only used to
 * key list rows and to round-trip a selection, so collisions across distinct
 * places are the only thing that matters — and coordinates make those unlikely.
 */
function suggestionId(props: Record<string, unknown>, lat: number, lng: number): string {
  const type = str(props.osm_type);
  const id = props.osm_id;
  if (type && (typeof id === 'number' || typeof id === 'string')) return `osm:${type}${id}`;
  return `pt:${lat.toFixed(6)},${lng.toFixed(6)}`;
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
