import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  adminLoginSchema,
  adminTotpConfirmSchema,
  adminTotpEnrollSchema,
  refreshSchema,
  requestOtpSchema,
  verifyOtpSchema,
  type RefreshInput,
  type RequestOtpInput,
  type VerifyOtpInput,
  type AdminLoginInput,
  type AdminTotpEnrollInput,
  type AdminTotpConfirmInput,
} from '@uride/validation';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ---- Phone OTP ----

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestOtp(
    @Body(new ZodValidationPipe(requestOtpSchema)) body: RequestOtpInput,
    @Ip() ip: string,
  ): Promise<void> {
    await this.auth.requestOtp(body.phone, ip);
  }

  @Public()
  @Post('otp/verify')
  async verifyOtp(
    @Body(new ZodValidationPipe(verifyOtpSchema)) body: VerifyOtpInput,
    @Req() req: Request,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.verifyOtp(body.phone, body.code, { ip, userAgent: ua });
  }

  // ---- Refresh / Logout ----

  @Public()
  @Post('refresh')
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    return { tokens: await this.auth.refresh(body.refreshToken, { ip, userAgent: ua }) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: { refreshToken?: string } = {},
  ): Promise<void> {
    await this.auth.logout(principal.jti, principal.exp, body.refreshToken);
  }

  // ---- Admin (email + password + TOTP) ----

  @Public()
  @Post('admin/login')
  async adminLogin(
    @Body(new ZodValidationPipe(adminLoginSchema)) body: AdminLoginInput,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.adminLogin(body.email, body.password, body.totp, { ip, userAgent: ua });
  }

  @Public()
  @Post('admin/totp/enroll')
  async adminTotpEnroll(@Body(new ZodValidationPipe(adminTotpEnrollSchema)) body: AdminTotpEnrollInput) {
    return this.auth.adminTotpEnroll(body.email, body.password);
  }

  @Public()
  @Post('admin/totp/confirm')
  async adminTotpConfirm(
    @Body(new ZodValidationPipe(adminTotpConfirmSchema)) body: AdminTotpConfirmInput,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.adminTotpConfirm(body.email, body.password, body.code, { ip, userAgent: ua });
  }
}
