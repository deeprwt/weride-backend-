import { Injectable, Logger } from '@nestjs/common';
import { authenticator } from 'otplib';
import { toDataURL as qrToDataURL } from 'qrcode';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { loadEnv } from '../../config/env';

export interface EnrollmentArtifacts {
  /** Plaintext base32 secret — show ONCE if the user wants to add manually. */
  secret: string;
  /** Encrypted form to store in users.totp_secret_encrypted. */
  secretEncrypted: string;
  otpauthUrl: string;
  qrDataUrl: string;
  recoveryCodes: { plain: string[]; hashed: string[] };
}

/**
 * TOTP (RFC 6238) for admin MFA.
 *
 * - 30s period, 6 digits, SHA1 (matches Google Authenticator / 1Password defaults).
 * - Secrets encrypted at rest with AES-256-GCM using a key derived from
 *   JWT_LOCAL_SECRET (Phase 1 simplification — Phase 6 swaps to a real KMS).
 * - Recovery codes: N url-safe ~10-char strings; we store HASHED codes, return
 *   the plaintext once at enrollment, mark each consumed when used.
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);
  private readonly issuer: string;
  private readonly recoveryCount: number;
  private readonly encKey: Buffer;

  constructor() {
    const env = loadEnv();
    this.issuer = env.TOTP_ISSUER;
    this.recoveryCount = env.TOTP_RECOVERY_CODE_COUNT;
    // Derive a stable 32-byte key from JWT_LOCAL_SECRET. In Supabase mode we
    // use the Supabase secret. Either way: rotating the JWT secret rotates
    // this key — admins would need to re-enroll. Documented in AUTH.md.
    const seed = env.JWT_LOCAL_SECRET || env.SUPABASE_JWT_SECRET || '';
    this.encKey = createHash('sha256').update(`totp:${seed}`).digest();
  }

  async enroll(accountLabel: string): Promise<EnrollmentArtifacts> {
    // 160-bit secret (32 base32 chars) — matches SHA1 HMAC block per RFC 6238
    // and exceeds OWASP's 128-bit minimum. otplib's default is 80 bits.
    const secret = authenticator.generateSecret(20);
    const otpauthUrl = authenticator.keyuri(accountLabel, this.issuer, secret);
    const qrDataUrl = await qrToDataURL(otpauthUrl);

    const recoveryPlain = Array.from({ length: this.recoveryCount }, () =>
      randomBytes(6).toString('base64url').slice(0, 10),
    );
    const recoveryHashed = recoveryPlain.map((c) => this.hashRecoveryCode(c));

    return {
      secret,
      secretEncrypted: this.encryptSecret(secret),
      otpauthUrl,
      qrDataUrl,
      recoveryCodes: { plain: recoveryPlain, hashed: recoveryHashed },
    };
  }

  verifyToken(encryptedSecret: string, token: string): boolean {
    const secret = this.decryptSecret(encryptedSecret);
    return authenticator.check(token, secret);
  }

  hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private encryptSecret(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
  }

  private decryptSecret(blob: string): string {
    const parts = blob.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Unsupported TOTP secret format.');
    }
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  }
}
