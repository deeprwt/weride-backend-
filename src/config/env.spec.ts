import { loadEnv, _resetEnvCache } from './env';

const baseEnv = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  DIRECT_URL: 'postgresql://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  NODE_ENV: 'test',
};

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Stringify everything; zod coerces.
  const out: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

describe('env loader — boot-time guards (Phase 1)', () => {
  beforeEach(() => _resetEnvCache());

  describe('JWT_LOCAL_SECRET', () => {
    it('refuses to boot when missing in local mode', () => {
      expect(() => loadEnv(envWith({ AUTH_PROVIDER: 'local', JWT_LOCAL_SECRET: undefined }))).toThrow(
        /JWT_LOCAL_SECRET/,
      );
    });

    it('refuses to boot when shorter than 32 chars', () => {
      expect(() =>
        loadEnv(envWith({ AUTH_PROVIDER: 'local', JWT_LOCAL_SECRET: 'short' })),
      ).toThrow();
    });

    it('refuses the literal .env.example placeholder', () => {
      const placeholder = 'PLACEHOLDER_DO_NOT_USE_GENERATE_WITH_openssl_rand_base64_48';
      expect(() =>
        loadEnv(envWith({ AUTH_PROVIDER: 'local', JWT_LOCAL_SECRET: placeholder })),
      ).toThrow(/placeholder/);
    });

    it('accepts a 32+ char non-placeholder secret', () => {
      expect(() =>
        loadEnv(envWith({ AUTH_PROVIDER: 'local', JWT_LOCAL_SECRET: 'a'.repeat(48) })),
      ).not.toThrow();
    });
  });

  describe('AUTH_PROVIDER=supabase requires creds', () => {
    it('refuses without SUPABASE_JWT_SECRET', () => {
      expect(() =>
        loadEnv(
          envWith({
            AUTH_PROVIDER: 'supabase',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_JWT_SECRET: undefined,
          }),
        ),
      ).toThrow(/SUPABASE_JWT_SECRET/);
    });
  });

  describe('OTP_PROVIDER=twilio requires creds', () => {
    it('refuses without Twilio creds', () => {
      expect(() =>
        loadEnv(
          envWith({
            AUTH_PROVIDER: 'local',
            JWT_LOCAL_SECRET: 'a'.repeat(48),
            OTP_PROVIDER: 'twilio',
          }),
        ),
      ).toThrow(/TWILIO/);
    });
  });

  describe('LOCAL_DEV_MAGIC_OTP scope', () => {
    const validBase = {
      AUTH_PROVIDER: 'local',
      JWT_LOCAL_SECRET: 'a'.repeat(48),
      OTP_PROVIDER: 'local',
    };

    it('refuses when NODE_ENV=production', () => {
      expect(() =>
        loadEnv(envWith({ ...validBase, NODE_ENV: 'production', LOCAL_DEV_MAGIC_OTP: '123456' })),
      ).toThrow(/production/);
    });

    it('refuses when AUTH_PROVIDER=supabase', () => {
      expect(() =>
        loadEnv(
          envWith({
            AUTH_PROVIDER: 'supabase',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_JWT_SECRET: 'x'.repeat(40),
            OTP_PROVIDER: 'local',
            LOCAL_DEV_MAGIC_OTP: '123456',
          }),
        ),
      ).toThrow(/AUTH_PROVIDER=supabase/);
    });

    it('refuses when OTP_PROVIDER=twilio', () => {
      expect(() =>
        loadEnv(
          envWith({
            ...validBase,
            OTP_PROVIDER: 'twilio',
            TWILIO_ACCOUNT_SID: 'AC...',
            TWILIO_AUTH_TOKEN: 'tok',
            TWILIO_VERIFY_SERVICE_SID: 'VA...',
            LOCAL_DEV_MAGIC_OTP: '123456',
          }),
        ),
      ).toThrow(/OTP_PROVIDER=twilio/);
    });

    it('allows magic OTP when fully local + non-production', () => {
      expect(() =>
        loadEnv(envWith({ ...validBase, LOCAL_DEV_MAGIC_OTP: '123456' })),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — driver documents + maps
// ---------------------------------------------------------------------------

describe('env loader — boot-time guards (Phase 2)', () => {
  /** Enough to clear the Phase 1 guards, which run before any of these. */
  const localAuth = { AUTH_PROVIDER: 'local', JWT_LOCAL_SECRET: 'a'.repeat(48) };

  beforeEach(() => _resetEnvCache());

  describe('MAPS_PROVIDER=google requires a key', () => {
    it('refuses without GOOGLE_MAPS_API_KEY', () => {
      expect(() =>
        loadEnv(envWith({ ...localAuth, MAPS_PROVIDER: 'google', GOOGLE_MAPS_API_KEY: undefined })),
      ).toThrow(/GOOGLE_MAPS_API_KEY/);
    });

    it('refuses the literal .env.example placeholder key', () => {
      const placeholder = 'PLACEHOLDER_NOT_A_REAL_KEY_REPLACE_BEFORE_SETTING_MAPS_PROVIDER_google';
      expect(() =>
        loadEnv(
          envWith({ ...localAuth, MAPS_PROVIDER: 'google', GOOGLE_MAPS_API_KEY: placeholder }),
        ),
      ).toThrow(/placeholder/);
    });

    it('boots with a real key', () => {
      expect(() =>
        loadEnv(
          envWith({
            ...localAuth,
            MAPS_PROVIDER: 'google',
            GOOGLE_MAPS_API_KEY: 'AIzaSy-not-in-env-example-0123456789',
          }),
        ),
      ).not.toThrow();
    });

    // The guard has to stay scoped to the billable provider: the free default
    // carries no key and must still boot, or local development needs an account.
    it('does not demand a key when MAPS_PROVIDER is none', () => {
      expect(() =>
        loadEnv(envWith({ ...localAuth, MAPS_PROVIDER: 'none', GOOGLE_MAPS_API_KEY: undefined })),
      ).not.toThrow();
    });
  });

  describe('DOCUMENT_STORAGE_DRIVER', () => {
    it('refuses s3, which has no implementation to persist KYC uploads', () => {
      expect(() => loadEnv(envWith({ ...localAuth, DOCUMENT_STORAGE_DRIVER: 's3' }))).toThrow(
        /DOCUMENT_STORAGE_DRIVER=s3/,
      );
    });

    it('boots on the local driver', () => {
      expect(() =>
        loadEnv(envWith({ ...localAuth, DOCUMENT_STORAGE_DRIVER: 'local' })),
      ).not.toThrow();
    });
  });
});
