import { Injectable, Logger } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash } from 'node:crypto';
import { loadEnv } from '../../config/env';

// @node-rs/argon2 exports Algorithm as a `const enum`, which `isolatedModules`
// forbids reading by name. The runtime values are: 0=Argon2d, 1=Argon2i, 2=Argon2id.
const ARGON2ID = 2;

/**
 * Argon2id password hashing + NIST 800-63B style validation + HIBP k-anon check.
 *
 * NIST 800-63B (rev. 4): min length matters; composition rules don't.
 * We enforce: length ≥ ADMIN_MIN_PASSWORD_LENGTH and not-in-HIBP-corpus.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly minLength: number;
  private readonly hibpEnabled: boolean;

  constructor() {
    const env = loadEnv();
    this.minLength = env.ADMIN_MIN_PASSWORD_LENGTH;
    this.hibpEnabled = env.HIBP_ENABLED;
  }

  /**
   * Run all admin-password checks. Returns null if OK, or a list of reasons.
   *
   * HIBP behavior: when the network is unreachable, we ALLOW the password and
   * log a structured event so we can monitor how often the fallback fires.
   * (Per the user's standing requirement — no silent reduction of security.)
   */
  async validateAdminPassword(
    password: string,
    ctx: { actorEmail: string },
  ): Promise<string[] | null> {
    const errors: string[] = [];
    if (password.length < this.minLength) {
      errors.push(`Password must be at least ${this.minLength} characters.`);
    }
    if (this.hibpEnabled) {
      const result = await this.checkHibp(password);
      if (result === 'breached') {
        errors.push('Password has appeared in a known breach corpus; choose another.');
      } else if (result === 'offline') {
        this.logger.warn(
          `hibp.fallback.allow actor=${ctx.actorEmail} — HIBP unreachable; password accepted without breach check.`,
        );
      }
    }
    return errors.length === 0 ? null : errors;
  }

  async hashPassword(password: string): Promise<string> {
    return hash(password, {
      algorithm: ARGON2ID,
      memoryCost: 19_456, // ~19 MB
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verifyPassword(stored: string, candidate: string): Promise<boolean> {
    try {
      return await verify(stored, candidate);
    } catch {
      return false;
    }
  }

  /**
   * HIBP k-anonymity: send first 5 chars of the SHA-1 hash, scan the response.
   * Returns 'ok' | 'breached' | 'offline'.
   */
  private async checkHibp(password: string): Promise<'ok' | 'breached' | 'offline'> {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'add-padding': 'true' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return 'offline';
      const body = await res.text();
      for (const line of body.split(/\r?\n/)) {
        const [hashSuffix] = line.split(':');
        if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) return 'breached';
      }
      return 'ok';
    } catch {
      return 'offline';
    }
  }
}
