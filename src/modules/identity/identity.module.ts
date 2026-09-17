import { Module } from '@nestjs/common';
import { IdentityProviderModule } from '../../common/identity/identity.module';
import { OtpModule } from '../../common/otp/otp.module';
import { SessionModule } from '../../common/session/session.module';
import { PasswordModule } from '../../common/password/password.module';
import { TotpModule } from '../../common/totp/totp.module';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthService } from './auth.service';
import { OtpAttemptsService } from './otp-attempts.service';
import { SavedPlacesController } from './saved-places.controller';
import { SavedPlacesService } from './saved-places.service';

/**
 * Identity domain — phone OTP for riders/drivers, email + TOTP for admins,
 * profile read/update, refresh token rotation, logout denylist. Phase 1.
 */
@Module({
  imports: [IdentityProviderModule, OtpModule, SessionModule, PasswordModule, TotpModule],
  controllers: [AuthController, MeController, SavedPlacesController],
  providers: [AuthService, OtpAttemptsService, SavedPlacesService],
  exports: [AuthService],
})
export class IdentityModule {}
