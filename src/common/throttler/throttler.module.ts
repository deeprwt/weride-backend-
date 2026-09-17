import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from 'nestjs-throttler-storage-redis';
import { RedisService } from '../redis/redis.module';
import { loadEnv } from '../../config/env';

/**
 * Rate limiting, actually enforced.
 *
 * `ThrottlerModule.forRoot(...)` on its own does nothing: it configures the
 * limits but nothing consults them until `ThrottlerGuard` is registered. Before
 * this module existed the app imported the former and never the latter, so
 * every route — including `POST /v1/auth/admin/login`, where a single guess
 * costs a ~19 MB argon2id hash — was unlimited. That is both a credential
 * stuffing vector and an unauthenticated memory-exhaustion DoS.
 *
 * Storage is Redis, not the default in-memory store. With the in-memory store
 * every API instance keeps its own counters, so a limit of 120/min silently
 * becomes 120/min *per instance* — the protection evaporates exactly when it
 * matters, under horizontal scale.
 *
 * ORDERING MATTERS. This module is imported ahead of AuthGuardModule in
 * AppModule so its APP_GUARD is registered first and therefore runs first:
 * a flood should be rejected before we spend a JWT verification (or an argon2
 * hash) on it. Moving this import below AuthGuardModule silently inverts that.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => {
        const env = loadEnv();
        return {
          throttlers: [
            {
              name: 'default',
              ttl: env.RATE_LIMIT_WINDOW_MS,
              limit: env.RATE_LIMIT_MAX,
            },
          ],
          storage: new ThrottlerStorageRedisService(redis.client),
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
