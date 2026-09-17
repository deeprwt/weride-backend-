import { Prisma } from '@prisma/client';
import type { ProfileUpdateInput } from '@uride/validation';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.module';
import { OtpProvider } from '../../common/otp/otp-provider.interface';
import { TokenIssuer } from '../../common/identity/token-issuer.interface';
import { IdentityProvider } from '../../common/identity/identity-provider.interface';
import { SessionService } from '../../common/session/session.service';
import { PasswordService } from '../../common/password/password.service';
import { TotpService } from '../../common/totp/totp.service';
import { OtpAttemptsService } from './otp-attempts.service';
import type { UserRole } from '@prisma/client';
import { loadEnv } from '../../config/env';

export interface AuthContext {
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpProvider,
    private readonly issuer: TokenIssuer,
    private readonly identity: IdentityProvider,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly attempts: OtpAttemptsService,
  ) {}

  // -------------------------------------------------------------------------
  // Phone OTP — riders + drivers
  // -------------------------------------------------------------------------

  async requestOtp(phone: string, ip?: string): Promise<void> {
    const env = loadEnv();
    if (env.AUTH_PROVIDER === 'supabase') {
      throw new BadRequestException(
        'In supabase mode, the client calls supabase.auth.signInWithOtp directly.',
      );
    }
    const ok = await this.attempts.checkAndCount(phone, ip);
    if (!ok) throw new ForbiddenException('Too many requests. Try again shortly.');
    await this.otp.send(phone);
  }

  async verifyOtp(
    phone: string,
    code: string,
    ctx: AuthContext,
  ): Promise<{ tokens: TokenPair; user: { id: string; phone: string | null; roles: string[] } }> {
    const outcome = await this.otp.verify({ phone, code });
    await this.attempts.record(phone, ctx.ip, outcome.ok);
    if (!outcome.ok) {
      const message =
        outcome.reason === 'too_many_attempts'
          ? 'Too many attempts.'
          : outcome.reason === 'expired'
            ? 'Code expired. Request a new one.'
            : 'Invalid code.';
      throw new UnauthorizedException(message);
    }

    // Upsert user; default role = rider. Driver role assignment happens in Phase 2.
    const user = await this.prisma.user.upsert({
      where: { phone },
      update: { phoneVerifiedAt: new Date(), lastLoginAt: new Date() },
      create: {
        phone,
        phoneVerifiedAt: new Date(),
        lastLoginAt: new Date(),
        authProvider: 'local',
        roles: { create: [{ role: 'rider' }] },
      },
      include: { roles: true },
    });
    const roles = user.roles.map((r) => r.role);

    const tokens = await this.mintAndPersist({
      userId: user.id,
      phone: user.phone,
      email: user.email,
      roles,
      surface: 'mobile',
      ctx,
    });

    return {
      tokens,
      user: toSessionUser(user, roles),
    };
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string, ctx: AuthContext): Promise<TokenPair> {
    // 1. Validate the old refresh (throws on unknown/expired/replay).
    const existing = await this.sessions.lookupForRotation(refreshToken);

    // 2. Load user identity for correctly-scoped new tokens.
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: existing.userId },
      include: { roles: true },
    });

    // 3. Mint new tokens.
    const issued = await this.issuer.issueTokens({
      userId: user.id,
      phone: user.phone,
      email: user.email,
      roles: user.roles.map((r) => r.role),
      surface: existing.surface,
    });

    // 4. Atomically revoke old + persist new in the same family.
    await this.sessions.commitRotation({
      oldSessionId: existing.sessionId,
      familyId: existing.familyId,
      surface: existing.surface,
      userId: user.id,
      newRefreshToken: issued.refreshToken,
      newExpiresAt: issued.refreshExpiresAt,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      deviceLabel: existing.deviceLabel,
    });

    return {
      accessToken: issued.accessToken,
      accessExpiresAt: issued.accessExpiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------

  async logout(
    accessJti: string,
    accessExp: number,
    refreshToken?: string,
  ): Promise<void> {
    await this.sessions.denyAccessJti(accessJti, accessExp);
    if (refreshToken) await this.sessions.revokeByToken(refreshToken, 'logout');
  }

  // -------------------------------------------------------------------------
  // Admin login (email + password + TOTP)
  // -------------------------------------------------------------------------

  async adminLogin(
    email: string,
    password: string,
    totpCode: string | undefined,
    ctx: AuthContext,
  ): Promise<
    | { kind: 'tokens'; tokens: TokenPair; user: SessionUserPayload }
    | { kind: 'totp_required' }
    | { kind: 'totp_enrollment_required' }
  > {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { roles: true },
    });
    const isAdmin = user?.roles.some((r) => ['admin', 'ops', 'support'].includes(r.role));
    if (!user || !user.passwordHash || !isAdmin) {
      // Constant-time-ish: do a fake hash to even out timing.
      await this.passwords.verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHRzYWx0dGVzdA$YWJjZGVmZ2hpamtsbW5vcA',
        password,
      );
      throw new UnauthorizedException('Invalid credentials.');
    }
    const ok = await this.passwords.verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials.');

    // First login: force TOTP enrollment.
    if (!user.totpEnrolledAt) return { kind: 'totp_enrollment_required' };

    if (!totpCode) return { kind: 'totp_required' };

    const totpOk = this.totp.verifyToken(user.totpSecretEncrypted ?? '', totpCode);
    if (!totpOk) {
      // Try as recovery code.
      if (!(await this.consumeRecoveryCode(user.id, totpCode))) {
        throw new UnauthorizedException('Invalid 2FA code.');
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const roles = user.roles.map((r) => r.role);
    const tokens = await this.mintAndPersist({
      userId: user.id,
      phone: user.phone,
      email: user.email,
      roles,
      surface: 'admin-web',
      ctx,
    });

    return {
      kind: 'tokens',
      tokens,
      user: toSessionUser(user, roles),
    };
  }

  async adminTotpEnroll(email: string, password: string): Promise<{
    secret: string;
    otpauthUrl: string;
    qrDataUrl: string;
    recoveryCodes: string[];
  }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { roles: true },
    });
    const isAdmin = user?.roles.some((r) => ['admin', 'ops', 'support'].includes(r.role));
    if (!user || !user.passwordHash || !isAdmin) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const ok = await this.passwords.verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials.');
    if (user.totpEnrolledAt) throw new ConflictException('TOTP already enrolled.');

    const enrollment = await this.totp.enroll(email);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecretEncrypted: enrollment.secretEncrypted,
        recoveryCodes: enrollment.recoveryCodes.hashed.map((h) => ({
          hash: h,
          consumedAt: null,
        })),
      },
    });
    return {
      secret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
      qrDataUrl: enrollment.qrDataUrl,
      recoveryCodes: enrollment.recoveryCodes.plain,
    };
  }

  async adminTotpConfirm(
    email: string,
    password: string,
    code: string,
    ctx: AuthContext,
  ): Promise<{ tokens: TokenPair; user: SessionUserPayload }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { roles: true },
    });
    if (!user || !user.passwordHash || !user.totpSecretEncrypted) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    if (!(await this.passwords.verifyPassword(user.passwordHash, password))) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    if (!this.totp.verifyToken(user.totpSecretEncrypted, code)) {
      throw new UnauthorizedException('Invalid 2FA code.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpEnrolledAt: new Date(), lastLoginAt: new Date() },
    });
    const roles = user.roles.map((r) => r.role);
    const tokens = await this.mintAndPersist({
      userId: user.id,
      phone: user.phone,
      email: user.email,
      roles,
      surface: 'admin-web',
      ctx,
    });
    return { tokens, user: toSessionUser(user, roles) };
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: true },
      omit: { passwordHash: true, totpSecretEncrypted: true, recoveryCodes: true },
    });
  }

  async updateMe(userId: string, patch: ProfileUpdateInput) {
    const data: Prisma.UserUpdateInput = {};
    if (patch.fullName !== undefined) data.fullName = patch.fullName;
    if (patch.locale !== undefined) data.locale = patch.locale;
    if (patch.gender !== undefined) data.gender = patch.gender;
    if (patch.dateOfBirth !== undefined) {
      // Stored as a DATE; midnight UTC so the calendar day never shifts.
      data.dateOfBirth = patch.dateOfBirth ? new Date(`${patch.dateOfBirth}T00:00:00Z`) : null;
    }
    if (patch.emergencyContact !== undefined) {
      // Written as a pair to satisfy users_emergency_contact_pair.
      data.emergencyContactName = patch.emergencyContact?.name ?? null;
      data.emergencyContactPhone = patch.emergencyContact?.phone ?? null;
    }
    if (patch.email !== undefined) {
      const current = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      if (patch.email !== current.email) {
        data.email = patch.email;
        // A changed address is an unverified address. Leaving the old
        // verification in place would vouch for an inbox nobody has proven.
        data.emailVerifiedAt = null;
      }
    }

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data,
        include: { roles: true },
        omit: { passwordHash: true, totpSecretEncrypted: true, recoveryCodes: true },
      });
    } catch (err) {
      // users.email is unique. Say so plainly instead of a 500 — and without
      // confirming whose account holds the address.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'email_in_use',
          message: 'That email address is already in use.',
        });
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async mintAndPersist(args: {
    userId: string;
    phone: string | null;
    email: string | null;
    roles: UserRole[] | string[];
    surface: 'mobile' | 'admin-web';
    ctx: AuthContext;
  }): Promise<TokenPair> {
    const issued = await this.issuer.issueTokens({
      userId: args.userId,
      phone: args.phone,
      email: args.email,
      roles: args.roles as string[],
      surface: args.surface,
    });
    await this.sessions.create({
      userId: args.userId,
      surface: args.surface,
      refreshToken: issued.refreshToken,
      expiresAt: issued.refreshExpiresAt,
      ip: args.ctx.ip,
      userAgent: args.ctx.userAgent,
      deviceLabel: args.ctx.deviceLabel,
    });
    return {
      accessToken: issued.accessToken,
      accessExpiresAt: issued.accessExpiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
    };
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !Array.isArray(user.recoveryCodes)) return false;
    const codes = user.recoveryCodes as Array<{ hash: string; consumedAt: string | null }>;
    const hashed = this.totp.hashRecoveryCode(code);
    const idx = codes.findIndex((c) => c.hash === hashed && !c.consumedAt);
    if (idx === -1) return false;
    codes[idx] = { hash: hashed, consumedAt: new Date().toISOString() };
    await this.prisma.user.update({
      where: { id: userId },
      data: { recoveryCodes: codes },
    });
    const remaining = codes.filter((c) => !c.consumedAt).length;
    this.logger.warn(`recovery_code.consumed user=${userId} remaining=${remaining}`);
    return true;
  }
}

/**
 * Shape returned to clients in the auth payload. Includes `locale` so the
 * mobile apps can pick the right t() dictionary from the moment the session
 * lands, without an extra /me roundtrip.
 */
export interface SessionUserPayload {
  id: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
  locale: 'en-CA' | 'fr-CA';
  roles: string[];
}

function toSessionUser(
  user: { id: string; phone: string | null; email: string | null; fullName: string | null; locale: string },
  roles: string[],
): SessionUserPayload {
  const locale: SessionUserPayload['locale'] = user.locale === 'fr-CA' ? 'fr-CA' : 'en-CA';
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    fullName: user.fullName,
    locale,
    roles,
  };
}
