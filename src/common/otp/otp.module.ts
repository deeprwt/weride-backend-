import { Module, type Provider } from '@nestjs/common';
import { OtpProvider, OTP_PROVIDER } from './otp-provider.interface';
import { LocalDevOtpProvider } from './local-dev-otp.provider';
import { TwilioOtpProvider } from './twilio-otp.provider';
import { RedisModule, RedisService } from '../redis/redis.module';
import { loadEnv } from '../../config/env';

const otpProviderFactory: Provider = {
  provide: OtpProvider,
  inject: [RedisService],
  useFactory: (redis: RedisService): OtpProvider => {
    const env = loadEnv();
    return env.OTP_PROVIDER === 'twilio'
      ? new TwilioOtpProvider()
      : new LocalDevOtpProvider(redis);
  },
};

@Module({
  imports: [RedisModule],
  providers: [
    otpProviderFactory,
    { provide: OTP_PROVIDER, useExisting: OtpProvider },
  ],
  exports: [OtpProvider, OTP_PROVIDER],
})
export class OtpModule {}
