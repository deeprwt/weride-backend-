import type { AuthSurface } from './identity-provider.interface';

export interface IssuedTokens {
  accessToken: string;
  /** Opaque refresh token. The hash is stored in `auth_sessions`; the raw value is returned ONCE to the client. */
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  jti: string;
}

export interface IssueTokensInput {
  userId: string;
  phone?: string | null;
  email?: string | null;
  roles: string[];
  surface: AuthSurface;
}

/**
 * TokenIssuer — issues access + refresh tokens for a user.
 *
 * In local mode, the API issues + verifies its own HS256 JWTs against
 * JWT_LOCAL_SECRET.
 *
 * In Supabase mode, token issuance is owned by Supabase Auth (called from the
 * client SDK) — our backend only verifies the resulting JWT. The Supabase
 * issuer here therefore throws if asked to mint a token; auth controllers
 * branch on AUTH_PROVIDER to decide whether to call us at all.
 */
export abstract class TokenIssuer {
  abstract issueTokens(input: IssueTokensInput): Promise<IssuedTokens>;
}

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
