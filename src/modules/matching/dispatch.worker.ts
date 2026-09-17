import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';
import { MatchingService } from './matching.service';

/** Held for one tick. Release is a compare-and-delete so we never drop someone else's. */
const LOCK_KEY = 'uride:dispatch:worker:tick';
const RELEASE_IF_OWNED = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/**
 * DispatchWorker — the loop that makes matching autonomous.
 *
 * Without it nothing ever moves a ride on its own: an offer nobody answers sits
 * `pending` forever, holding its driver out of every future wave by the
 * one-pending-per-driver index, and a ride whose wave came back empty stays
 * `searching` until the rider gives up. Everything MatchingService does is a
 * response to somebody's request; this is the part with no requester.
 *
 * Two jobs per tick, in order:
 *
 *  1. Expire offers past their deadline, which publishes the revoke so the
 *     driver's countdown disappears instead of hanging at zero.
 *  2. Re-dispatch rides still `requested` or `searching` with nothing
 *     outstanding — the query `rides_awaiting_dispatch_idx` exists for.
 *
 * Expiry runs first on purpose: retiring the stale offers is what makes their
 * rides eligible for step 2 in the same tick, so a wave that nobody answered
 * widens immediately rather than a tick later.
 *
 * ARCHITECTURE.md sketched this as a BullMQ consumer of `matching:dispatch`. A
 * polled loop is what actually gets built, for two reasons. A queue job is
 * fire-once: the wave that finds nobody has to re-enqueue itself with a delay,
 * and every bug in that re-enqueue is a ride that silently stops looking —
 * whereas a poll over an indexed partial predicate re-discovers those rides for
 * free, including ones stranded by a crash mid-wave. And the cost is a
 * two-branch index scan every couple of seconds, against a table whose
 * in-flight rows number in the hundreds. When dispatch moves to Go the queue
 * consumer replaces this class and nothing else changes: the tick body is two
 * MatchingService calls.
 *
 * The plumbing copies DriverHeartbeatSweeper: a Redis SET NX EX lock so one
 * instance works per tick, an unref'd timer that can never hold a graceful
 * shutdown open, and a catch around everything so a bad tick can never kill the
 * interval. It starts on application bootstrap rather than module init so it
 * cannot fire against a half-initialised DI graph.
 */
@Injectable()
export class DispatchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DispatchWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly lockTtlSeconds: number;

  constructor(
    private readonly matching: MatchingService,
    private readonly redis: RedisService,
  ) {
    const env = loadEnv();
    this.enabled = env.DISPATCH_ENABLED;
    this.intervalMs = env.DISPATCH_TICK_MS;
    this.batchSize = env.DISPATCH_BATCH_SIZE;
    // A crash guard, not a schedule: the lock is released at the end of every
    // tick (see below), and this TTL only matters when the holder dies mid-tick.
    this.lockTtlSeconds = Math.max(5, Math.ceil((this.intervalMs / 1000) * 3));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      // Loud, because the symptom is subtle and unforgettable once seen: rides
      // are created, nothing assigns a driver, and every rider watches a
      // spinner. Worth saying out loud at boot rather than debugging at 2am.
      this.logger.warn(
        'Dispatch loop DISABLED by DISPATCH_ENABLED=false — no ride will be offered to a driver.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `Dispatch worker started (every ${this.intervalMs}ms, batch ${this.batchSize}).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for an ops-triggered manual pass. */
  async tick(): Promise<void> {
    // Guard against overlap within this instance when a tick outlives its
    // interval — a slow database must not queue ticks on top of each other.
    if (this.running) return;
    this.running = true;

    const token = randomUUID();
    let held = false;
    try {
      const acquired = await this.redis.client.set(
        LOCK_KEY,
        token,
        'EX',
        this.lockTtlSeconds,
        'NX',
      );
      if (acquired !== 'OK') return; // another instance owns this tick
      held = true;

      const expired = await this.matching.expireDueOffers(this.batchSize);

      const rideIds = await this.matching.rideIdsAwaitingDispatch(this.batchSize);
      let waves = 0;
      for (const rideId of rideIds) {
        // Sequential, and each ride in its own try. One ride whose wave throws
        // — a state that moved under us, a candidate query that timed out —
        // must not cost the rest of the batch their turn. Sequential rather
        // than Promise.all because a batch of 50 waves is 150 queries, and
        // firing them at once is how a dispatch tick becomes the reason the
        // connection pool has nothing left for actual requests.
        try {
          const outcome = await this.matching.dispatch(rideId);
          if (outcome.decision === 'offered' || outcome.decision === 'exhausted') waves += 1;
        } catch (error) {
          this.logger.error(
            `Dispatch wave for ride ${rideId} failed: ${describeError(error)}`,
          );
        }
      }

      if (expired > 0 || waves > 0) {
        this.logger.debug(
          `Dispatch tick: ${expired} offer(s) expired, ` +
            `${waves}/${rideIds.length} ride(s) advanced.`,
        );
      }
    } catch (error) {
      // Never let a tick failure kill the interval. Redis or Postgres being
      // briefly unavailable must degrade dispatch for a few seconds, not
      // disable it until someone notices and restarts the process.
      this.logger.error(`Dispatch tick failed: ${describeError(error)}`);
    } finally {
      if (held) await this.releaseLock(token);
      this.running = false;
    }
  }

  /**
   * Hand the lock back immediately rather than letting the TTL hold it.
   *
   * The heartbeat sweeper deliberately lets its lock expire — a slower sweep is
   * harmless there. Here the lock is what the next tick needs, and a skipped
   * tick is a rider watching a spinner for another few seconds, so the holder
   * releases as soon as it is done and the TTL is left as pure crash insurance.
   */
  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.client.eval(RELEASE_IF_OWNED, 1, LOCK_KEY, token);
    } catch (error) {
      this.logger.debug(`Dispatch tick lock release failed: ${describeError(error)}`);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
