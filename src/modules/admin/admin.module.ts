import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { GeoModule } from '../geo/geo.module';
import { RidesModule } from '../rides/rides.module';
import { AdminDriversController } from './admin-drivers.controller';
import { AdminDriversService } from './admin-drivers.service';
import { AdminRidesController } from './admin-rides.controller';
import { AdminRidesService } from './admin-rides.service';
import { AuditService } from './audit.service';

/**
 * Admin/ops surface. Phase 2 shipped the KYC review desk; Phase 3 adds the live
 * dispatch desk beside it. Fares, refunds and promos land here in Phases 4-6.
 *
 * StorageModule is @Global, so this import is not strictly required — it is
 * here because the dependency is real (reviewers stream KYC documents) and a
 * test that boots AdminModule alone should fail at wiring time rather than on
 * the first download. GeoModule is imported for the same reason: the driver
 * detail view needs a last position, the reassign picker needs the drivers near
 * a pickup, and `last_location` is a PostGIS column the Prisma client cannot
 * read.
 *
 * RidesModule is the important one. The dispatch desk moves rides, and it moves
 * them through RideStateService and RideEventsService exactly as the rider,
 * the driver and the matcher do — an ops override that wrote `rides.status`
 * itself would be a second implementation of the state machine, and the one
 * least likely to be tested. RealtimeModule is what makes an intervention
 * visible on the phones it affects before the next poll.
 *
 * AuditService is exported rather than kept private: every admin action — a KYC
 * decision, a forced reassignment, a fare override — owes the same compliance
 * trail, and they should all write it through one implementation.
 */
@Module({
  imports: [StorageModule, GeoModule, RidesModule, RealtimeModule],
  controllers: [AdminDriversController, AdminRidesController],
  providers: [AdminDriversService, AdminRidesService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
