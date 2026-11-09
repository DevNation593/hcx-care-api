import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { getActivityWriteIntervalMs, getInactivityTimeoutMs } from '../session-inactivity';
import { MfaService } from '../mfa.service';

interface JwtPayload {
  sub: string; // userId
  email: string;
  tenantId: string;
  role: string;
  iat?: number; // seconds
  issuedAtMs?: number;
}

/**
 * Whether the token was issued before the account enabled two-factor sign-in: such a session
 * was opened with the password alone and ended then. Tokens without `issuedAtMs` (older than it)
 * fall back to `iat`, rounded down, so they are never taken as newer than they are.
 */
export function issuedBeforeMfaEnabled(
  payload: Pick<JwtPayload, 'iat' | 'issuedAtMs'>,
  mfaEnabledAt: Date | null,
): boolean {
  if (!mfaEnabledAt) return false;
  const issuedAt = payload.issuedAtMs ?? (payload.iat ?? 0) * 1000;
  return issuedAt < mfaEnabledAt.getTime();
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private mfa: MfaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    // Verify user still exists and is active
    const user = await this.prisma.withRlsContext(
      {
        tenantId: payload.tenantId,
        userId: payload.sub,
        role: payload.role,
      },
      () =>
        this.prisma.user.findUnique({
          where: { id: payload.sub },
          include: { tenant: { include: { settings: { select: { requireMfa: true } } } } },
        }),
    );

    if (!user || !user.isActive || !user.tenant.isActive || user.tenantId !== payload.tenantId) {
      throw new UnauthorizedException('User or tenant is inactive');
    }

    if (issuedBeforeMfaEnabled(payload, user.mfaEnabledAt)) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'SESSION_ENDED_BY_MFA',
        message: 'Se activó la verificación en dos pasos. Inicia sesión otra vez.',
      });
    }

    const idleMs = user.lastActivityAt ? Date.now() - user.lastActivityAt.getTime() : null;

    if (idleMs !== null && idleMs > getInactivityTimeoutMs()) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('La sesión expiró por inactividad');
    }

    if (idleMs === null || idleMs > getActivityWriteIntervalMs()) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActivityAt: new Date() },
      });
    }

    return {
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
      isPlatformTenant: user.tenant.isPlatform,
      mustChangePassword: user.mustChangePassword,
      mfaEnrollmentRequired: this.mfa.enrollmentRequired(user),
    };
  }
}
