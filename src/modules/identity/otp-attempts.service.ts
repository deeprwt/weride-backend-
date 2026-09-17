import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.module';
import { RedisService } from '../../common/redis/redis.module';
import { loadEnv } from '../../config/env';

/**
 * Tracks OTP attempts for analytics + brute-force defense. Phone is stored
 * hashed in Postgres; Redis owns the live rate-limit counters.
 */
@Injectable()
export class OtpAttemptsService {
  private readonly perPhonePerMin: number;
  private readonly perIpPerHour: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    const env = loadEnv();
    this.perPhonePerMin = env.OTP_RATE_PER_PHONE_PER_MIN;
    this.perIpPerHour = env.OTP_RATE_PER_IP_PER_HOUR;
  }

  /** Check and increment rate-limit counters. Returns true if within limits. */
  async checkAndCount(phone: string, ip?: string): Promise<boolean> {
    const phoneKey = `rl:otp:phone:${phone}`;
    const phoneCount = await this.redis.client.incr(phoneKey);
    if (phoneCount === 1) await this.redis.client.expire(phoneKey, 60);
    if (phoneCount > this.perPhonePerMin) return false;

    if (ip) {
      const ipKey = `rl:otp:ip:${ip}`;
      const ipCount = await this.redis.client.incr(ipKey);
      if (ipCount === 1) await this.redis.client.expire(ipKey, 3600);
      if (ipCount > this.perIpPerHour) return false;
    }
    return true;
  }

  /** Audit row — kept 30 days, purged by job. */
  async record(phone: string, ip: string | undefined, succeeded: boolean): Promise<void> {
    await this.prisma.otpAttempt.create({
      data: {
        phoneHash: hashPhone(phone),
        ip,
        succeeded,
      },
    });
  }
}

export function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.toLowerCase()).digest('hex');
}
