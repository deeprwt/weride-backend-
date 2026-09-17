import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  adminDriverListQuerySchema,
  approvalSchema,
  documentReviewSchema,
  rejectionSchema,
  suspensionSchema,
  type AdminDriverListQueryInput,
  type ApprovalInput,
  type DocumentReviewInput,
  type RejectionInput,
  type SuspensionInput,
} from '@uride/validation';
import type {
  AdminDriverCounts,
  AdminDriverDetail,
  AdminDriverListPage,
} from '@uride/types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AdminDriversService } from './admin-drivers.service';

/**
 * The KYC review desk (/v1/admin/drivers).
 *
 * Role split across the whole controller: `support` may read the queue and an
 * application, because a support agent fielding "where is my approval" needs to
 * see where it is stuck — but every decision route is `admin` or `ops` only.
 * Support answers for the platform; it does not get to decide who drives on it.
 *
 * JwtAuthGuard and RolesGuard are APP_GUARDs, so nothing here declares a guard;
 * @Roles is the whole authorisation surface.
 */
@ApiTags('admin-drivers')
@ApiBearerAuth()
@Controller('admin/drivers')
export class AdminDriversController {
  constructor(private readonly drivers: AdminDriversService) {}

  /** The review queue: filter by KYC status, search by name / phone / email. */
  @Get()
  @Roles('admin', 'ops', 'support')
  async list(
    @Query(new ZodValidationPipe(adminDriverListQuerySchema)) query: AdminDriverListQueryInput,
  ): Promise<AdminDriverListPage> {
    return this.drivers.list(query);
  }

  /**
   * Badge counts for the queue tabs.
   *
   * Declared before `:id`. Express matches routes in declaration order, and the
   * other way round `/admin/drivers/counts` would be parsed as a driver id and
   * rejected by ParseUUIDPipe as a 400.
   */
  @Get('counts')
  @Roles('admin', 'ops', 'support')
  async counts(): Promise<AdminDriverCounts> {
    return this.drivers.counts();
  }

  /** One application in full: profile, vehicle, documents, live availability. */
  @Get(':id')
  @Roles('admin', 'ops', 'support')
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDriverDetail> {
    return this.drivers.detail(id);
  }

  /**
   * Stream a KYC document to the reviewer.
   *
   * Narrower than the rest of the read surface: `support` is excluded. The
   * detail view already tells an agent everything they need to answer a "what
   * is blocking me" ticket — which documents exist and what state each is in —
   * whereas this route returns the scan itself. Opening a stranger's passport
   * or licence should be limited to the people who actually decide on it.
   *
   * Served inline rather than as an attachment so reviewing a licence does not
   * leave a copy of it in every reviewer's Downloads folder.
   */
  @Get(':id/documents/:docId/file')
  @Roles('admin', 'ops')
  async openDocument(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ): Promise<StreamableFile> {
    const file = await this.drivers.openDocument(principal, id, docId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
      length: file.sizeBytes,
    });
  }

  /** Approve a driver. Refused unless documents, vehicle and licence all check out. */
  @Post(':id/approve')
  @Roles('admin', 'ops')
  async approve(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(approvalSchema)) body: ApprovalInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.approve(principal, id, body);
  }

  /** Reject an application. The reason is shown to the driver verbatim. */
  @Post(':id/reject')
  @Roles('admin', 'ops')
  async reject(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectionSchema)) body: RejectionInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.reject(principal, id, body);
  }

  /**
   * Suspend a driver and end any live session.
   *
   * Open to ops, not admin-only: suspension is the response to a safety report
   * arriving at 2 a.m., and an escalation path that has to wake an admin first
   * is one that leaves an unsafe driver taking fares in the meantime.
   */
  @Post(':id/suspend')
  @Roles('admin', 'ops')
  async suspend(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(suspensionSchema)) body: SuspensionInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.suspend(principal, id, body);
  }

  /**
   * Lift a suspension — `admin` only, and deliberately asymmetric with suspend.
   *
   * Stopping a driver fast is a safety decision anyone on the ops desk should
   * be able to take; putting one back on the road after a safety hold is a
   * decision that should cost a conversation with someone accountable for it.
   */
  @Post(':id/reinstate')
  @Roles('admin')
  async reinstate(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(approvalSchema)) body: ApprovalInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.reinstate(principal, id, body);
  }

  /** Approve or reject a single document. Never approves the driver — see the service. */
  @Post(':id/documents/:docId/review')
  @Roles('admin', 'ops')
  async reviewDocument(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body(new ZodValidationPipe(documentReviewSchema)) body: DocumentReviewInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.reviewDocument(principal, id, docId, body);
  }

  /**
   * Approve or reject a vehicle. Required before the driver can be approved at
   * all — approve() refuses anyone without an approved active vehicle, and this
   * is the only route that sets that status.
   */
  @Post(':id/vehicles/:vehicleId/review')
  @Roles('admin', 'ops')
  async reviewVehicle(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body(new ZodValidationPipe(documentReviewSchema)) body: DocumentReviewInput,
  ): Promise<AdminDriverDetail> {
    return this.drivers.reviewVehicle(principal, id, vehicleId, body);
  }
}
