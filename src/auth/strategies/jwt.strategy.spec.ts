import { MfaService } from '../mfa.service';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UsersController } from '../../users/users.controller';
import { sessionEnded } from '../session-version';
import { JwtStrategy } from './jwt.strategy';

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

  describe('sessions of an earlier session version', () => {
    it('ends a token issued under an earlier version, however late it was signed', async () => {
      // A sign-in that read the account before its second factor was enabled.
      user.sessionVersion = 1;
      await expect(strategy.validate({ ...payload('ASISTENTE'), sv: 0 })).rejects.toMatchObject({
        response: { code: 'SESSION_ENDED' },
      });
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('ends a token older than the version claim once the account has a newer version', async () => {
      user.sessionVersion = 2;
      await expect(strategy.validate(payload('ASISTENTE'))).rejects.toMatchObject({
        response: { code: 'SESSION_ENDED' },
      });
    });

    it('keeps the token of the current version, and the old tokens of an untouched account', async () => {
      user.sessionVersion = 1;
      expect((await strategy.validate({ ...payload('ASISTENTE'), sv: 1 })).userId).toBe('member-1');
      expect(sessionEnded({}, { sessionVersion: 0 })).toBe(false);
      expect(sessionEnded({}, {})).toBe(false);
    });
  });
});
