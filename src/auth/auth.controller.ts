import { Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangeOwnPasswordDto,
  DisableMfaDto,
  MfaChallengeDto,
  MfaCodeDto,
  MfaPasswordDto,
  VerifyMfaLoginDto,
} from './dto/auth.dto';
import { MfaService } from './mfa.service';
import { Public } from '../common/decorators/public.decorator';
import { SessionRoute } from '../common/decorators/session-route.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

// Brute-force limit for the public auth endpoints. AUTH_THROTTLE_LIMIT is only set by the e2e
// setup, whose suites sign in many users from one address within a minute.
const AUTH_THROTTLE = {
  default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT) || 5, ttl: 60000 },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'User login',
    description:
      'An account with two-factor sign-in gets { mfaRequired, mfaToken } instead of tokens: it continues with POST /auth/mfa/verify.',
  })
  @ApiResponse({ status: 200, description: 'Login successful', type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto): Promise<AuthResponseDto | MfaChallengeDto> {
    return this.authService.login(loginDto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Second step of a sign-in: a TOTP code or a recovery code' })
  @ApiResponse({ status: 401, description: 'MFA_CODE_INVALID or MFA_CHALLENGE_EXPIRED' })
  async verifyMfa(@Body() dto: VerifyMfaLoginDto): Promise<AuthResponseDto> {
    return this.authService.verifyMfaLogin(dto);
  }

  // The routes below stay open while the clinic requires a second factor the account has not set
  // up yet (403 MFA_ENROLLMENT_REQUIRED everywhere else): they are how it sets it up.
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Get('mfa')
  @ApiOperation({ summary: 'Two-factor sign-in of the current user' })
  mfaStatus(@CurrentUser() user: AuthUser) {
    return this.mfa.status(user.userId);
  }

  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start the enrolment: a new secret and its QR code (password required)',
  })
  setupMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaPasswordDto) {
    return this.mfa.setup(user.userId, dto.password);
  }

  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the enrolment with a code; returns the recovery codes once',
    description:
      'Ends every other session of the account and returns new tokens for this one, which the client must use from now on.',
  })
  async enableMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto) {
    const { recoveryCodes } = await this.mfa.enable(user.userId, dto.code);
    const session = await this.authService.sessionAfterMfaEnrolment(user.userId);
    return { recoveryCodes, ...session };
  }

  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn two-factor sign-in off (409 MFA_REQUIRED_BY_POLICY)' })
  disableMfa(@CurrentUser() user: AuthUser, @Body() dto: DisableMfaDto) {
    return this.mfa.disable(user.userId, dto.password, dto.code);
  }

  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the recovery codes, after a current code' })
  regenerateRecoveryCodes(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto) {
    return this.mfa.regenerateRecoveryCodes(user.userId, dto.code);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed', type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(refreshTokenDto.refreshToken);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({ status: 200, description: 'Password reset requested' })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(forgotPasswordDto.email);
    return { message: 'If the account exists, a reset link has been sent' };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using reset token' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    await this.authService.resetPassword(resetPasswordDto.token, resetPasswordDto.password);
    return { message: 'Password reset successful' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout current session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@CurrentUser() user: any, @Body() body: { refreshToken: string }) {
    await this.authService.logout(user.userId, body.refreshToken);
    return { message: 'Logged out successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout from all sessions' })
  @ApiResponse({ status: 200, description: 'Logged out from all devices' })
  async logoutAll(@CurrentUser() user: any) {
    await this.authService.logoutAll(user.userId);
    return { message: 'Logged out from all devices' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the password of the current user' })
  @ApiResponse({ status: 200, description: 'Password changed' })
  @ApiResponse({ status: 400, description: 'New password equals the current one' })
  @ApiResponse({ status: 401, description: 'Current password is wrong' })
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangeOwnPasswordDto) {
    await this.authService.changeOwnPassword(user.userId, dto.currentPassword, dto.newPassword);
    return { message: 'Password changed successfully' };
  }
}
