import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityProvider } from '../identity/identity-provider.interface';
import { SessionService } from '../session/session.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityProvider,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token.');
    }
    const token = header.slice(7).trim();
    const verified = await this.identity.verifyAccessToken(token);

    // Denylist check — covers logout + family revocation.
    if (await this.sessions.isAccessJtiDenied(verified.jti)) {
      throw new UnauthorizedException('Token revoked.');
    }

    (req as Request & { user?: unknown }).user = verified;
    return true;
  }
}
