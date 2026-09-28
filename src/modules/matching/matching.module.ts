import { Module, forwardRef } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module';
import { PricingModule } from '../pricing/pricing.module';
import { RideStateService } from '../rides/ride-state.service';
import { RidesModule } from '../rides/rides.module';
import { DispatchWorker } from './dispatch.worker';
import { MatchingService, RIDE_STATE_PORT, type RideStatePort } from './matching.service';

/**
 * Matching / dispatch engine — candidate search, offer waves, accept/decline,
 * and the loop that drives them.
 *
 * This module is *the* future Go-extraction candidate (ARCHITECTURE.md §8), so
 * its dependency list is the thing to keep honest. It takes exactly three:
 * GeoModule, Redis for locks and realtime fan-out (@Global, like Prisma), and
 * the rides state machine — which arrives through a port rather than as a class
 * reference inside MatchingService, so the only file in this module that knows
 * the rides module exists is this one. When dispatch becomes a Go service, the
 * binding below becomes an RPC client and nothing in matching.service.ts
 * changes.
 *
 * GeoModule supplies two things. H3DriverIndexService is where candidates come
 * from: a wave reads the H3 hexagons around the pickup out of Redis rather than
 * running a PostGIS radius query, and it tells the index when an accept takes a
 * driver out of the pool. GeoService is left with the one spatial read dispatch
 * still makes against Postgres — the pickup distance at accept time. The index
 * is a documented Redis key layout rather than an in-process structure, so a Go
 * dispatcher reads the same keys the Node one does.
 *
 * The binding is a typed factory rather than `useExisting` on purpose: the
 * return type makes the compiler check that RideStateService still satisfies
 * RideStatePort. A `useExisting` alias is untyped, so a signature change in the
 * rides module would pass the build and fail at runtime, mid-accept, with a
 * rider in the car.
 *
 * forwardRef because the two modules are two halves of one flow: dispatch moves
 * rides, and the ride lifecycle (a rider cancelling, a driver ending a trip)
 * has to withdraw offers. Declaring it now costs nothing and means whichever
 * direction the second edge is added, DI still resolves at boot.
 */
@Module({
  imports: [GeoModule, PricingModule, forwardRef(() => RidesModule)],
  providers: [
    MatchingService,
    // Registered, not exported: the worker is a background task with no
    // callers, and it lives here because the loop it drives is this module's.
    // Without it, offers never expire and a ride that nobody accepted stays
    // `searching` until the rider gives up.
    DispatchWorker,
    {
      provide: RIDE_STATE_PORT,
      inject: [RideStateService],
      useFactory: (state: RideStateService): RideStatePort => state,
    },
  ],
  exports: [MatchingService],
})
export class MatchingModule {}
