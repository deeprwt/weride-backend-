import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { RideOfferForDriver } from '@uride/types';
import { RedisService } from '../common/redis/redis.module';
import {
  DISPATCH_CHANNELS,
  type DispatchOfferEvent,
  type DispatchOfferRevokedEvent,
} from '../modules/matching/matching.service';
import { RealtimeService } from './realtime.service';

/**
 * Carries dispatch events from Redis pub/sub onto driver sockets.
 *
 * MatchingService deliberately publishes offers to a channel instead of calling
 * the gateway directly — that is the seam ARCHITECTURE.md §8 reserves for
 * extracting the matcher into its own process, and a Go rewrite would emit the
 * same JSON on the same channels. The seam was only half-built, though:
 * everything published to `uride:dispatch:offer.new` fell on the floor, because
 * nothing subscribed. Offers reached drivers only if the app happened to poll
 * `GET /v1/driver/rides/offers/current`, which turns a 20-second countdown into
 * a race against the polling interval.
 *
 * This is the other half. It lives in the realtime module rather than the
 * matching module on purpose: the matcher must not know what a socket is, and
 * this is the only component allowed to know both.
 *
 * Delivery is best-effort in the same way the publish side is. The offer row is
 * committed before anything is published, so a dropped frame costs a driver
 * their head start, not the offer itself — the app still finds it on reconnect
 * and it still expires on schedule.
 */
@Injectable()
export class DispatchBridgeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DispatchBridgeService.name);
  private subscriber: Redis | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
  ) {}

  onApplicationBootstrap(): void {
    // A dedicated connection is mandatory, not tidiness: once an ioredis client
    // enters subscriber mode it refuses ordinary commands, so subscribing on
    // the shared client would break every other Redis user in the process —
    // rate limiting, the dispatch locks, the session denylist.
    this.subscriber = this.redis.client.duplicate();

    this.subscriber.on('error', (err: Error) => {
      this.logger.error(`Dispatch bridge Redis error: ${err.message}`);
    });

    // ioredis re-subscribes automatically after a reconnect, so there is no
    // resubscribe handler here; losing frames during the gap is acceptable for
    // the reason given above.
    void this.subscriber
      .subscribe(DISPATCH_CHANNELS.offerNew, DISPATCH_CHANNELS.offerRevoked)
      .then((count) => {
        this.logger.log(`Dispatch bridge subscribed to ${String(count)} channel(s).`);
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Dispatch bridge failed to subscribe: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    this.subscriber.on('message', (channel: string, raw: string) => {
      try {
        this.handle(channel, raw);
      } catch (err) {
        // One malformed frame must never take down the subscriber and with it
        // every future offer.
        this.logger.warn(
          `Dropped dispatch frame on ${channel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.subscriber) return;
    await this.subscriber.quit().catch(() => undefined);
    this.subscriber = null;
  }

  private handle(channel: string, raw: string): void {
    if (channel === DISPATCH_CHANNELS.offerNew) {
      const event = JSON.parse(raw) as DispatchOfferEvent;
      this.realtime.emitOfferToDriver(event.driverId, toOfferForDriver(event));
      return;
    }

    if (channel === DISPATCH_CHANNELS.offerRevoked) {
      const event = JSON.parse(raw) as DispatchOfferRevokedEvent;
      // The wire contract omits driverId — the app knows who it is — so it is
      // stripped here rather than leaking the routing key into the payload.
      const { driverId, ...payload } = event;
      this.realtime.emitOfferRevoked(driverId, payload);
      return;
    }

    this.logger.warn(`Dispatch bridge received an unexpected channel: ${channel}`);
  }
}

/**
 * Reshape the pub/sub event into the contract the driver app renders.
 *
 * The two shapes differ because they answer to different constraints: the
 * channel event carries a routing key and the raw fare, while the app needs the
 * driver's own earnings and a flattened ride. Doing the conversion here keeps
 * `RideOfferForDriver` the single thing the app has to understand.
 */
function toOfferForDriver(event: DispatchOfferEvent): RideOfferForDriver {
  return {
    offer: event.offer,
    pickup: event.ride.pickup,
    pickupAddress: event.ride.pickupAddress,
    dropoff: event.ride.dropoff,
    dropoffAddress: event.ride.dropoffAddress,
    rideClass: event.ride.rideClass,
    driverEarningsCents: driverEarningsCentsFor(event.ride.fareCents),
    tripDistanceMeters: event.ride.tripDistanceMeters,
    tripDurationSeconds: event.ride.tripDurationSeconds,
    secondsRemaining: event.secondsRemaining,
  };
}

/**
 * Platform commission, mirrored from DriverRidesService.
 *
 * Duplicated rather than imported: RealtimeModule importing RidesModule would
 * close a cycle (rides -> realtime -> rides). It is one constant, and Phase 4
 * moves the split into the payments module where it belongs — at which point
 * both copies are deleted together.
 */
const PLATFORM_COMMISSION_RATE = 0.2;

function driverEarningsCentsFor(fareCents: number | null): number {
  if (fareCents === null) return 0;
  return Math.round(fareCents * (1 - PLATFORM_COMMISSION_RATE));
}
