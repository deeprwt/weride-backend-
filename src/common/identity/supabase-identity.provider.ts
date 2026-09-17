import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { loadEnv } from '../../config/env';
import { IdentityProvider, type VerifiedToken } from './identity-provider.interface';
import {
  TokenIssuer,
  type IssuedTokens,
  type IssueTokensInput,
} from './token-issuer.interface';

/**
 * Supabase identity provider.
 *
 * Verification: Supabase signs JWTs with the project JWT secret (HS256) and
 * also publishes a JWKS. We prefer JWKS (rotation-safe) when SUPABASE_URL is
 * present, falling back to the shared secret otherwise.
 *
 * Token issuance: NOT our responsibility in Supabase mode. The client uses the
 * Supabase SDK directly; the core API only verifies tokens. `issueTokens`
 * therefore throws — auth controllers branch on AUTH_PROVIDER and never call
 * this in Supabase mode.
 */
@Injectable()
export class SupabaseIdentityProvider extends IdentityProvider implements TokenIssuer {
  private readonly logger = new Logger(SupabaseIdentityProvider.name);
  private readonly sharedSecret: Uint8Array | null;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly issuer: string | null;

  constructor() {
    super();
    const env = loadEnv();
    this.sharedSecret = env.SUPABASE_JWT_SECRET
      ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
      : null;
    this.jwks = env.SUPABASE_URL
      ? createRemoteJWKSet(new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`))
      : null;
    this.issuer = env.SUPABASE_URL
      ? `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`
      : null;
  }

  isAvailable(): boolean {
    return this.sharedSecret !== null || this.jwks !== null;
  }

  async verifyAccessToken(jwt: string): Promise<VerifiedToken> {
    if (!this.isAvailable()) {
      throw new UnauthorizedException('Supabase identity provider misconfigured.');
    }
    try {
      const { payload } = this.jwks
        ? await jwtVerify(jwt, this.jwks, { issuer: this.issuer ?? undefined })
        : await jwtVerify(jwt, this.sharedSecret as Uint8Array, {
            algorithms: ['HS256'],
          });

      const sub = payload.sub;
      if (typeof sub !== 'string') throw new UnauthorizedException('Token missing sub.');
      const jti = typeof payload.jti === 'string' ? payload.jti : `sb:${sub}:${payload.iat ?? 0}`;

      // Supabase puts custom claims under `app_metadata` and `user_metadata`.
      const appMeta = (payload['app_metadata'] as Record<string, unknown> | undefined) ?? {};
      const roles = Array.isArray(appMeta.roles)
        ? (appMeta.roles as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];

      return {
        userId: sub,
        jti,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        phone: typeof payload.phone === 'string' ? payload.phone : undefined,
        roles,
        exp: typeof payload.exp === 'number' ? payload.exp : 0,
        raw: payload as Record<string, unknown>,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      this.logger.debug(`Supabase verifyAccessToken failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token.');
    }
  }

  async issueTokens(_input: IssueTokensInput): Promise<IssuedTokens> {
    throw new Error(
      'SupabaseIdentityProvider.issueTokens: token issuance is owned by Supabase Auth ' +
        'in supabase mode. Use the Supabase client SDK from the app instead.',
    );
  }
}
