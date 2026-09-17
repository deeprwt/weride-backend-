import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { loadEnv } from '../../config/env';
import { IdentityProvider, type VerifiedToken } from './identity-provider.interface';
import {
  TokenIssuer,
  type IssueTokensInput,
  type IssuedTokens,
} from './token-issuer.interface';

const ALG = 'HS256';

/**
 * LocalIdentityProvider — issues + verifies HS256 JWTs against JWT_LOCAL_SECRET.
 *
 * Default in development. Lets the platform run end-to-end with zero external
 * accounts (no Supabase, no Twilio).
 *
 * Token shape mirrors Supabase Auth so a future swap to AUTH_PROVIDER=supabase
 * doesn't ripple into controllers.
 */
@Injectable()
export class LocalIdentityProvider extends IdentityProvider implements TokenIssuer {
  private readonly logger = new Logger(LocalIdentityProvider.name);
  private readonly secretBytes: Uint8Array;
  private readonly issuer: string;
  private readonly accessTtl: number;
  private readonly refreshTtlMobile: number;
  private readonly refreshTtlAdmin: number;

  constructor() {
    super();
    const env = loadEnv();
    // env loader has already enforced length + non-placeholder.
    this.secretBytes = new TextEncoder().encode(env.JWT_LOCAL_SECRET ?? '');
    this.issuer = env.JWT_ISSUER;
    this.accessTtl = env.JWT_ACCESS_TTL_SECONDS;
    this.refreshTtlMobile = env.JWT_REFRESH_TTL_MOBILE_SECONDS;
    this.refreshTtlAdmin = env.JWT_REFRESH_TTL_ADMIN_SECONDS;
  }

  isAvailable(): boolean {
    return this.secretBytes.length > 0;
  }

  async verifyAccessToken(jwt: string): Promise<VerifiedToken> {
    if (!this.isAvailable()) {
      throw new UnauthorizedException('Local identity provider misconfigured.');
    }
    try {
      const { payload } = await jwtVerify(jwt, this.secretBytes, {
        issuer: this.issuer,
        algorithms: [ALG],
      });
      const sub = payload.sub;
      const jti = payload.jti;
      if (typeof sub !== 'string' || typeof jti !== 'string') {
        throw new UnauthorizedException('Token missing sub/jti.');
      }
      return {
        userId: sub,
        jti,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        phone: typeof payload.phone === 'string' ? payload.phone : undefined,
        roles: Array.isArray(payload.roles)
          ? (payload.roles.filter((r): r is string => typeof r === 'string'))
          : [],
        exp: typeof payload.exp === 'number' ? payload.exp : 0,
        raw: payload as Record<string, unknown>,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      this.logger.debug(`verifyAccessToken failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token.');
    }
  }

  async issueTokens(input: IssueTokensInput): Promise<IssuedTokens> {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const refreshTtl =
      input.surface === 'admin-web' ? this.refreshTtlAdmin : this.refreshTtlMobile;

    const accessToken = await new SignJWT({
      phone: input.phone ?? undefined,
      email: input.email ?? undefined,
      roles: input.roles,
    })
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setSubject(input.userId)
      .setJti(jti)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTtl)
      .sign(this.secretBytes);

    // Refresh token is OPAQUE (not a JWT). 32 random bytes, url-safe base64.
    // Server stores the SHA-256 hash in auth_sessions; raw value returned once.
    const refreshToken = randomBytes(32).toString('base64url');

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date((now + this.accessTtl) * 1000),
      refreshExpiresAt: new Date((now + refreshTtl) * 1000),
      jti,
    };
  }
}

/** Hash an opaque refresh token for storage. Stable, side-channel safe enough for a 32-byte input. */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
