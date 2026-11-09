import { UnauthorizedException } from '@nestjs/common';
import { AuthResponseDto } from './dto/auth.dto';
import { MfaService } from './mfa.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/** Real JWT signing and bcrypt; only the database and the mail provider are replaced. */
describe('AuthService own password change and session flag', () => {
  const config: Record<string, string> = {
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
  };
  let user: Record<string, any>;
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    withRlsContext: jest.fn(async (_context, callback) => callback()),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    new JwtService({}),
    { get: (name: string) => config[name] } as unknown as ConfigService,
    {} as MailService,
    { enrollmentRequired: () => false } as unknown as MfaService,
  );

  beforeEach(async () => {
    jest.clearAllMocks();
    user = {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Ríos',
      role: 'MASTER',
      isActive: true,
      mustChangePassword: true,
      lastActivityAt: null,
      updatedAt: new Date(),
      password: await bcrypt.hash('Temporary1!', 4),
      tenant: { isActive: true },
      professionalProfile: null,
    };
    prisma.user.findFirst.mockImplementation(async ({ where }) =>
      where.id === user.id ? { ...user } : null,
    );
    prisma.user.findMany.mockImplementation(async () => [{ ...user }]);
    prisma.user.update.mockImplementation(async ({ data }) => Object.assign(user, data));
  });

  it('stores the new hash and clears mustChangePassword', async () => {
    await service.changeOwnPassword('user-1', 'Temporary1!', ' NewPassword2! ');

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.user.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'user-1' });
    expect(data.mustChangePassword).toBe(false);
    // The new password is stored exactly as typed, spaces included.
    expect(await bcrypt.compare(' NewPassword2! ', data.password)).toBe(true);
  });

  it('rejects a wrong current password with 401', async () => {
    await expect(
      service.changeOwnPassword('user-1', 'WrongPassword9!', 'NewPassword2!'),
    ).rejects.toMatchObject({ status: 401 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a new password equal to the current one with PASSWORD_UNCHANGED', async () => {
    await expect(
      service.changeOwnPassword('user-1', 'Temporary1!', 'Temporary1!'),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ statusCode: 400, code: 'PASSWORD_UNCHANGED' }),
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns mustChangePassword in the login response', async () => {
    const response = (await service.login({
      email: 'ana@example.com',
      password: 'Temporary1!',
    })) as AuthResponseDto;

    expect(response.user.mustChangePassword).toBe(true);
  });

  it('returns mustChangePassword in the refresh response', async () => {
    const refreshToken = new JwtService({}).sign(
      { sub: 'user-1', tenantId: 'tenant-1', role: 'MASTER' },
      { secret: 'refresh-secret', expiresIn: '1h' },
    );
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { ...user },
    });

    const response = await service.refreshTokens(refreshToken);

    expect(response.user.mustChangePassword).toBe(true);
  });

  it('carries the session version of the account into the new tokens', async () => {
    user.sessionVersion = 3;
    const refreshToken = new JwtService({}).sign(
      { sub: 'user-1', tenantId: 'tenant-1', role: 'MASTER', sv: 3 },
      { secret: 'refresh-secret', expiresIn: '1h' },
    );
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { ...user },
    });

    const response = await service.refreshTokens(refreshToken);

    expect(new JwtService({}).decode(response.accessToken)).toMatchObject({ sv: 3 });
  });

  it('refuses a refresh token of an earlier session version, even one never revoked', async () => {
    // Issued by a refresh that read the account before its second factor was enabled.
    user.sessionVersion = 1;
    const refreshToken = new JwtService({}).sign(
      { sub: 'user-1', tenantId: 'tenant-1', role: 'MASTER', sv: 0 },
      { secret: 'refresh-secret', expiresIn: '1h' },
    );
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { ...user },
    });

    await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1' },
      data: { isRevoked: true },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });
});
