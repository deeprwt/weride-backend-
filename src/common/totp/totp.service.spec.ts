import { TotpService } from './totp.service';
import { authenticator } from 'otplib';
import { _resetEnvCache } from '../../config/env';

describe('TotpService', () => {
  let svc: TotpService;

  beforeAll(() => {
    _resetEnvCache();
    process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.DIRECT_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.AUTH_PROVIDER = 'local';
    process.env.JWT_LOCAL_SECRET = 'a'.repeat(48);
    svc = new TotpService();
  });

  it('enrolls + verifies a fresh secret', async () => {
    const enrollment = await svc.enroll('admin@uride.local');
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32,}$/);
    // otplib URL-encodes the label, so `@` → `%40`.
    expect(enrollment.otpauthUrl).toMatch(/^otpauth:\/\/totp\/WeRide:admin(@|%40)uride\.local/);
    expect(enrollment.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(enrollment.recoveryCodes.plain).toHaveLength(10);
    expect(enrollment.recoveryCodes.hashed).toHaveLength(10);

    const liveCode = authenticator.generate(enrollment.secret);
    expect(svc.verifyToken(enrollment.secretEncrypted, liveCode)).toBe(true);
    expect(svc.verifyToken(enrollment.secretEncrypted, '000000')).toBe(false);
  });

  it('encrypted secret is reversible and not the plaintext', async () => {
    const enrollment = await svc.enroll('admin@uride.local');
    expect(enrollment.secretEncrypted.startsWith('v1:')).toBe(true);
    expect(enrollment.secretEncrypted).not.toContain(enrollment.secret);
  });
});
