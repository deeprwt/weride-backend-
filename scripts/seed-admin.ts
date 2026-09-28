/* eslint-disable no-console */
/**
 * Seed (or update) an admin user.
 *
 * Standalone Node script — does NOT bootstrap NestJS or read JWT_LOCAL_SECRET.
 * Hashes the password with the same argon2id parameters as PasswordService
 * so login works against this row immediately.
 *
 * Usage:
 *   pnpm --filter @uride/api seed:admin -- \
 *     --email admin@example.com --password "<strong-12+-char>" [--role admin|ops|support] [--force]
 *
 *   --force allows overwriting an existing user's password + role.
 *   --skip-hibp skips the haveibeenpwned breach check (the API uses this by
 *               default to remain offline-safe — explicit flag keeps the
 *               script deterministic).
 *
 * After seeding, the admin still has NO TOTP — they'll be forced through
 * /login/totp/enroll on first sign-in.
 */

import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { createHash } from 'node:crypto';

const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id — const enum, see PasswordService.

interface Args {
  email: string;
  password: string;
  role: 'admin' | 'ops' | 'support';
  force: boolean;
  skipHibp: boolean;
}

function parseArgs(argv: string[]): Args {
  let email = '';
  let password = '';
  let role: Args['role'] = 'admin';
  let force = false;
  let skipHibp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--email':
        email = next ?? '';
        i++;
        break;
      case '--password':
        password = next ?? '';
        i++;
        break;
      case '--role':
        if (next === 'admin' || next === 'ops' || next === 'support') role = next;
        else die(`invalid --role (must be admin|ops|support): ${next}`);
        i++;
        break;
      case '--force':
        force = true;
        break;
      case '--skip-hibp':
        skipHibp = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        // Unreachable — process.exit does not return. Present so the next case
        // is not read as a fallthrough, which would hide a real one later.
        break;
      default:
        die(`unknown arg: ${a}`);
    }
  }
  if (!email) die('--email is required');
  if (!password) die('--password is required');
  if (password.length < 12) die('--password must be at least 12 characters');
  return { email: email.toLowerCase(), password, role, force, skipHibp };
}

function printHelp(): void {
  console.log(`
Seed (or update) an admin user.

Usage:
  pnpm --filter @uride/api seed:admin -- --email <email> --password <password> [options]

Options:
  --email <email>     (required)
  --password <pw>     (required, min 12 chars)
  --role <r>          admin | ops | support (default: admin)
  --force             overwrite password + grant role on an existing user
  --skip-hibp         skip the haveibeenpwned breach check
  --help, -h          show this help

Example:
  pnpm --filter @uride/api seed:admin -- --email admin@uride.local --password "operate-uride-2026-strong"
`);
}

function die(msg: string): never {
  console.error(`seed:admin: ${msg}`);
  console.error('Run with --help for usage.');
  process.exit(2);
}

async function checkHibp(password: string): Promise<'ok' | 'breached' | 'offline'> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'add-padding': 'true' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return 'offline';
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const [hashSuffix] = line.split(':');
      if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) return 'breached';
    }
    return 'ok';
  } catch {
    return 'offline';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.skipHibp) {
    const status = await checkHibp(args.password);
    if (status === 'breached') {
      die('password appears in a known breach corpus; choose another (or use --skip-hibp).');
    }
    if (status === 'offline') {
      console.warn('seed:admin: HIBP unreachable — proceeding without breach check.');
    }
  }

  const passwordHash = await hash(args.password, {
    algorithm: ARGON2ID,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({
      where: { email: args.email },
      include: { roles: true },
    });

    if (existing && !args.force) {
      die(
        `user ${args.email} already exists (id=${existing.id}). Use --force to overwrite password + grant role.`,
      );
    }

    if (existing && args.force) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash, authProvider: 'local' },
        }),
        prisma.userRoleAssignment.upsert({
          where: { userId_role: { userId: existing.id, role: args.role } },
          create: { userId: existing.id, role: args.role },
          update: {},
        }),
      ]);
      console.log(`seed:admin: updated existing user ${args.email} (id=${existing.id}) with role=${args.role}`);
    } else {
      const created = await prisma.user.create({
        data: {
          email: args.email,
          passwordHash,
          authProvider: 'local',
          roles: { create: [{ role: args.role }] },
        },
      });
      console.log(`seed:admin: created user ${args.email} (id=${created.id}) with role=${args.role}`);
    }

    console.log(`seed:admin: NOTE — admin still has no TOTP enrolled. First /login will route to /login/totp/enroll.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('seed:admin: fatal:', err);
  process.exit(1);
});
