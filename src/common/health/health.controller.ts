import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheckService, HealthCheck, HealthCheckError } from '@nestjs/terminus';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

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
