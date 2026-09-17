import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityProviderModule } from '../identity/identity.module';
import { SessionModule } from '../session/session.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

/**
 * AuthModule — wires JwtAuthGuard + RolesGuard as APP_GUARDs.
 *
 * Every route is protected by default; controllers opt out with @Public().
 * Roles are additive: @Roles(...) requires the principal to have at least
 * one of the listed roles.
 */
@Module({
  imports: [IdentityProviderModule, SessionModule],
  providers: [
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtAuthGuard, RolesGuard],
})
export class AuthGuardModule {}
