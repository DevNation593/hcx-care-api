import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { LoginDto, AuthResponseDto, MfaChallengeDto, VerifyMfaLoginDto } from './dto/auth.dto';
import { MfaService } from './mfa.service';
import { getInactivityTimeoutMs } from './session-inactivity';
import { sessionEnded } from './session-version';
import { hashRefreshToken } from './refresh-token';
import { MailService } from '../mail/mail.service';

type JwtExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

/** The errors `jsonwebtoken` throws for a token that is malformed, forged, expired or not yet valid. */
function isJwtError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'JsonWebTokenError' || name === 'TokenExpiredError' || name === 'NotBeforeError';
}

/**
 * A session as the service issues it: the body of the response plus when its refresh token
 * expires, which the controller turns into the `Max-Age` of the cookie and never sends to the
 * client.
 */
export type IssuedSession = Omit<AuthResponseDto, 'refreshToken'> & {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mail: MailService,
    private mfa: MfaService,
  ) {}

  /**
   * The first step of a sign-in. An account with two-factor sign-in gets a short-lived challenge
   * instead of tokens, and completes it with `verifyMfaLogin`.
   */
  async login(loginDto: LoginDto): Promise<IssuedSession | MfaChallengeDto> {
    const { email, password } = loginDto;

    const users = await this.prisma.user.findMany({
      where: {
        email,
        isActive: true,
        tenant: { isActive: true },
      },
      include: {
        tenant: { include: { settings: { select: { requireMfa: true } } } },
        professionalProfile: { include: { specialty: true } },
      },
    });

    if (users.length === 0) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const matchingUsers: typeof users = [];
    for (const candidate of users) {
      const isPasswordValid = await bcrypt.compare(password, candidate.password);
      if (isPasswordValid) {
        matchingUsers.push(candidate);
      }
    }

    if (matchingUsers.length === 0) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (matchingUsers.length > 1) {
      // Deterministic fallback for legacy data with duplicate email+password across tenants.
      matchingUsers.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }

    const user = matchingUsers[0];

    if (user.mfaEnabledAt) {
      return { mfaRequired: true, mfaToken: this.mfa.challengeToken(user.id) };
    }
    return this.openSession(user);
  }

  /** The second step: a code of the authenticator app, or one of the recovery codes. */
  async verifyMfaLogin(dto: VerifyMfaLoginDto): Promise<IssuedSession> {
    const userId = this.mfa.userIdOfChallenge(dto.mfaToken);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, tenant: { isActive: true } },
      include: {
        tenant: { include: { settings: { select: { requireMfa: true } } } },
        professionalProfile: { include: { specialty: true } },
      },
    });
    if (!user?.mfaEnabledAt) throw new UnauthorizedException('Credenciales inválidas');
    if (!(await this.mfa.verify(user, { code: dto.code, recoveryCode: dto.recoveryCode }))) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'MFA_CODE_INVALID',
        message: 'El código no es correcto o ya se usó.',
      });
    }
    return this.openSession(user);
  }

  /**
   * A new session for the account that just confirmed its second factor. Enabling it ends every
   * other session (they never passed it), so the one that confirmed the code continues with this.
   */
  async sessionAfterMfaEnrolment(userId: string): Promise<IssuedSession> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, tenant: { isActive: true } },
      include: {
        tenant: { include: { settings: { select: { requireMfa: true } } } },
        professionalProfile: { include: { specialty: true } },
      },
    });
    if (!user?.mfaEnabledAt) throw new UnauthorizedException('Usuario no encontrado');
    return this.openSession(user);
  }

  private async openSession(user: any): Promise<IssuedSession> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastActivityAt: new Date() },
    });
    const tokens = await this.generateTokens(user);
    return { ...tokens, user: this.sessionUser(user) };
  }

  /** The account as the clients keep it after signing in or refreshing. */
  private sessionUser(user: any): AuthResponseDto['user'] {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
      professionalProfile: user.professionalProfile ?? undefined,
      mfaEnabled: Boolean(user.mfaEnabledAt),
      mfaEnrollmentRequired: this.mfa.enrollmentRequired(user),
    };
  }

  async refreshTokens(refreshToken: string): Promise<IssuedSession> {
    try {
      // Verify refresh token
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
      return await this.prisma.withRlsContext(
        {
          tenantId: payload.tenantId,
          userId: payload.sub,
          role: payload.role,
        },
        async () => {
          // Find refresh token in database
          const storedToken = await this.prisma.refreshToken.findUnique({
            where: { token: hashRefreshToken(refreshToken) },
            include: {
              user: {
                include: {
                  tenant: { include: { settings: { select: { requireMfa: true } } } },
                  professionalProfile: { include: { specialty: true } },
                },
              },
            },
          });

          if (!storedToken || storedToken.isRevoked) {
            // Token reuse detected - revoke entire token family
            if (storedToken?.familyId) {
              await this.revokeTokenFamily(storedToken.familyId);
            }
            throw new UnauthorizedException('Token de actualización inválido');
          }

          // Check expiration
          if (new Date() > storedToken.expiresAt) {
            throw new UnauthorizedException('El token de actualización ha expirado');
          }

          const user = storedToken.user;

          if (!user.isActive || !user.tenant.isActive) {
            throw new UnauthorizedException('El usuario o el consultorio están inactivos.');
          }

          // Issued under an earlier session version: the second factor was enabled or reset
          // after it, possibly while the sign-in that created it was still running.
          if (sessionEnded(payload, user)) {
            await this.revokeTokenFamily(storedToken.familyId);
            throw new UnauthorizedException('La sesión terminó');
          }

          if (
            user.lastActivityAt &&
            Date.now() - user.lastActivityAt.getTime() > getInactivityTimeoutMs()
          ) {
            await this.prisma.refreshToken.updateMany({
              where: { userId: user.id, isRevoked: false },
              data: { isRevoked: true },
            });
            throw new UnauthorizedException('La sesión expiró por inactividad');
          }

          await this.prisma.user.update({
            where: { id: user.id },
            data: { lastActivityAt: new Date() },
          });

          // Revoke old refresh token
          await this.prisma.refreshToken.update({
            where: { id: storedToken.id },
            data: { isRevoked: true },
          });

          // Generate new tokens with same family
          const tokens = await this.generateTokens(user, storedToken.familyId);

          return { ...tokens, user: this.sessionUser(user) };
        },
      );
    } catch (error) {
      // Only a token that is wrong answers 401 (and makes the web client drop its cookie and
      // sign out). A failure of the database or of anything else says nothing about the token:
      // it surfaces as a 5xx so the client keeps the session and tries again.
      if (error instanceof UnauthorizedException) throw error;
      if (isJwtError(error)) throw new UnauthorizedException('Token de actualización inválido');
      throw error;
    }
  }

  /**
   * Revokes the given refresh token(s) of the user: several when the request carried more than
   * one `refresh_token` cookie. Always bound to `userId`, so a token of another account is never
   * touched.
   */
  async logout(userId: string, refreshTokens: string | string[] | undefined): Promise<void> {
    const tokens = (Array.isArray(refreshTokens) ? refreshTokens : [refreshTokens]).filter(
      (token): token is string => !!token,
    );
    // Without a token there is nothing to revoke: `token: undefined` would match every session.
    if (tokens.length === 0) return;
    await this.prisma.refreshToken.updateMany({
      where: { userId, token: { in: tokens.map(hashRefreshToken) } },
      data: { isRevoked: true },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    // Revoke all refresh tokens for user
    await this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { isRevoked: true },
    });
  }

  /**
   * Lets an authenticated user replace their own password, including a temporary one.
   * The new password is hashed exactly as received and never logged.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, isActive: true } });
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    if (await bcrypt.compare(newPassword, user.password)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PASSWORD_UNCHANGED',
        message: 'La nueva contraseña debe ser distinta de la actual',
      });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: await this.hashPassword(newPassword), mustChangePassword: false },
    });
  }

  async requestPasswordReset(email: string): Promise<void> {
    // Avoid email enumeration: always return success.
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true, tenant: { isActive: true } },
      // Deterministic choice when the same email exists in several tenants.
      orderBy: { updatedAt: 'desc' },
    });

    if (!user) {
      return;
    }

    const expiresIn = this.configService.get<string>('JWT_RESET_EXPIRATION') || '1h';
    const token = this.jwtService.sign(
      {
        sub: user.id,
        tenantId: user.tenantId,
        type: 'password-reset',
      },
      {
        secret: this.getResetSecret(user.password),
        expiresIn: expiresIn as JwtExpiresIn,
      },
    );

    // Not awaited: the response must take the same time whether or not the account exists.
    // The token grants access to the account, so it travels only inside the message.
    void this.mail.sendPasswordReset(user.email, {
      firstName: user.firstName,
      token,
      expiresIn,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    try {
      const unverified = this.jwtService.decode(token) as {
        sub?: string;
        tenantId?: string;
      } | null;

      if (!unverified?.sub || !unverified.tenantId) {
        throw new BadRequestException('Token de restablecimiento inválido');
      }

      const user = await this.prisma.user.findFirst({
        where: { id: unverified.sub, tenantId: unverified.tenantId, isActive: true },
      });

      if (!user) {
        throw new BadRequestException('Token de restablecimiento inválido');
      }

      // The current password hash is part of the signing secret, so the token
      // stops being valid as soon as the password changes (single use).
      const payload = this.jwtService.verify(token, {
        secret: this.getResetSecret(user.password),
      }) as { sub: string; tenantId: string; type?: string };

      if (payload.type !== 'password-reset') {
        throw new BadRequestException('Token de restablecimiento inválido');
      }

      const hashedPassword = await this.hashPassword(newPassword);

      await this.prisma.withRlsContext(
        {
          tenantId: payload.tenantId,
          userId: payload.sub,
        },
        async () => {
          await this.prisma.$transaction(async (tx) => {
            await this.prisma.applyRlsContext(tx);

            await tx.user.update({
              where: { id: user.id },
              data: { password: hashedPassword, mustChangePassword: false },
            });

            // Invalidate all active sessions after password reset.
            await tx.refreshToken.updateMany({
              where: { userId: user.id, isRevoked: false },
              data: { isRevoked: true },
            });
          });
        },
      );
    } catch {
      throw new BadRequestException('Token de restablecimiento inválido o expirado');
    }
  }

  private getResetSecret(passwordHash: string): string {
    const baseSecret =
      this.configService.get<string>('JWT_RESET_SECRET') ||
      this.configService.get<string>('JWT_ACCESS_SECRET');
    return `${baseSecret}:${passwordHash}`;
  }

  private async generateTokens(user: any, familyId?: string) {
    const payload = {
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
      // The version of the account read when this sign-in or refresh started. Enabling or
      // resetting the second factor bumps it, so a token issued from a read made before that is
      // refused even if it is signed after it (see sessionEnded).
      sv: user.sessionVersion ?? 0,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: (this.configService.get<string>('JWT_ACCESS_EXPIRATION') || '15m') as JwtExpiresIn,
    });

    const refreshToken = this.jwtService.sign(
      { ...payload, jti: randomUUID() },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRATION') ||
          '7d') as JwtExpiresIn,
      },
    );

    // Store refresh token with family tracking. The row expires when the JWT does (its `exp`),
    // and only the hash of the token is stored.
    const tokenFamilyId = familyId || randomUUID();
    const { exp } = this.jwtService.decode(refreshToken) as { exp: number };
    const expiresAt = new Date(exp * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: hashRefreshToken(refreshToken),
        familyId: tokenFamilyId,
        expiresAt,
      },
    });

    return { accessToken, refreshToken, refreshTokenExpiresAt: expiresAt };
  }

  private async revokeTokenFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId },
      data: { isRevoked: true },
    });
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }
}
