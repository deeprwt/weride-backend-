import { Module } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module';
import { DriverDocumentsService } from './driver-documents.service';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

/**
 * Driver lifecycle — onboarding, documents, vehicles, online/offline, location.
 * Phase 2 implementation.
 *
 * GeoModule is the only import: PrismaModule and StorageModule are both @Global,
 * so PrismaService and the DocumentStorage port arrive without being named here.
 * GeoService is not global on purpose — every PostGIS write in the platform goes
 * through it, and an explicit import is what keeps that list short enough to
 * audit.
 *
 * Both services are exported because the admin KYC queue reviews exactly what
 * this module writes, and the matcher needs the same availability rules the
 * driver app is held to.
 */
@Module({
  imports: [GeoModule],
  controllers: [DriversController],
  providers: [DriversService, DriverDocumentsService],
  exports: [DriversService, DriverDocumentsService],
})
export class DriversModule {}
