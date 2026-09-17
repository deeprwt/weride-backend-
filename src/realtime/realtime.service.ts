import { Injectable, Logger } from '@nestjs/common';
import {
  RT_SERVER_EVENTS,
  type RideOfferForDriver,
  type RideSummary,
  type RtDriverLocationPayload,
  type RtOfferRevokedPayload,
} from '@uride/types';
import { driverRoom, rideRoom, type RtNamespace } from './rt-auth';

/**
 * RealtimeService — the only way the rest of the backend reaches a client.
 *
 * Dispatch, the ride state machine and the admin tools all need to push
 * something to a phone, and none of them should know that the transport is
 * socket.io. They call these four methods; this class owns the rooms, the event
 * names and the failure policy. When realtime eventually moves into its own
 * process (see realtime.module.ts) this is the seam that changes — the callers
 * do not.
 *
 * Two properties every caller depends on, so they are stated rather than
 * implied:
 *
 *  - **Nothing here throws.** A ride transition has already committed by the
 *    time it is announced; a socket layer that is down, unbound or out of
 *    memory must not turn a completed trip into a 500 and a rolled-back
 *    request. Delivery is best-effort by design, and the apps reconcile with
 *    `GET /v1/rides/:id` on reconnect.
 *  - **It is safe with no clients connected.** Before the gateway binds its
 *    namespace, and for a room nobody has joined, every call is a no-op.
 *
 * Scale note: socket.io's default adapter is in-memory, so a `.to(room).emit()`
 * reaches only the sockets held by *this* process. Running more than one API
 * instance therefore needs a Redis (or equivalent) socket.io adapter wired into
 * the gateway — and this class is deliberately the only place that fans out, so
 * that change lands in one file rather than in every module that emits.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  /** Null until the gateway has initialised — see {@link bindServer}. */
  private server: RtNamespace | null = null;

  /**
   * Handed the live `/rt` namespace by RealtimeGateway.afterInit().
   *
   * The gateway pushes the server here rather than this service reaching into
   * the gateway: that keeps the dependency arrow pointing one way (gateway →
   * service), so modules can inject the publish API without dragging a
   * WebSocket gateway — and a circular provider graph — along with it.
   */
  bindServer(server: RtNamespace): void {
    this.server = server;
    this.logger.log('Realtime publishing is live on /rt.');
  }

  /**
   * Full ride state after a transition.
   *
   * One room, both parties: the rider and the assigned driver receive the same
   * frame. That is the right shape for a state change — they are watching the
   * same trip — but it means anything on this payload reaches the driver too,
   * so the pickup code is stripped on the way out no matter what the caller
   * passed. The code is the anti-fraud control on the whole flow (a driver who
   * learns it can start a trip with nobody in the car), the rider already gets
   * it from `GET /v1/rides/:id`, and a rider-audience view handed to this
   * method by mistake should be a dropped field rather than a fraud vector.
   */
  emitRideStatus(rideId: string, summary: RideSummary): void {
    const payload = withoutPickupOtp(summary);
    this.deliver(RT_SERVER_EVENTS.rideStatus, rideId, (server) =>
      server.to(rideRoom(rideId)).emit(RT_SERVER_EVENTS.rideStatus, payload),
    );
  }

  /**
   * The driver's live position, to that one ride's room.
   *
   * Callers are responsible for having checked that the ride is active; the
   * gateway does exactly that before re-broadcasting a driver's own frame.
   */
  emitDriverLocation(rideId: string, payload: RtDriverLocationPayload): void {
    this.deliver(RT_SERVER_EVENTS.driverLocation, rideId, (server) =>
      server.to(rideRoom(rideId)).emit(RT_SERVER_EVENTS.driverLocation, payload),
    );
  }

  /**
   * A new offer, to every device that driver is signed in on.
   *
   * Addressed to the driver room rather than a single socket on purpose: a
   * driver with the app open on a phone and a tablet must see the offer on
   * both, and whichever device answers first wins the row — the partial unique
   * index `ride_offers_one_accepted_per_ride` settles that race in the database,
   * not here.
   */
  emitOfferToDriver(driverId: string, offer: RideOfferForDriver): void {
    this.deliver(RT_SERVER_EVENTS.offerNew, driverId, (server) =>
      server.to(driverRoom(driverId)).emit(RT_SERVER_EVENTS.offerNew, offer),
    );
  }

  /** An offer that can no longer be answered — expired, revoked, or lost. */
  emitOfferRevoked(driverId: string, payload: RtOfferRevokedPayload): void {
    this.deliver(RT_SERVER_EVENTS.offerRevoked, driverId, (server) =>
      server.to(driverRoom(driverId)).emit(RT_SERVER_EVENTS.offerRevoked, payload),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One place where "best effort" is actually implemented: no server yet is a
   * debug line, a throwing emit is a warning, and neither reaches the caller.
   * `target` is only ever an id we already hold, so it is safe to log.
   */
  private deliver(event: string, target: string, send: (server: RtNamespace) => void): void {
    const server = this.server;
    if (!server) {
      this.logger.debug(`Realtime not bound yet; dropped ${event} for ${target}.`);
      return;
    }
    try {
      send(server);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to publish ${event} for ${target}: ${detail}`);
    }
  }
}

/**
 * Drop the pickup code if a richer rider-facing view was passed in.
 *
 * RideSummary itself has no such field; the wider views the rides module builds
 * do, which is exactly why this guards the shared room rather than trusting
 * every future caller to remember who else is listening.
 */
function withoutPickupOtp(summary: RideSummary): RideSummary {
  const { pickupOtp: _pickupOtp, ...rest } = summary as RideSummary & { pickupOtp?: unknown };
  return rest;
}
