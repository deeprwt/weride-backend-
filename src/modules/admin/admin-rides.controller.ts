import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  adminRideListQuerySchema,
  rideCancelSchema,
  rideReassignSchema,
  type AdminRideListQueryInput,
  type RideCancelInput,
  type RideReassignInput,
} from '@uride/validation';
import type { AdminRideDetail, AdminRideListPage } from '@uride/types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AdminRidesService } from './admin-rides.service';

/**
 * The live dispatch desk (/v1/admin/rides).
 *
 * Role split mirrors the KYC desk. `support` reads: an agent taking "my driver
 * never arrived" needs the ride's offer history and its event trail to answer
 * at all, and none of it is data they cannot already see on the ticket. Neither
 * intervention is theirs to take — support explains what happened, ops and
 * admin change it.
 *
 * JwtAuthGuard and RolesGuard are APP_GUARDs, so nothing here declares a guard;
 * @Roles is the whole authorisation surface.
 */
@ApiTags('admin-rides')
@ApiBearerAuth()
@Controller('admin/rides')
export class AdminRidesController {
  constructor(private readonly rides: AdminRidesService) {}

  /**
   * The board: one page of rides, filterable by status, rider or driver.
   *
   * `status` accepts either an exact ride status or one of the board's filter
   * names (`live`, `searching`, `unmatched`, `finished`, `cancelled`) — see
   * ADMIN_RIDE_FILTERS, which the dashboard's tabs are built from too.
   */
  @Get()
  @Roles('admin', 'ops', 'support')
  async list(
    @Query(new ZodValidationPipe(adminRideListQuerySchema)) query: AdminRideListQueryInput,
  ): Promise<AdminRideListPage> {
    return this.rides.list(query);
  }

  /** One ride in full: parties, every offer, and the whole event trail. */
  @Get(':id')
  @Roles('admin', 'ops', 'support')
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminRideDetail> {
    return this.rides.detail(id);
  }

  /**
   * Hand the ride to a different driver — `admin` only, and deliberately
   * narrower than cancel.
   *
   * Cancelling ends a ride that is already failing; reassigning reaches into a
   * live trip and moves a rider from one stranger's car to another's. That is a
   * decision someone accountable should be making, and the driver it takes the
   * ride from loses the fare.
   */
  @Post(':id/reassign')
  @Roles('admin')
  async reassign(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rideReassignSchema)) body: RideReassignInput,
  ): Promise<AdminRideDetail> {
    return this.rides.reassign(principal, id, body);
  }

  /**
   * End a ride on the platform's behalf.
   *
   * Open to ops, not admin-only, for the same reason suspension is: this is the
   * response to a rider stuck with a driver who will never arrive, at 2 a.m.,
   * and an escalation path that has to wake an admin first is one that leaves
   * them stuck for another twenty minutes.
   *
   * Takes the same `rideCancelSchema` the rider's own cancel does. The reasons
   * are the platform's existing cancellation vocabulary, and an ops cancellation
   * that could not be compared with a rider's own would be useless to the
   * refund and no-fault-cancellation reporting that reads these rows.
   */
  @Post(':id/cancel')
  @Roles('admin', 'ops')
  async cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rideCancelSchema)) body: RideCancelInput,
  ): Promise<AdminRideDetail> {
    return this.rides.cancel(principal, id, body);
  }
}
