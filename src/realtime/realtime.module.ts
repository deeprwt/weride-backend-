import { Module } from '@nestjs/common';
import { IdentityProviderModule } from '../common/identity/identity.module';
import { SessionModule } from '../common/session/session.module';
import { GeoModule } from '../modules/geo/geo.module';
import { DispatchBridgeService } from './dispatch-bridge.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Realtime module — the `/rt` socket namespace and the publish API in front of
 * it.
 *
 * Still structured to be lifted into its own `apps/realtime` process when load
 * demands it, but the Phase 0 boundary ("no Prisma, no domain modules") did not
 * survive contact with an authenticated gateway, and pretending otherwise would
 * have meant trusting the client. The dependencies it grew, and why each one is
 * the cheapest form of itself:
 *
 *  - **IdentityProviderModule + SessionModule** — a socket has to prove who it
 *    is with the same token, the same verifier and the same denylist as a REST
 *    call. Any second implementation would be a weaker door into the same
 *    house.
 *  - **Prisma** (@Global, so nothing is imported for it) — room membership is
 *    decided against the `rides` table. A client telling us which ride it is on
 *    is not evidence.
 *  - **GeoModule** — inbound location frames are persisted through GeoService,
 *    the single owner of spatial SQL. The alternative, a second PostGIS write
 *    path living in a gateway, is how axis-order bugs get in.
 *
 * Lifting this out later therefore means giving the realtime process a database
 * connection and the identity config, not rewriting it — and every domain
 * module still reaches it through RealtimeService, so none of them would notice
 * the move.
 */
@Module({
  imports: [IdentityProviderModule, SessionModule, GeoModule],
  // DispatchBridgeService is the subscriber half of the matcher's pub/sub seam:
  // MatchingService publishes offers to Redis and this forwards them to driver
  // sockets. Without it, offers reach a driver only if the app polls.
  providers: [RealtimeGateway, RealtimeService, DispatchBridgeService],
  // Only the publish API is exported. The gateway stays private so that no
  // domain module can start emitting through a raw socket.io server and quietly
  // become the second place that knows what a room is called.
  exports: [RealtimeService],
})
export class RealtimeModule {}
