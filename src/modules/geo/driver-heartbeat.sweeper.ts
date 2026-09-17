import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import { GeoService } from './geo.service';

/**
 * Sweeps drivers offline once their app stops reporting.
 *
 * `GeoService.clearStaleDrivers()` is the query; nothing called it, which meant
 * a driver whose phone died, lost signal, or force-quit the app stayed `online`
 * in `driver_availability` indefinitely. Dispatch would keep offering them
 * rides that could never be accepted, and every such offer is a rider watching
 * a spinner while the timeout burns down.
 *
 * Two details make this safe to run on every API instance:
 *
 *  - A Redis lock (SET NX EX) means exactly one instance sweeps per tick.
 *    The UPDATE is idempotent, so a double-sweep would be harmless, but at
 *    100k concurrent drivers it is a large write taking row locks, and having
 *    every replica fire it simultaneously is how you turn a maintenance task
 *    into an outage.
 *  - The interval is `unref`'d so it can never hold the process open during a
 *    graceful shutdown.
 *
 * It starts on application bootstrap rather than module init so it cannot fire
 * against a half-initialised DI graph.
 */
@Injectable()
export class DriverHeartbeatSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DriverHeartbeatSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Redis key held for the duration of one sweep. */
  private static readonly LOCK_KEY = 'uride:sweeper:driver-heartbeat';

  private readonly intervalMs: number;
  private readonly lockTtlSeconds: number;

  constructor(
    private readonly geo: GeoService,
    private readonly redis: RedisService,
  ) {
    const env = loadEnv();
    // Sweep at half the heartbeat window: a driver is then marked offline
    // within 1.5 heartbeats of going quiet, without polling the table harder
    // than the signal actually changes.
    this.intervalMs = Math.max(15_000, (env.DRIVER_ONLINE_HEARTBEAT_SECONDS * 1000) / 2);
    // Long enough that a slow sweep keeps its lock, short enough that a crashed
    // instance does not stall sweeping for more than one cycle.
    this.lockTtlSeconds = Math.max(30, Math.ceil((this.intervalMs / 1000) * 2));
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.log(`Driver heartbeat sweeper started (every ${this.intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for an ops-triggered manual sweep. */
  async tick(): Promise<void> {
    // Guard against overlap within this instance if a sweep outlives its interval.
    if (this.running) return;
    this.running = true;
    try {
      const acquired = await this.redis.client.set(
        DriverHeartbeatSweeper.LOCK_KEY,
        String(process.pid),
        'EX',
        this.lockTtlSeconds,
        'NX',
      );
      if (acquired !== 'OK') return; // another instance owns this tick

      await this.geo.clearStaleDrivers();
    } catch (err) {
      // Never let a sweep failure kill the interval — Redis or the DB being
      // briefly unavailable must not permanently disable the sweeper.
      this.logger.error(
        `Driver heartbeat sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
