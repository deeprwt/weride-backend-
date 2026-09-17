import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PerUserRateLimitGuard,
  RateLimitPerUser,
} from '../../common/throttler/per-user-rate-limit.guard';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { DriverAvailability, DriverDocument, DriverMe, Vehicle } from '@uride/types';
import {
  documentUploadMetaSchema,
  driverApplySchema,
  driverDocumentTypeSchema,
  driverProfileUpdateSchema,
  goOnlineSchema,
  locationPingBatchSchema,
  locationPingSchema,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  DRIVER_DOCUMENT_MAX_BYTES,
  DRIVER_DOCUMENT_MIME_TYPES,
  type DocumentUploadMetaInput,
  type DriverApplyInput,
  type DriverProfileUpdateInput,
  type GoOnlineInput,
  type LocationPingBatchInput,
  type LocationPingInput,
  type VehicleCreateInput,
  type VehicleUpdateInput,
} from '@uride/validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverDocumentsService, type UploadedDocumentFile } from './driver-documents.service';
import { DriversService, type LocationAck } from './drivers.service';

/**
 * The driver app's own API surface. Everything here is scoped to the caller.
 *
 * Deliberately not @Roles('driver'): POST /apply is what grants that role, and
 * the applicant's access token was minted before it existed, so it only appears
 * after the next refresh. Gating these routes on the role would leave a driver
 * unable to upload a licence until they signed in again. Authorisation is by the
 * caller's own id instead — no route accepts a driver id from the request.
 */
@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly documents: DriverDocumentsService,
  ) {}

  // -------------------------------------------------------------------------
  // Application + profile
  // -------------------------------------------------------------------------

  /** Apply to drive: creates the profile and grants the `driver` role. */
  @Post('apply')
  async apply(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(driverApplySchema)) body: DriverApplyInput,
  ): Promise<DriverMe> {
    return this.drivers.apply(principal.userId, body);
  }

  /** Everything the driver app's home screen renders, in one call. */
  @Get('me')
  async me(@CurrentUser() principal: RequestPrincipal): Promise<DriverMe> {
    return this.drivers.me(principal.userId);
  }

  /** Correct licence details on an existing application. */
  @Patch('me')
  async updateProfile(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(driverProfileUpdateSchema)) body: DriverProfileUpdateInput,
  ): Promise<DriverMe> {
    return this.drivers.updateProfile(principal.userId, body);
  }

  /**
   * Hand the application to the review team.
   *
   * 200, not 201: this moves an application the driver already owns through its
   * state machine rather than creating anything.
   */
  @Post('me/submit')
  @HttpCode(HttpStatus.OK)
  async submit(@CurrentUser() principal: RequestPrincipal): Promise<DriverMe> {
    return this.drivers.submit(principal.userId);
  }

  // -------------------------------------------------------------------------
  // Vehicle
  // -------------------------------------------------------------------------

  /** Register the car this driver drives. */
  @Post('me/vehicle')
  async registerVehicle(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(vehicleCreateSchema)) body: VehicleCreateInput,
  ): Promise<Vehicle> {
    return this.drivers.registerVehicle(principal.userId, body);
  }

  /** Edit it. A real change to an approved vehicle sends it back for re-approval. */
  @Patch('me/vehicle')
  async updateVehicle(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(vehicleUpdateSchema)) body: VehicleUpdateInput,
  ): Promise<Vehicle> {
    return this.drivers.updateVehicle(principal.userId, body);
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Upload a KYC document, replacing any earlier upload of the same type.
   *
   * The multer limit is not redundant with the one DocumentStorage enforces: it
   * aborts an oversized upload at the socket, where the alternative is buffering
   * an arbitrary number of megabytes into this process before anything gets to
   * reject them.
   */
  @Post('me/documents')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: { type: 'string', enum: [...driverDocumentTypeSchema.options] },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Neither `dest` nor `storage`, which is how multer is told to keep the
      // file in memory. DocumentStorage.put wants the whole buffer anyway — it
      // hashes and magic-byte-sniffs the bytes before they are allowed to land,
      // so staging them on this container's disk first would only widen the
      // window in which an unreviewed ID scan sits somewhere nobody sweeps.
      limits: { fileSize: DRIVER_DOCUMENT_MAX_BYTES, files: 1 },
    }),
  )
  async uploadDocument(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(documentUploadMetaSchema)) body: DocumentUploadMetaInput,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ): Promise<DriverDocument> {
    return this.documents.upload(principal.userId, body, file);
  }

  /** The driver's own documents and their review state. */
  @Get('me/documents')
  async listDocuments(@CurrentUser() principal: RequestPrincipal): Promise<DriverDocument[]> {
    return this.documents.list(principal.userId);
  }

  /**
   * Stream one document back.
   *
   * ParseUUIDPipe matters beyond tidiness: without it a non-UUID id reaches
   * Postgres, which rejects the cast with 22P02 and surfaces as a 500 instead of
   * a 400. Ownership is checked in the service — see the note there on RLS.
   */
  @Get('me/documents/:id/file')
  @ApiProduces(...DRIVER_DOCUMENT_MIME_TYPES)
  async downloadDocument(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    return this.documents.openForDownload(principal.userId, id);
  }

  // -------------------------------------------------------------------------
  // Availability + location
  // -------------------------------------------------------------------------

  /** Join the dispatch pool. Refused with the go-online checklist when not eligible. */
  @Post('me/online')
  @HttpCode(HttpStatus.OK)
  async goOnline(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(goOnlineSchema)) body: GoOnlineInput,
  ): Promise<DriverAvailability> {
    return this.drivers.goOnline(principal.userId, body);
  }

  /** Leave the dispatch pool. Refused while a trip is in progress. */
  @Post('me/offline')
  @HttpCode(HttpStatus.OK)
  async goOffline(@CurrentUser() principal: RequestPrincipal): Promise<DriverAvailability> {
    return this.drivers.goOffline(principal.userId);
  }

  /**
   * One live position. The hottest write in the platform.
   *
   * Keyed per driver, not per IP: the global throttler's IP bucket is shared by
   * every driver behind one carrier NAT or ingress, so it would have honest
   * drivers throttling each other. 120/min allows the app's ~1 Hz cadence plus
   * headroom for retries.
   */
  @Post('me/location')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PerUserRateLimitGuard)
  @RateLimitPerUser({ bucket: 'location-ping', limit: 120, windowSeconds: 60 })
  async ping(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(locationPingSchema)) body: LocationPingInput,
  ): Promise<LocationAck> {
    return this.drivers.recordPing(principal.userId, body);
  }

  /**
   * Flush the positions the app buffered through a connectivity gap, oldest
   * first. Far rarer than the single ping and up to 100 points per call, so it
   * gets its own, much tighter bucket.
   */
  @Post('me/location/batch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PerUserRateLimitGuard)
  @RateLimitPerUser({ bucket: 'location-ping-batch', limit: 12, windowSeconds: 60 })
  async pingBatch(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(locationPingBatchSchema)) body: LocationPingBatchInput,
  ): Promise<LocationAck> {
    return this.drivers.recordPingBatch(principal.userId, body);
  }
}
