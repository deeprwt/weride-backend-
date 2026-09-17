import { Module, forwardRef } from '@nestjs/common';
import { PricingClientModule } from '../../common/pricing-client/pricing-client.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { PricingModule } from '../pricing/pricing.module';
import { DriverRidesController } from './driver-rides.controller';
import { DriverRidesService } from './driver-rides.service';
import { RidesController } from './rides.controller';
import { RideEventsService } from './ride-events.service';
import { RideStateService } from './ride-state.service';
import { RidesService } from './rides.service';

/**
 * Ride lifecycle + booking flow. Phase 3.
 *
 * The state machine and the event log are exported alongside RidesService
 * because the dispatch loop, the driver trip endpoints and the realtime gateway
 * all move rides too. They must move them through the same service: a second
 * implementation of "what a ride may do next" is how two parts of the platform
 * end up disagreeing about whether a trip is still cancellable, and how a
 * status change ends up with no row in ride_events explaining it.
 *
 * Two controllers, one state machine. The rider's surface and the driver's are
 * the same rides seen from different seats — different actors, different legal
 * moves, and a redaction rule between them that decides who may read the pickup
 * code. Keeping them in one module is what lets them share RideStateService;
 * keeping them in separate files is what keeps the two payloads from being one
 * careless branch apart.
 *
 * MatchingModule is imported through forwardRef because dispatch and the ride
 * lifecycle are two halves of one flow and each needs the other: the matcher
 * moves rides through this module's state service, while the driver's trip
 * endpoints answer offers through the matcher. MatchingModule already declares
 * its half of the cycle; this is the other, and without it Nest cannot resolve
 * either at boot.
 */
@Module({
  // PricingModule supplies surge and road distance for every quote. It depends only on
  // GeoModule, so importing it here closes no cycle.
  imports: [PricingClientModule, PricingModule, RealtimeModule, forwardRef(() => MatchingModule)],
  controllers: [RidesController, DriverRidesController],
  providers: [RidesService, RideStateService, RideEventsService, DriverRidesService],
  // DriverRidesService is deliberately not exported: it is an HTTP surface for
  // one actor, and anything else that needs to move a ride should be reaching
  // for RideStateService instead.
  exports: [RidesService, RideStateService, RideEventsService],
})
export class RidesModule {}
