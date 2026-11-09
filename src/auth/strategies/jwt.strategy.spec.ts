import { MfaService } from '../mfa.service';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UsersController } from '../../users/users.controller';
import { issuedBeforeMfaEnabled, JwtStrategy } from './jwt.strategy';

describe('JwtStrategy current account authority', () => {
  let strategy: JwtStrategy;
  let db: any;
  let user: any;
  const payload = (role: string) => ({
    sub: 'member-1',
    email: 'old-email@example.com',
    tenantId: 'tenant-1',
    role,
  });
  const adminCreateContext = (principal: unknown): ExecutionContext =>
    ({
      getHandler: () => UsersController.prototype.create,
      getClass: () => UsersController,
      switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    user = {
      id: 'member-1',
      tenantId: 'tenant-1',
      email: 'current-email@example.com',
      role: 'ASISTENTE',
      isActive: true,
      lastActivityAt: null,
      mustChangePassword: true,
      tenant: { id: 'tenant-1', isActive: true, isPlatform: false },
    };
    db = {
      withRlsContext: jest.fn(async (_context, callback) => callback()),
      user: {
        findUnique: jest.fn(async () => user),
        update: jest.fn(async () => user),
      },
      refreshToken: { updateMany: jest.fn() },
    };
    strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-jwt-secret') } as unknown as ConfigService,
      db as PrismaService,
      { enrollmentRequired: () => false } as unknown as MfaService,
    );
  });

  it('uses the current assistant role and denies team creation with an old ADMIN token', async () => {
    const principal = await strategy.validate(payload('MASTER'));
    expect(principal).toEqual({
      userId: 'member-1',
      email: 'current-email@example.com',
      tenantId: 'tenant-1',
      role: 'ASISTENTE',
      isPlatformTenant: false,
      mfaEnrollmentRequired: false,
      mustChangePassword: true,
    });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'member-1' },
      include: { tenant: { include: { settings: { select: { requireMfa: true } } } } },
    });
    expect(() =>
      new RolesGuard(new Reflector()).canActivate(adminCreateContext(principal)),
    ).toThrow(ForbiddenException);
  });

  it('honors a current legacy CLIENTE admin even if an old token says PROFESIONAL', async () => {
    user.role = 'MASTER';
    const principal = await strategy.validate(payload('PROFESIONAL'));
    expect(principal.role).toBe('MASTER');
    expect(new RolesGuard(new Reflector()).canActivate(adminCreateContext(principal))).toBe(true);
  });

  it('rejects a token whose tenant no longer matches the persisted account', async () => {
    await expect(strategy.validate({ ...payload('MASTER'), tenantId: 'tenant-2' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(db.user.update).not.toHaveBeenCalled();
  });

  describe('sessions opened before two-factor sign-in was enabled', () => {
    const enabledAt = new Date('2026-11-09T10:00:00.500Z');

    it('ends a session issued before it, even within the same second', async () => {
      user.mfaEnabledAt = enabledAt;
      await expect(
        strategy.validate({ ...payload('ASISTENTE'), issuedAtMs: enabledAt.getTime() - 200 }),
      ).rejects.toMatchObject({ response: { code: 'SESSION_ENDED_BY_MFA' } });
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('keeps the session issued after it', async () => {
      user.mfaEnabledAt = enabledAt;
      const principal = await strategy.validate({
        ...payload('ASISTENTE'),
        issuedAtMs: enabledAt.getTime() + 1,
      });
      expect(principal.userId).toBe('member-1');
    });

    it('reads a token without issuedAtMs by its iat, rounded down', () => {
      // 10:00:00 counts as earlier than 10:00:00.500: an old token is never taken as newer.
      expect(
        issuedBeforeMfaEnabled({ iat: Math.floor(enabledAt.getTime() / 1000) }, enabledAt),
      ).toBe(true);
      expect(issuedBeforeMfaEnabled({ iat: enabledAt.getTime() / 1000 + 1 }, enabledAt)).toBe(
        false,
      );
      expect(issuedBeforeMfaEnabled({ issuedAtMs: 1 }, null)).toBe(false);
    });
  });
});
