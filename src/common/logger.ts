import type { Params } from 'nestjs-pino';
import { loadEnv } from '../config/env';

export function pinoOptions(): Params {
  const env = loadEnv();
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
      transport: env.LOG_PRETTY
        ? {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,req.headers,res.headers',
            },
          }
        : undefined,
      // Strip PII / secrets from logs.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
          'req.body.password',
          'req.body.code',
          'req.body.totp',
        ],
        censor: '[redacted]',
      },
      autoLogging: {
        ignore: (req) =>
          req.url === '/healthz' || req.url === '/readyz' || req.url?.startsWith('/docs') === true,
      },
    },
  };
}
