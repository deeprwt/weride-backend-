import { Injectable, Logger } from '@nestjs/common';
import twilio, { type Twilio } from 'twilio';
import { loadEnv } from '../../config/env';
import {
  OtpProvider,
  type SendOtpResult,
  type VerifyOtpInput,
  type VerifyOtpOutcome,
} from './otp-provider.interface';

/**
 * TwilioOtpProvider — production OTP via Twilio Verify.
 *
 * Twilio Verify owns code generation, expiry, and attempt counting; we just
 * proxy the phone + code. Costs ~$0.05 per verification in Canada.
 */
@Injectable()
export class TwilioOtpProvider extends OtpProvider {
  private readonly logger = new Logger(TwilioOtpProvider.name);
  private readonly client: Twilio;
  private readonly serviceSid: string;

  constructor() {
    super();
    const env = loadEnv();
    if (
      !env.TWILIO_ACCOUNT_SID ||
      !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_VERIFY_SERVICE_SID
    ) {
      // env loader has already enforced this; defensive only.
      throw new Error('TwilioOtpProvider requires TWILIO_* env vars.');
    }
    this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    this.serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
  }

  async send(phone: string): Promise<SendOtpResult> {
    const verification = await this.client.verify.v2
      .services(this.serviceSid)
      .verifications.create({ to: phone, channel: 'sms' });
    return { challengeId: verification.sid };
  }

  async verify(input: VerifyOtpInput): Promise<VerifyOtpOutcome> {
    try {
      const check = await this.client.verify.v2
        .services(this.serviceSid)
        .verificationChecks.create({ to: input.phone, code: input.code });
      if (check.status === 'approved') return { ok: true };
      return { ok: false, reason: 'invalid_code' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Twilio verify failed: ${message}`);
      // Twilio returns 404 when the verification has expired or was cleared.
      if (/404/.test(message) || /not found/i.test(message)) {
        return { ok: false, reason: 'expired' };
      }
      return { ok: false, reason: 'invalid_code' };
    }
  }
}
