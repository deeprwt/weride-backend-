import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheckService, HealthCheck, HealthCheckError } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

/**
 * `@Public()` exempts these routes from authentication but NOT from the global
 * ThrottlerGuard, which is backed by Redis. Without SkipThrottle, every probe —
 * including the container HEALTHCHECK — opens a Redis command before reaching
 * the handler, so a Redis outage turns liveness into a 500 and the orchestrator
 * kills a process that is otherwise serving fine. Liveness must not depend on a
 * dependency it does not require in order to run.
 *
 * Readiness still checks Redis in its body, which is the correct place for it:
 * "should traffic come here" is a different question from "is this alive".
 */
@SkipThrottle()
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('healthz')
  liveness() {
    return { status: 'ok', service: 'uride-api', ts: new Date().toISOString() };
  }

  @Public()
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
          return { database: { status: 'up' } };
        } catch (err) {
          throw new HealthCheckError('database down', {
            database: { status: 'down', message: (err as Error).message },
          });
        }
      },
      async () => {
        try {
          const pong = await this.redis.client.ping();
          if (pong !== 'PONG') throw new Error(`unexpected: ${pong}`);
          return { redis: { status: 'up' } };
        } catch (err) {
          throw new HealthCheckError('redis down', {
            redis: { status: 'down', message: (err as Error).message },
          });
        }
      },
    ]);
  }
}
