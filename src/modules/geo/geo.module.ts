import { Module } from '@nestjs/common';
import { DriverHeartbeatSweeper } from './driver-heartbeat.sweeper';
import { GeoService } from './geo.service';
import { NearbyVehiclesService } from './nearby-vehicles.service';
import { NearbyVehiclesController } from './nearby-vehicles.controller';
import { H3DriverIndexService } from './h3-driver-index.service';
import { LocationFlushWorker } from './location-flush.worker';

/**
 * Geo & tracking — every PostGIS read and write in the platform sits behind
 * GeoService, and every live driver position behind H3DriverIndexService.
 *
 * No controller of its own: location endpoints belong to the surface that owns
 * them (drivers ping through DriversController, dispatch searches through the
 * matcher), so this module exists purely to hand its services to the modules
 * that need them. PrismaModule and RedisModule are @Global, so nothing needs
 * importing here.
 */
@Module({
  // The two background loops are registered here, not exported: they have no
  // callers. DriverHeartbeatSweeper drives GeoService.clearStaleDrivers, without
  // which stale drivers stay online forever. LocationFlushWorker is the only
  // thing that moves queued pings into Postgres — without it the trail is never
  // written and driver_availability's position columns stop moving, which the
  // sweeper would read as every driver going quiet.
  controllers: [NearbyVehiclesController],
  providers: [
    GeoService,
    H3DriverIndexService,
    DriverHeartbeatSweeper,
    LocationFlushWorker,
    NearbyVehiclesService,
  ],
  // H3DriverIndexService is exported for dispatch (searchNearby), surge
  // (countOnlineByCell), live ETA (get/getMany) and the modules that change a
  // driver's availability (upsert/setStatus/remove).
  exports: [GeoService, H3DriverIndexService, NearbyVehiclesService],
})
export class GeoModule {}
