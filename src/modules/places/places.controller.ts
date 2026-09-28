import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { GeocodingService } from './geocoding.service';
import type { PlaceSuggestion, ResolvedPlace } from './geocoding.types';

/**
 * Address search, proxied.
 *
 * Authenticated on purpose. Geocoding costs money on the paid provider and
 * carries a usage policy on the free one, so an open endpoint is somebody
 * else's free geocoder billed to us. It also inherits the global per-user rate
 * limit, which a client-side geocoder never had.
 */
const autocompleteQuerySchema = z.object({
  q: z.string().min(1).max(200),
  // Rider's position, for biasing. Optional: search must work before the first
  // GPS fix arrives, which is exactly when a rider is most likely to type.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  /**
   * Groups a burst of keystrokes into one billable session upstream. Opaque to
   * us; constrained only enough that it cannot be used to smuggle anything into
   * a provider's query string.
   */
  sessionToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/)
    .optional(),
  lang: z
    .string()
    .regex(/^[A-Za-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});

const resolveQuerySchema = z.object({
  id: z.string().min(1).max(512),
  sessionToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/)
    .optional(),
});

const reverseQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  lang: z
    .string()
    .regex(/^[A-Za-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});

type ReverseQueryInput = z.infer<typeof reverseQuerySchema>;
type AutocompleteQueryInput = z.infer<typeof autocompleteQuerySchema>;
type ResolveQueryInput = z.infer<typeof resolveQuerySchema>;

@ApiTags('places')
@ApiBearerAuth()
@Controller('places')
export class PlacesController {
  constructor(private readonly geocoding: GeocodingService) {}

  /**
   * Ranked suggestions for partial input.
   *
   * Always 200, even when the upstream provider is down — an empty list is a
   * legitimate answer to "what matches 'xyzzy'", and the rider can still drop a
   * pin on the map. Turning a provider outage into a 502 would take the whole
   * search screen down for something that degrades cleanly.
   */
  @Get('autocomplete')
  async autocomplete(
    @Query(new ZodValidationPipe(autocompleteQuerySchema)) query: AutocompleteQueryInput,
  ): Promise<{ provider: string; suggestions: PlaceSuggestion[] }> {
    const suggestions = await this.geocoding.autocomplete({
      query: query.q,
      lat: query.lat ?? null,
      lng: query.lng ?? null,
      sessionToken: query.sessionToken ?? null,
      language: query.lang ?? 'en',
    });
    return { provider: this.geocoding.providerName, suggestions };
  }

  /**
   * Street address nearest a point, for the pickup label under the map pin.
   *
   * `label` is null rather than 404 when nothing is found: the caller's job is
   * then to show the pin without an address, not to treat it as an error. The
   * old client-side version fell back to printing raw coordinates at the rider,
   * which is the one outcome worse than showing nothing.
   */
  @Get('reverse')
  async reverse(
    @Query(new ZodValidationPipe(reverseQuerySchema)) query: ReverseQueryInput,
  ): Promise<{ label: string | null }> {
    return { label: await this.geocoding.reverse(query.lat, query.lng, query.lang ?? 'en') };
  }

  /**
   * Coordinates for a chosen suggestion.
   *
   * Only needed for providers whose autocomplete omits them; the client skips
   * this call entirely when the suggestion already carried a point.
   */
  @Get('resolve')
  async resolve(
    @Query(new ZodValidationPipe(resolveQuerySchema)) query: ResolveQueryInput,
  ): Promise<ResolvedPlace> {
    const resolved = await this.geocoding.resolve(query.id, query.sessionToken ?? null);
    if (!resolved) {
      throw new NotFoundException({
        code: 'place_not_found',
        message: 'That place could not be found. Try searching again.',
      });
    }
    return resolved;
  }
}
