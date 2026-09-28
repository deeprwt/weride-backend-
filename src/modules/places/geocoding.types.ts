/**
 * The shape the app consumes, independent of which provider produced it.
 *
 * Deliberately minimal. Providers disagree about almost everything —
 * Photon returns GeoJSON with coordinates inline, Google returns a place id and
 * makes you fetch coordinates separately — and every field beyond these would
 * be a field one of them cannot fill.
 */
export interface PlaceSuggestion {
  /**
   * Opaque handle for this suggestion. For providers that return coordinates
   * inline this is informational; for those that do not, it is what
   * `resolve()` takes to turn a suggestion into a point.
   */
  id: string;
  /** The name the rider is looking for: "Connaught Place", "12 King St W". */
  primaryText: string;
  /** Disambiguating context: locality, city, postcode. May be empty. */
  secondaryText: string;
  /**
   * Coordinates when the provider gave them for free.
   *
   * Null means the client must call resolve() on selection. That round trip is
   * the whole reason this field is nullable rather than required: forcing every
   * provider to supply coordinates up front would mean a details lookup per
   * suggestion per keystroke, which is the single most expensive way to build
   * autocomplete.
   */
  lat: number | null;
  lng: number | null;
}

/** A suggestion resolved to an actual point, ready to book against. */
export interface ResolvedPlace {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

export interface AutocompleteQuery {
  /** Raw user input. Already length-checked by the controller. */
  query: string;
  /** Bias results near the rider, when the app knows where they are. */
  lat: number | null;
  lng: number | null;
  /**
   * Groups a burst of keystrokes into one billable unit on providers that
   * price per session. Opaque to us; passed through verbatim.
   */
  sessionToken: string | null;
  /** ISO-639-1, for localised place names. */
  language: string;
  /** ISO-3166-1 alpha-2 list to bias or restrict to. Empty means worldwide. */
  countries: readonly string[];
}

/**
 * What every provider implements. Kept to two calls so adding a provider is a
 * small, obvious piece of work rather than an archaeology exercise.
 */
export abstract class GeocodingProvider {
  /** Ranked suggestions for a partial query. Must never throw; return [] instead. */
  abstract autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]>;

  /**
   * Turn a suggestion id into coordinates. Returns null when the provider
   * cannot resolve it, or when it never needed to because autocomplete already
   * carried the point.
   */
  abstract resolve(id: string, sessionToken: string | null): Promise<ResolvedPlace | null>;

  /**
   * Nearest human-readable address to a point, or null when the provider has
   * nothing. Used for the pickup label under the map pin.
   */
  abstract reverse(lat: number, lng: number, language: string): Promise<string | null>;

  /** For logs and the health payload. */
  abstract readonly name: string;
}
