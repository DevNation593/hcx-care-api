import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, IssuedSession } from './auth.service';
import {
  clearRefreshCookie,
  hasAmbiguousRefreshCookie,
  isWebClient,
  readAllRefreshCookies,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-token';
import {
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangeOwnPasswordDto,
  DisableMfaDto,
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

/**
 * Answers with a session that was just issued. Only the web client (`X-Client: web`) gets the
 * HttpOnly `refresh_token` cookie, and then the body does not carry the token, so its JavaScript
 * never reads it. Any other client (mobile, Postman) gets no cookie and the token in the body,
 * as before. The cookie is set only for the header because it is a non-simple one: a page of
 * another site cannot send it without a CORS preflight, so it cannot make the browser of a
 * victim sign in as the attacker (login CSRF) or swap the cookie with a token of the attacker.
 * `refreshTokenExpiresAt` only feeds the cookie.
 * (A function, not a method: the role matrix lists every method of a controller as a route.)
 */
function sessionResponse(req: Request, res: Response, issued: IssuedSession) {
  const { refreshTokenExpiresAt, ...body } = issued;
  if (!isWebClient(req)) return body;
  setRefreshCookie(res, issued.refreshToken, refreshTokenExpiresAt);
  const { refreshToken, ...webBody } = body;
  void refreshToken; // travels in the cookie only
  return webBody;
}

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
      'An account with two-factor sign-in gets { mfaRequired, mfaToken } instead of tokens: it continues with POST /auth/mfa/verify. ' +
      'With `X-Client: web` the refresh token is set only in the HttpOnly `refresh_token` cookie and is not in the body; without it there is no cookie and the body carries the token.',
  })
  @ApiHeader({ name: 'X-Client', required: false, description: '`web` for the web client.' })
  @ApiResponse({ status: 200, description: 'Login successful', type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(loginDto);
    if ('mfaRequired' in result) return result;
    return sessionResponse(req, res, result);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Second step of a sign-in: a TOTP code or a recovery code' })
  @ApiHeader({ name: 'X-Client', required: false, description: '`web` for the web client.' })
  @ApiResponse({ status: 401, description: 'MFA_CODE_INVALID or MFA_CHALLENGE_EXPIRED' })
  async verifyMfa(
    @Body() dto: VerifyMfaLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sessionResponse(req, res, await this.authService.verifyMfaLogin(dto));
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
  async enableMfa(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { recoveryCodes } = await this.mfa.enable(user.userId, dto.code);
    const session = await this.authService.sessionAfterMfaEnrolment(user.userId);
    return { recoveryCodes, ...sessionResponse(req, res, session) };
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
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'The refresh token comes in the body (mobile) or in the `refresh_token` cookie (web). Only a request with `X-Client: web` receives the cookie. ' +
      'A token read from the cookie requires `X-Client: web` (403 otherwise): it is a non-simple ' +
      'header, so a cross-site page cannot send it without a CORS preflight. The token is rotated ' +
      'and the cookie is replaced.',
  })
  @ApiHeader({ name: 'X-Client', required: false, description: '`web` for the web client.' })
  @ApiResponse({ status: 200, description: 'Token refreshed', type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing refresh token' })
  @ApiResponse({ status: 403, description: 'Cookie used without the X-Client: web header' })
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A token in the body is a credential the caller had to know; one in the cookie is sent by
    // the browser on its own, which is what the header requirement defends.
    const fromBody = refreshTokenDto.refreshToken;
    // Several refresh_token cookies mean one was planted: none of them is trusted. No Set-Cookie
    // is sent: a deletion only reaches the cookie that has the same Domain and Path, so it cannot
    // remove the planted one and would only drop the real cookie of the session.
    if (!fromBody && hasAmbiguousRefreshCookie(req)) {
      throw new UnauthorizedException('Token de actualización inválido');
    }
    const cookie = fromBody ? undefined : readRefreshCookie(req);
    const token = fromBody ?? cookie;
    if (!token) throw new UnauthorizedException('Token de actualización inválido');
    if (cookie && !isWebClient(req)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'CLIENT_HEADER_REQUIRED',
        message: 'La renovación con cookie requiere la cabecera X-Client: web.',
      });
    }
    try {
      return sessionResponse(req, res, await this.authService.refreshTokens(token));
    } catch (error) {
      // A rejected token (expired, revoked, reused) is useless: the browser stops sending it.
      // Any other failure (database down, timeout) says nothing about the token: the cookie stays.
      if (cookie && error instanceof UnauthorizedException) clearRefreshCookie(res);
      throw error;
    }
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
  async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.resetPassword(resetPasswordDto.token, resetPasswordDto.password);
    // Every session of the account just ended, including the one of this browser.
    clearRefreshCookie(res);
    return { message: 'Password reset successful' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout current session',
    description:
      'Revokes the refresh token of the body or, without one, of the `refresh_token` cookie, and clears the cookie.',
  })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(
    @CurrentUser() user: AuthUser,
    @Body() body: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Even with several (planted) cookies every value is revoked, bound to this user.
    await this.authService.logout(
      user.userId,
      body.refreshToken ? [body.refreshToken] : readAllRefreshCookies(req),
    );
    clearRefreshCookie(res);
    return { message: 'Logged out successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @SessionRoute()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout from all sessions' })
  @ApiResponse({ status: 200, description: 'Logged out from all devices' })
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(user.userId);
    clearRefreshCookie(res);
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
