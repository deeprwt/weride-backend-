import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { User, UserRoleAssignment } from '@prisma/client';
import { profileUpdateSchema, type ProfileUpdateInput } from '@uride/validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuthService } from './auth.service';

type ProfileRow = Omit<User, 'passwordHash' | 'totpSecretEncrypted' | 'recoveryCodes'> & {
  roles: UserRoleAssignment[];
};

/**
 * GET and PATCH return the SAME shape. Before, PATCH returned a narrower object
 * than GET, so a client that rendered the PATCH response lost `createdAt` and
 * showed "Member since" as blank right after saving a name.
 */
function toProfile(user: ProfileRow) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    fullName: user.fullName,
    locale: user.locale,
    roles: user.roles.map((r) => r.role),
    gender: user.gender,
    // A calendar date travels as YYYY-MM-DD, never as an instant.
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
    emergencyContact:
      user.emergencyContactName && user.emergencyContactPhone
        ? { name: user.emergencyContactName, phone: user.emergencyContactPhone }
        : null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async me(@CurrentUser() principal: RequestPrincipal) {
    return toProfile(await this.auth.me(principal.userId));
  }

  @Patch()
  async update(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(profileUpdateSchema)) body: ProfileUpdateInput,
  ) {
    return toProfile(await this.auth.updateMe(principal.userId, body));
  }
}
