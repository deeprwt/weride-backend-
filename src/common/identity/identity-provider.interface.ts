/**
 * IdentityProvider — abstracts the auth backend so the rest of the codebase
 * never imports Supabase directly. Phase 1 ships a LocalIdentityProvider
 * (default — zero external accounts) and a SupabaseIdentityProvider (real
 * provider, enabled via AUTH_PROVIDER=supabase).
 *
 * Migrating to a different identity provider later means writing a new
 * adapter; no consumer code changes.
 */

export type AuthSurface = 'mobile' | 'admin-web';

export interface VerifiedToken {
  /** Subject claim — maps to `users.id`. */
  userId: string;
  /** JWT ID — required for denylist support. */
  jti: string;
  email?: string;
  phone?: string;
  roles: string[];
  /** Seconds since epoch. */
  exp: number;
  /** Raw claims as the provider issued them. Untrusted beyond what the adapter verified. */
  raw: Record<string, unknown>;
}

export abstract class IdentityProvider {
  /** Verify a JWT issued by this provider. Throws on any failure. */
  abstract verifyAccessToken(jwt: string): Promise<VerifiedToken>;

  /** Whether this provider is currently usable (creds loaded, reachable, etc.). */
  abstract isAvailable(): boolean;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
