import { Test } from '@nestjs/testing';
import { IdentityProviderModule } from './identity.module';
import { IdentityProvider } from './identity-provider.interface';
import { TokenIssuer } from './token-issuer.interface';
import { _resetEnvCache } from '../../config/env';

const VALID_LOCAL_SECRET = 'a'.repeat(48);

describe('IdentityProviderModule', () => {
  beforeEach(() => {
    _resetEnvCache();
    process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.DIRECT_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.AUTH_PROVIDER = 'local';
    process.env.JWT_LOCAL_SECRET = VALID_LOCAL_SECRET;
    delete process.env.LOCAL_DEV_MAGIC_OTP;
  });

  it('uses LocalIdentityProvider when AUTH_PROVIDER=local', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityProviderModule],
    }).compile();

    const provider = moduleRef.get(IdentityProvider);
    expect(provider.isAvailable()).toBe(true);
  });

  it('local provider mints + verifies its own tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityProviderModule],
    }).compile();

    const provider = moduleRef.get(IdentityProvider);
    const issuer = moduleRef.get(TokenIssuer);

    const issued = await issuer.issueTokens({
      userId: '00000000-0000-0000-0000-000000000001',
      phone: '+14165550100',
      email: null,
      roles: ['rider'],
      surface: 'mobile',
    });
    const verified = await provider.verifyAccessToken(issued.accessToken);
    expect(verified.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(verified.phone).toBe('+14165550100');
    expect(verified.roles).toEqual(['rider']);
    expect(verified.jti).toBe(issued.jti);
  });

  it('rejects garbage tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityProviderModule],
    }).compile();
    const provider = moduleRef.get(IdentityProvider);
    await expect(provider.verifyAccessToken('not.a.token')).rejects.toThrow();
  });
});
