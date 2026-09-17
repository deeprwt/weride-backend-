import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { VerifiedToken } from '../identity/identity-provider.interface';

export interface RequestPrincipal extends VerifiedToken {
  // Convenience aliases set by JwtAuthGuard.
}

/** Pulls the authenticated principal off the request. Use on @Roles-protected handlers. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestPrincipal => {
    const req = ctx.switchToHttp().getRequest<{ user?: RequestPrincipal }>();
    if (!req.user) throw new Error('CurrentUser used on a route without JwtAuthGuard.');
    return req.user;
  },
);
