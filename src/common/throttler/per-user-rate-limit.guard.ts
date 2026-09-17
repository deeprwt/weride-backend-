import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.module';
import type { RequestPrincipal } from '../auth/current-user.decorator';

export interface PerUserRateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Distinguishes independent buckets, e.g. 'location-ping'. */
  bucket: string;
}

export const PER_USER_RATE_LIMIT_KEY = 'throttle:perUser';

/**
 * Rate-limit a route per authenticated user rather than per IP.
 *
 * The global ThrottlerGuard keys on IP, which is the right tracker for
 * unauthenticated floods but the wrong one for authenticated high-volume
 * routes. Every driver on the same carrier NAT, corporate network, or behind
 * one ingress shares a single IP bucket, so the busiest legitimate route in the
 * platform — location pings, roughly one per driver per second — would have
 * drivers throttling each other while a single abusive client stayed well
 * inside its own allowance.
 */
export const RateLimitPerUser = (limit: PerUserRateLimit): MethodDecorator =>
  SetMetadata(PER_USER_RATE_LIMIT_KEY, limit);

/**
 * Apply with `@UseGuards(PerUserRateLimitGuard)` — a route-scoped guard, which
 * Nest runs AFTER the global APP_GUARDs. That ordering is what makes this work
 * at all: JwtAuthGuard has already populated `req.user` by the time this runs,
 * whereas the global throttler deliberately runs before authentication and so
 * has no user to key on.
 */
@Injectable()
export class PerUserRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<PerUserRateLimit | undefined>(
      PER_USER_RATE_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!config) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: RequestPrincipal }>();
    const userId = req.user?.userId;
    // Unauthenticated requests never reach here in practice (JwtAuthGuard is
    // global); if one does, defer to the IP-keyed global limiter rather than
    // inventing a shared bucket that every anonymous caller would contend on.
    if (!userId) return true;

    const key = `uride:rl:${config.bucket}:${userId}`;

    // INCR-then-EXPIRE in one round trip. The first request in a window creates
    // the key and sets its TTL; the TTL is only ever set when count === 1, so a
    // sustained caller cannot keep pushing their own window forward.
    const pipeline = this.redis.client.multi();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();

    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[1]?.[1] ?? -1);

    if (count === 1 || ttl < 0) {
      await this.redis.client.expire(key, config.windowSeconds);
    }

    if (count > config.limit) {
      const retryAfter = ttl > 0 ? ttl : config.windowSeconds;
      throw new HttpException(
        {
          code: 'rate_limited',
          message: `Too many requests. Retry in ${retryAfter}s.`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

/** Re-exported so route files import one symbol instead of two. */
export const PerUserRateLimit: Type<CanActivate> = PerUserRateLimitGuard;
