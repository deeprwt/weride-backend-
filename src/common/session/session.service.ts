import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';
import { hashRefreshToken } from '../identity/local-identity.provider';
import type { AuthSurface } from '../identity/identity-provider.interface';

const DENYLIST_KEY = (jti: string) => `denylist:jti:${jti}`;

export interface CreateSessionInput {
  userId: string;
  surface: AuthSurface;
  refreshToken: string;
  expiresAt: Date;
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
  /** When rotating, pass the family of the previous session. */
  familyId?: string;
}

/**
 * SessionService — owns refresh-token rotation, reuse detection, and access-
 * token denylisting on logout.
 *
 * Strategy:
 *  - Every refresh issues a new token within the same `family_id`.
 *  - The previous session row is marked revoked.
 *  - If a refresh token is presented whose row has `revoked_at` set, that's a
 *    REPLAY — revoke the entire family (defense against stolen refresh tokens).
 *  - On logout: revoke current refresh row + add the access-token jti to a
 *    Redis denylist until its exp.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Initial session at login. Starts a new family. */
  async create(input: CreateSessionInput): Promise<{ id: string; familyId: string }> {
    const familyId = input.familyId ?? randomUUID();
    const row = await this.prisma.authSession.create({
      data: {
        userId: input.userId,
        familyId,
        refreshTokenHash: hashRefreshToken(input.refreshToken),
        deviceLabel: input.deviceLabel,
        ip: input.ip,
        userAgent: input.userAgent,
        surface: input.surface,
        expiresAt: input.expiresAt,
      },
      select: { id: true, familyId: true },
    });
    return row;
  }

  /**
   * Look up + validate the old refresh token without mutating it.
   * Returns the existing session row's identity context so the caller can
   * mint correctly-scoped new tokens. THROWS on unknown / expired / replay.
   *
   * On replay (presented token whose `revokedAt` is already set), the entire
   * family is revoked — defense against stolen refresh tokens.
   */
  async lookupForRotation(oldRefreshToken: string): Promise<{
    sessionId: string;
    userId: string;
    surface: AuthSurface;
    familyId: string;
    deviceLabel: string | null;
  }> {
    const existing = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hashRefreshToken(oldRefreshToken) },
    });
    if (!existing) throw new UnauthorizedException('Unknown refresh token.');

    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId, 'refresh_token_replay');
      this.logger.warn(
        `Refresh token replay detected for family ${existing.familyId} (user ${existing.userId}); family revoked.`,
      );
      throw new UnauthorizedException('Refresh token replay detected.');
    }
    if (existing.expiresAt < new Date()) {
      await this.prisma.authSession.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });
      throw new UnauthorizedException('Refresh token expired.');
    }
    return {
      sessionId: existing.id,
      userId: existing.userId,
      surface: existing.surface as AuthSurface,
      familyId: existing.familyId,
      deviceLabel: existing.deviceLabel,
    };
  }

  /**
   * Atomically revoke the old session and persist the new refresh token row
   * within the same family. Call AFTER lookupForRotation has validated.
   */
  async commitRotation(input: {
    oldSessionId: string;
    familyId: string;
    surface: AuthSurface;
    userId: string;
    newRefreshToken: string;
    newExpiresAt: Date;
    ip?: string;
    userAgent?: string;
    deviceLabel?: string | null;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.authSession.update({
        where: { id: input.oldSessionId },
        data: { revokedAt: new Date(), revokedReason: 'rotated' },
      }),
      this.prisma.authSession.create({
        data: {
          userId: input.userId,
          familyId: input.familyId,
          refreshTokenHash: hashRefreshToken(input.newRefreshToken),
          deviceLabel: input.deviceLabel ?? undefined,
          ip: input.ip,
          userAgent: input.userAgent,
          surface: input.surface,
          expiresAt: input.newExpiresAt,
        },
      }),
    ]);
  }

  /** Revoke a single session by its raw refresh token (logout path). */
  async revokeByToken(refreshToken: string, reason: string): Promise<void> {
    const hash = hashRefreshToken(refreshToken);
    await this.prisma.authSession.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revoke every active session in a family. */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Add an access-token JTI to the denylist until its exp. */
  async denyAccessJti(jti: string, expUnixSeconds: number): Promise<void> {
    const ttl = expUnixSeconds - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return; // already expired — nothing to deny
    await this.redis.client.set(DENYLIST_KEY(jti), '1', 'EX', ttl);
  }

  async isAccessJtiDenied(jti: string): Promise<boolean> {
    const v = await this.redis.client.get(DENYLIST_KEY(jti));
    return v !== null;
  }
}
