import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { HealthModule } from './common/health/health.module';
import { IdentityProviderModule } from './common/identity/identity.module';
import { PricingClientModule } from './common/pricing-client/pricing-client.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AuthGuardModule } from './common/auth/auth.module';
import { RateLimitModule } from './common/throttler/throttler.module';
import { StorageModule } from './common/storage/storage.module';

// Domain modules — register live ones first, then phase-deferred stubs.
import { IdentityModule } from './modules/identity/identity.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { GeoModule } from './modules/geo/geo.module';
import { MatchingModule } from './modules/matching/matching.module';
import { RidesModule } from './modules/rides/rides.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SafetyModule } from './modules/safety/safety.module';
import { AdminModule } from './modules/admin/admin.module';
import { SupportModule } from './modules/support/support.module';

import { loadEnv } from './config/env';
import { pinoOptions } from './common/logger';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadEnv(),
    }),
    LoggerModule.forRoot(pinoOptions()),

    // Cross-cutting — globals first.
    // RateLimitModule must precede AuthGuardModule: APP_GUARDs run in
    // registration order, and a flood should be rejected before we spend a JWT
    // verification or an argon2 hash on it.
    PrismaModule,
    RedisModule,
    RateLimitModule,
    AuthGuardModule,
    StorageModule, // @Global — DocumentStorage port for KYC uploads

    // Cross-cutting — feature-bounded
    HealthModule,
    IdentityProviderModule,
    PricingClientModule,
    RealtimeModule,

    // Domain
    IdentityModule, // Phase 1 — implemented
    DriversModule, // Phase 2
    GeoModule, // Phase 3
    MatchingModule, // Phase 3
    RidesModule, // Phase 3
    PaymentsModule, // Phase 4
    NotificationsModule, // Phase 5
    SafetyModule, // Phase 5
    AdminModule, // Phase 2–6
    SupportModule, // Phase 5
  ],
})
export class AppModule {}
