/**
 * End-to-end auth flow test.
 *
 * Hits a REAL Postgres + Redis (assumes `pnpm docker:up` has been run from the
 * repo root and `pnpm --filter @uride/api prisma:deploy` has migrated the DB).
 *
 * Skips gracefully if either is unreachable, so `pnpm test` in a no-infra
 * environment still passes.
 *
 * Verifies (the contract from the Phase 1 verification checklist):
 *   1. POST /v1/auth/otp/request stores a code in Redis (via local provider).
 *   2. POST /v1/auth/otp/verify with that code returns a token pair + user.
 *   3. GET /v1/me with the access token returns the new user.
 *   4. POST /v1/auth/refresh rotates the token pair; old refresh becomes unusable.
 *   5. Replaying the old refresh token revokes the entire family.
 *   6. POST /v1/auth/logout denylists the access JTI; subsequent GET /v1/me 401s.
 */

import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Server } from 'node:http';
import { Socket } from 'node:net';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { _resetEnvCache } from '../src/config/env';
import { Logger as PinoLogger } from 'nestjs-pino';

const TEST_SECRET = 'unit-test-secret-' + 'x'.repeat(40);

function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

async function infraReachable(): Promise<{ pg: boolean; redis: boolean }> {
  const dbUrl = process.env.DATABASE_URL ?? '';
  const pgHostPort = /:\/\/[^@]+@([^:/]+):(\d+)/.exec(dbUrl);
  const pg = pgHostPort ? await tcpOpen(pgHostPort[1], Number(pgHostPort[2])) : false;
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisHostPort = /redis:\/\/([^:/]+)(?::(\d+))?/.exec(redisUrl);
  const redis = redisHostPort
    ? await tcpOpen(redisHostPort[1], Number(redisHostPort[2] ?? 6379))
    : false;
  return { pg, redis };
}

describe('Auth E2E (Phase 1)', () => {
  let app: INestApplication;
  let server: Server;
  let redis: Redis;
  let phone: string;
  let testCode: string;

  beforeAll(async () => {
    _resetEnvCache();
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';
    process.env.LOG_PRETTY = 'false';
    process.env.AUTH_PROVIDER = 'local';
    process.env.OTP_PROVIDER = 'local';
    process.env.JWT_LOCAL_SECRET = TEST_SECRET;
    process.env.DATABASE_URL ??= 'postgresql://uride:uride@localhost:5432/uride?schema=public';
    process.env.DIRECT_URL ??= process.env.DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    // Don't ship dev emails during tests.
    process.env.MAILHOG_SMTP_HOST = '127.0.0.1';

    const { pg, redis: redisOk } = await infraReachable();
    if (!pg || !redisOk) {
      // eslint-disable-next-line no-console
      console.warn(
        `[auth-e2e] SKIPPING — infra not reachable (pg=${pg}, redis=${redisOk}). ` +
          'Run "pnpm docker:up && pnpm --filter @uride/api prisma:deploy" first.',
      );
      return;
    }

    redis = new Redis(process.env.REDIS_URL);
    // Use a unique phone per run to avoid clashes between repeated test runs.
    phone = `+1416555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(PinoLogger));
    app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz', 'docs'] });
    await app.init();
    server = app.getHttpServer() as Server;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  it('completes the full request → verify → /me → refresh → logout flow', async () => {
    if (!app) return; // skipped — infra missing

    // 1. Request OTP
    const requestRes = await request(server)
      .post('/v1/auth/otp/request')
      .send({ phone });
    expect(requestRes.status).toBe(204);

    // Local provider stored the code in Redis at otp:<phone>
    testCode = (await redis.get(`otp:${phone}`)) ?? '';
    expect(testCode).toMatch(/^\d{6}$/);

    // 2. Verify OTP
    const verifyRes = await request(server)
      .post('/v1/auth/otp/verify')
      .send({ phone, code: testCode });
    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.tokens.accessToken).toMatch(/^eyJ/);
    expect(verifyRes.body.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyRes.body.user.phone).toBe(phone);
    expect(verifyRes.body.user.roles).toContain('rider');
    // locale + fullName ride along in the session payload (drives mobile i18n).
    expect(verifyRes.body.user.locale).toBe('en-CA');
    expect(verifyRes.body.user).toHaveProperty('fullName');

    const access1 = verifyRes.body.tokens.accessToken as string;
    const refresh1 = verifyRes.body.tokens.refreshToken as string;

    // 3. /v1/me with that access token
    const meRes = await request(server)
      .get('/v1/me')
      .set('authorization', `Bearer ${access1}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.phone).toBe(phone);

    // 4. Refresh: new token pair, old refresh becomes unusable.
    const refreshRes = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(refreshRes.status).toBe(201);
    const access2 = refreshRes.body.tokens.accessToken as string;
    const refresh2 = refreshRes.body.tokens.refreshToken as string;
    expect(access2).not.toBe(access1);
    expect(refresh2).not.toBe(refresh1);

    // Old refresh token cannot rotate again — that's a REPLAY.
    const replayRes = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(replayRes.status).toBe(401);

    // 5. After replay, refresh2 ALSO fails — family was revoked.
    //    (Slight subtlety: refresh2 was created by a transactional rotation,
    //     and the replay detection then kills the family. So refresh2 should
    //     now be revoked.)
    const refresh2Res = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: refresh2 });
    expect(refresh2Res.status).toBe(401);

    // 6. Logout with access2 (still valid in JWT terms) + denylist check.
    const logoutRes = await request(server)
      .post('/v1/auth/logout')
      .set('authorization', `Bearer ${access2}`)
      .send({});
    expect(logoutRes.status).toBe(204);

    // /v1/me with access2 must now 401 (jti denylisted).
    const meAfterLogout = await request(server)
      .get('/v1/me')
      .set('authorization', `Bearer ${access2}`);
    expect(meAfterLogout.status).toBe(401);
  }, 30_000);
});
