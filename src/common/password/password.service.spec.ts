import { PasswordService } from './password.service';
import { _resetEnvCache } from '../../config/env';

describe('PasswordService', () => {
  beforeAll(() => {
    _resetEnvCache();
    process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.DIRECT_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.AUTH_PROVIDER = 'local';
    process.env.JWT_LOCAL_SECRET = 'a'.repeat(48);
    process.env.HIBP_ENABLED = 'false';
  });

  it('rejects short passwords', async () => {
    const svc = new PasswordService();
    const errs = await svc.validateAdminPassword('short', { actorEmail: 'a@b.co' });
    expect(errs).not.toBeNull();
    expect(errs?.[0]).toMatch(/at least/);
  });

  it('accepts a long, unique-looking password (HIBP disabled)', async () => {
    const svc = new PasswordService();
    const errs = await svc.validateAdminPassword('correct-horse-battery-staple-3284', {
      actorEmail: 'a@b.co',
    });
    expect(errs).toBeNull();
  });

  it('hashes and verifies argon2id', async () => {
    const svc = new PasswordService();
    const hash = await svc.hashPassword('supersecure-passphrase-001');
    expect(hash).toMatch(/^\$argon2id/);
    expect(await svc.verifyPassword(hash, 'supersecure-passphrase-001')).toBe(true);
    expect(await svc.verifyPassword(hash, 'wrong')).toBe(false);
  });
});
