import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { rideClassSchema } from '@uride/validation';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { NearbyVehiclesService, type NearbyVehiclesResult } from './nearby-vehicles.service';

/**
 * Available vehicles around a point, for the rider's booking map.
 *
 * Authenticated, like every other rider route. An anonymous version of this
 * endpoint would publish the live position of the fleet to anyone who found the
 * URL — including to a competitor mapping supply, or to someone waiting to see
 * which corners have no cars on them.
 */
const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  /**
   * Filter to one class, so the map redraws when the rider switches between
   * Standard, XL and Premium and shows only the cars that could actually take
   * the trip. Omitted means every class.
   */
  rideClass: rideClassSchema.optional(),
  /**
   * Capped well below dispatch's 25 km ceiling: markers beyond a few kilometres
   * are off-screen at booking zoom, so a wider search is scan cost for pixels
   * nobody sees.
   */
  radiusMeters: z.coerce.number().int().min(500).max(8_000).default(4_000),
});

type NearbyQueryInput = z.infer<typeof nearbyQuerySchema>;

@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class NearbyVehiclesController {
  constructor(private readonly nearby: NearbyVehiclesService) {}

  /**
   * Always 200, with an empty list when nothing is around.
   *
   * "No cars nearby" is a real answer a rider needs to see, not an error — the
   * booking screen uses it to say so plainly instead of spinning.
   */
  @Get('nearby')
  async find(
    @Query(new ZodValidationPipe(nearbyQuerySchema)) query: NearbyQueryInput,
  ): Promise<NearbyVehiclesResult> {
    return this.nearby.find({
      lat: query.lat,
      lng: query.lng,
      rideClass: query.rideClass ?? null,
      radiusMeters: query.radiusMeters,
    });
  }
}
