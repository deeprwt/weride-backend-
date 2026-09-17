import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import Redis, { type Redis as RedisClient } from 'ioredis';
import { loadEnv } from '../../config/env';

/**
 * App-wide Redis singleton. Used by rate limiting, OTP storage, session
 * denylist, and the future location-pipeline + matching modules. One TCP
 * connection per process — ioredis multiplexes commands internally.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: RedisClient;

  constructor() {
    const env = loadEnv();
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
