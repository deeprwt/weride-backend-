import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

/**
 * Load `.env` into process.env before anything reads it.
 *
 * This has to happen here, not via ConfigModule. `loadEnv()` runs below —
 * before NestFactory.create() — and memoises its result, so by the time
 * ConfigModule would populate process.env from .env the env snapshot is
 * already cached and already threw on the missing DATABASE_URL. The documented
 * local bootstrap in docs/RUNBOOK.md (`cp .env.example .env` then `npm run dev`)
 * did not work without this.
 *
 * Uses Node's built-in loader rather than the `dotenv` package: `dotenv` is
 * only present as a transitive dependency of @nestjs/config, and importing
 * another package's transitive dep is how you get broken by a minor bump.
 * Node >= 20.12 ships this natively and package.json already requires >= 22.
 *
 * A missing file is not an error — containers and CI inject real environment
 * variables directly, and there is no .env to find.
 */
function loadDotEnvFile(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    // Never let a malformed .env take down a container that was configured
    // entirely through real environment variables.
    // eslint-disable-next-line no-console
    console.warn(`[uride-api] could not read ${path}:`, (err as Error).message);
  }
}

async function bootstrap() {
  loadDotEnvFile();
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    cors: {
      origin: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
    },
  });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz', 'docs'] });
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('WeRide API')
    .setDescription('Core REST API for the WeRide platform.')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`[uride-api] listening on :${env.PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[uride-api] fatal bootstrap error', err);
  process.exit(1);
});
