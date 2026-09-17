import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { RideOffer, RideOfferForDriver } from '@uride/types';
import {
  driverArrivedSchema,
  driverCancelSchema,
  offerAcceptSchema,
  offerDeclineSchema,
  rideCompleteSchema,
  rideStartSchema,
  type DriverArrivedInput,
  type DriverCancelInput,
  type OfferAcceptInput,
  type OfferDeclineInput,
  type RideCompleteInput,
  type RideStartInput,
} from '@uride/validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import {
  PerUserRateLimitGuard,
  RateLimitPerUser,
} from '../../common/throttler/per-user-rate-limit.guard';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverRidesService, type AcceptedTrip } from './driver-rides.service';
import type { RideView } from './rides.service';

/**
 * The driver's side of a trip (/v1/driver/rides).
 *
 * Split from RidesController rather than folded into it with a role check per
 * handler, because the two surfaces are the same ride redacted differently and
 * moved by different actors. One controller would mean one file where the
 * rider's payload and the driver's payload are a branch apart — and the field
 * that separates them is the pickup code.
 *
 * `@Roles('driver')` sits on the class: every route here is a driver acting on
 * a trip that has already been assigned to them, so there is no equivalent of
 * DriversController's "you may not have the role yet" case. JwtAuthGuard and
 * RolesGuard are APP_GUARDs, so no route declares them; the role annotation is
 * the whole authorisation surface at this layer. Which ride a driver may touch
 * is not a role question and is enforced in the service — see the note there on
 * why RLS does not cover it.
 *
 * The POSTs answer 200, not 201: every one of them moves a ride that already
 * exists through its state machine. Nothing here creates a resource.
 */
@ApiTags('driver-rides')
@ApiBearerAuth()
@Roles('driver')
@Controller('driver/rides')
export class DriverRidesController {
  constructor(private readonly trips: DriverRidesService) {}

  // -------------------------------------------------------------------------
  // Offers
  //
  // Declared before the `:id` routes so the literal paths are matched first —
  // `offers` can never be read as a ride id.
  // -------------------------------------------------------------------------

  /**
   * The offer on the driver's screen right now, or null.
   *
   * Polled on launch and after every reconnect, so that an offer whose push or
   * socket frame was lost is still answerable. `secondsRemaining` is computed
   * server-side from the stored deadline — a device with a slow clock does not
   * get a longer countdown than everyone else.
   */
  @Get('offers/current')
  async currentOffer(
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<RideOfferForDriver | null> {
    return this.trips.currentOffer(principal.userId);
  }

  /**
   * Take the ride. The one endpoint in the platform where two callers race for
   * the same row; the winner is decided by a unique index, not by arriving here
   * first. A loser gets 409 `offer_already_taken`.
   */
  @Post('offers/:id/accept')
  @HttpCode(HttpStatus.OK)
  async acceptOffer(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(offerAcceptSchema)) body: OfferAcceptInput,
  ): Promise<AcceptedTrip> {
    return this.trips.acceptOffer(principal.userId, id, body);
  }

  /** Pass on the ride. The reason is kept — it feeds dispatch ranking. */
  @Post('offers/:id/decline')
  @HttpCode(HttpStatus.OK)
  async declineOffer(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(offerDeclineSchema)) body: OfferDeclineInput,
  ): Promise<RideOffer> {
    return this.trips.declineOffer(principal.userId, id, body);
  }

  // -------------------------------------------------------------------------
  // The trip
  // -------------------------------------------------------------------------

  /** The trip the driver is on, or null. The driver app's home screen. */
  @Get('current')
  async currentTrip(@CurrentUser() principal: RequestPrincipal): Promise<RideView | null> {
    return this.trips.currentTrip(principal.userId);
  }

  /** Recent trips, newest first. */
  @Get()
  async list(@CurrentUser() principal: RequestPrincipal): Promise<RideView[]> {
    return this.trips.listMine(principal.userId);
  }

  /**
   * At the pickup.
   *
   * ParseUUIDPipe matters beyond tidiness here: without it a non-UUID id
   * reaches Postgres, which rejects the cast with 22P02 and surfaces as an
   * unhandled 500 rather than a 400.
   */
  @Post(':id/arrived')
  @HttpCode(HttpStatus.OK)
  async arrived(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(driverArrivedSchema)) body: DriverArrivedInput,
  ): Promise<RideView> {
    return this.trips.markArrived(principal.userId, id, body);
  }

  /**
   * Start the trip, with the 4-digit code the rider reads out.
   *
   * Rate-limited per driver, which is the actual control on a 10,000-value
   * secret — the check itself can only ever say yes or no. 10 attempts per 5
   * minutes puts an exhaustive search at roughly three and a half days of
   * uninterrupted guessing against a code that is spent the moment its trip
   * starts, while leaving room for a driver who fat-fingers a digit two or
   * three times on a genuinely bad connection.
   *
   * Keyed on the user, not the IP: a driver sitting on carrier NAT shares an
   * address with hundreds of others, and an IP bucket would either be useless
   * or would have honest drivers locking each other out. The bucket is separate
   * from the location-ping one so that a chatty GPS cannot consume the
   * allowance that guards the code, and vice versa.
   *
   * Every failed attempt is also recorded as a `ride_event`, so ops can see a
   * driver who keeps guessing even while each individual request stays inside
   * the limit.
   */
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PerUserRateLimitGuard)
  @RateLimitPerUser({ bucket: 'ride-start-otp', limit: 10, windowSeconds: 300 })
  async start(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rideStartSchema)) body: RideStartInput,
  ): Promise<RideView> {
    return this.trips.startTrip(principal.userId, id, body);
  }

  /** End the trip: stamps the completion, frees the driver, counts the ride. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rideCompleteSchema)) body: RideCompleteInput,
  ): Promise<RideView> {
    return this.trips.complete(principal.userId, id, body);
  }

  /**
   * Give the trip up before it starts — a no-show rider, a vehicle problem, a
   * pickup that cannot be reached. Refused once the trip is under way: that is
   * a support case, not a driver-side undo.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(driverCancelSchema)) body: DriverCancelInput,
  ): Promise<RideView> {
    return this.trips.cancel(principal.userId, id, body);
  }
}
