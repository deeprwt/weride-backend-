import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  quoteRequestSchema,
  rideCancelSchema,
  rideRequestSchema,
  type QuoteRequestInput,
  type RideCancelInput,
  type RideRequestInput,
} from '@uride/validation';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { RidesService } from './rides.service';

@ApiTags('rides')
@ApiBearerAuth()
@Controller('rides')
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  /** Fare estimate for a pickup -> dropoff trip (no ride created). */
  @Post('quote')
  async quote(@Body(new ZodValidationPipe(quoteRequestSchema)) body: QuoteRequestInput) {
    return this.rides.quote(body);
  }

  /** Request a ride. */
  @Post()
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(rideRequestSchema)) body: RideRequestInput,
  ) {
    return this.rides.create(principal.userId, body);
  }

  /** The signed-in rider's recent rides. */
  @Get()
  async list(@CurrentUser() principal: RequestPrincipal) {
    return this.rides.listMine(principal.userId);
  }

  /**
   * A single ride (must belong to the caller).
   *
   * ParseUUIDPipe matters here beyond tidiness: without it a non-UUID id
   * reaches Postgres, which rejects the cast with 22P02 and surfaces as an
   * unhandled 500 rather than a 400.
   */
  @Get(':id')
  async getOne(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rides.get(principal.userId, id);
  }

  /** Cancel a non-terminal ride. */
  @Post(':id/cancel')
  async cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rideCancelSchema)) body: RideCancelInput,
  ) {
    return this.rides.cancel(principal.userId, id, body);
  }
}
