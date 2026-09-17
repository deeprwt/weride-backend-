import { Module, type Provider } from '@nestjs/common';
import { IdentityProvider, IDENTITY_PROVIDER } from './identity-provider.interface';
import { TokenIssuer, TOKEN_ISSUER } from './token-issuer.interface';
import { LocalIdentityProvider } from './local-identity.provider';
import { SupabaseIdentityProvider } from './supabase-identity.provider';
import { loadEnv } from '../../config/env';

/**
 * Boot-time factory: pick the identity provider implementation based on
 * AUTH_PROVIDER. Local is the default and works with zero external accounts.
 *
 * Both providers also implement TokenIssuer (Supabase's issueTokens throws —
 * see note in supabase-identity.provider.ts).
 */

const identityProviderFactory: Provider = {
  provide: IdentityProvider,
  useFactory: (): IdentityProvider & TokenIssuer => {
    const env = loadEnv();
    return env.AUTH_PROVIDER === 'supabase'
      ? new SupabaseIdentityProvider()
      : new LocalIdentityProvider();
  },
};

@Module({
  providers: [
    identityProviderFactory,
    { provide: IDENTITY_PROVIDER, useExisting: IdentityProvider },
    { provide: TokenIssuer, useExisting: IdentityProvider },
    { provide: TOKEN_ISSUER, useExisting: IdentityProvider },
  ],
  exports: [IdentityProvider, IDENTITY_PROVIDER, TokenIssuer, TOKEN_ISSUER],
})
export class IdentityProviderModule {}
