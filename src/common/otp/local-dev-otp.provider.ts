import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { randomInt } from 'node:crypto';
import { RedisService } from '../redis/redis.module';
import { loadEnv } from '../../config/env';
import {
  OtpProvider,
  type SendOtpResult,
  type VerifyOtpInput,
  type VerifyOtpOutcome,
} from './otp-provider.interface';

const OTP_KEY = (phone: string) => `otp:${phone}`;
const ATTEMPTS_KEY = (phone: string) => `otp:attempts:${phone}`;
const MAX_ATTEMPTS = 5;

/**
 * LocalDevOtpProvider — the zero-external-accounts development path.
 *
 * Behavior:
 *  1. Generates a 6-digit code, stores it in Redis with TTL.
 *  2. Logs the code at INFO so it's visible in the terminal running the API.
 *  3. Posts a "fake SMS" preview email to Mailhog so you can read it at
 *     http://localhost:8025 just like a real SMS app.
 *  4. If LOCAL_DEV_MAGIC_OTP is set, ALSO accepts that fixed code for any
 *     phone — with a loud warning log per use. Env loader has already
 *     refused to set this when AUTH_PROVIDER=supabase, OTP_PROVIDER=twilio,
 *     or NODE_ENV=production.
 */
@Injectable()
export class LocalDevOtpProvider extends OtpProvider {
  private readonly logger = new Logger(LocalDevOtpProvider.name);
  private readonly ttlSeconds: number;
  private readonly magicOtp: string | null;
  private readonly mailer: Transporter | null;
  private readonly previewEmail: string;

  constructor(private readonly redis: RedisService) {
    super();
    const env = loadEnv();
    this.ttlSeconds = env.OTP_TTL_SECONDS;
    this.magicOtp = env.LOCAL_DEV_MAGIC_OTP || null;
    this.previewEmail = env.LOCAL_OTP_PREVIEW_EMAIL;

    if (env.MAILHOG_SMTP_HOST) {
      this.mailer = nodemailer.createTransport({
        host: env.MAILHOG_SMTP_HOST,
        port: env.MAILHOG_SMTP_PORT,
        secure: false,
        // Mailhog requires no auth and doesn't speak TLS.
        ignoreTLS: true,
      });
    } else {
      this.mailer = null;
    }
  }

  async send(phone: string): Promise<SendOtpResult> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.client.set(OTP_KEY(phone), code, 'EX', this.ttlSeconds);
    await this.redis.client.del(ATTEMPTS_KEY(phone));

    // The single most useful line of output during local dev:
    this.logger.log(`[DEV-OTP] phone=${phone} code=${code} ttl=${this.ttlSeconds}s`);

    if (this.mailer) {
      try {
        await this.mailer.sendMail({
          from: '"WeRide (dev SMS)" <dev-otp@uride.local>',
          to: this.previewEmail,
          subject: `[WeRide DEV SMS] ${phone}: ${code}`,
          text: `WeRide verification code: ${code}\n\nThis is a development-mode preview of the SMS that would be sent to ${phone}.\nValid for ${Math.round(this.ttlSeconds / 60)} minutes.`,
        });
      } catch (err) {
        // Mailhog being down should not break OTP flow — the log line above is canonical.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Mailhog SMS preview failed (non-fatal): ${message}`);
      }
    }

    return { challengeId: OTP_KEY(phone) };
  }

  async verify(input: VerifyOtpInput): Promise<VerifyOtpOutcome> {
    const attempts = await this.redis.client.incr(ATTEMPTS_KEY(input.phone));
    if (attempts === 1) {
      await this.redis.client.expire(ATTEMPTS_KEY(input.phone), this.ttlSeconds);
    }
    if (attempts > MAX_ATTEMPTS) {
      await this.redis.client.del(OTP_KEY(input.phone));
      return { ok: false, reason: 'too_many_attempts' };
    }

    if (this.magicOtp && input.code === this.magicOtp) {
      this.logger.warn(
        `LOCAL_DEV_MAGIC_OTP accepted for ${input.phone} — this WILL NOT work in production.`,
      );
      await this.redis.client.del(OTP_KEY(input.phone), ATTEMPTS_KEY(input.phone));
      return { ok: true };
    }

    const stored = await this.redis.client.get(OTP_KEY(input.phone));
    if (!stored) return { ok: false, reason: 'expired' };
    if (stored !== input.code) return { ok: false, reason: 'invalid_code' };

    // One-shot: delete on success.
    await this.redis.client.del(OTP_KEY(input.phone), ATTEMPTS_KEY(input.phone));
    return { ok: true };
  }
}
