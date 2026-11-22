import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { hashRefreshToken } from './refresh-token';

/** Real JWT signing and bcrypt; only the database and the mail provider are replaced. */
describe('AuthService refresh tokens at rest', () => {
  const config: Record<string, string> = {
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
  };
  const jwt = new JwtService({});
  let user: Record<string, any>;
  const prisma = {
    user: { findMany: jest.fn(), update: jest.fn() },
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
    jwt,
    { get: (name: string) => config[name] } as unknown as ConfigService,
    {} as MailService,
    { enrollmentRequired: () => false } as unknown as MfaService,
  );
  const signRefresh = () =>
    jwt.sign(
      { sub: 'user-1', tenantId: 'tenant-1', role: 'MASTER', jti: Math.random().toString() },
      { secret: 'refresh-secret', expiresIn: '1h' },
    );

  beforeEach(async () => {
    jest.resetAllMocks();
    delete config.JWT_REFRESH_EXPIRATION;
    prisma.withRlsContext.mockImplementation(async (_context, callback) => callback());
    user = {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Ríos',
      role: 'MASTER',
      isActive: true,
      mustChangePassword: false,
      lastActivityAt: null,
      updatedAt: new Date(),
      password: await bcrypt.hash('Password1!', 4),
      tenant: { isActive: true },
      professionalProfile: null,
    };
    prisma.user.findMany.mockResolvedValue([user]);
    prisma.user.update.mockResolvedValue(user);
  });

  it('stores the SHA-256 of the token, never the token', async () => {
    const session = await service.login({ email: 'ana@example.com', password: 'Password1!' });

    const stored = prisma.refreshToken.create.mock.calls[0][0].data;
    const issued = (session as { refreshToken: string }).refreshToken;
    expect(stored.token).toBe(hashRefreshToken(issued));
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token).not.toBe(issued);
    expect(JSON.stringify(prisma.refreshToken.create.mock.calls)).not.toContain(issued);
  });

  it('expires the row, and reports it, when the JWT does (not a fixed 7 days)', async () => {
    config.JWT_REFRESH_EXPIRATION = '2h';
    const before = Date.now();

    const session = (await service.login({
      email: 'ana@example.com',
      password: 'Password1!',
    })) as { refreshToken: string; refreshTokenExpiresAt: Date };

    const { exp } = jwt.decode(session.refreshToken) as { exp: number };
    const stored = prisma.refreshToken.create.mock.calls[0][0].data;
    expect(stored.expiresAt.getTime()).toBe(exp * 1000);
    expect(session.refreshTokenExpiresAt).toEqual(stored.expiresAt);
    expect(stored.expiresAt.getTime() - before).toBeGreaterThan(2 * 3600_000 - 5000);
    expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(2 * 3600_000 + 5000);
  });

  it('looks the presented token up by its hash and rotates it', async () => {
    const presented = signRefresh();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { ...user },
    });

    const next = await service.refreshTokens(presented);

    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token: hashRefreshToken(presented) } }),
    );
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { isRevoked: true },
    });
    expect(prisma.refreshToken.create.mock.calls[0][0].data).toMatchObject({
      familyId: 'family-1',
      token: hashRefreshToken(next.refreshToken),
    });
  });

  it('detects a reused token and revokes its whole family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: true,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { ...user },
    });

    await expect(service.refreshTokens(signRefresh())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1' },
      data: { isRevoked: true },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refuses a token that is not stored (for instance one that was never hashed)', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(service.refreshTokens(signRefresh())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('surfaces a database failure as itself, not as an invalid token', async () => {
    const failure = new Error('Prisma: connection pool timeout');
    prisma.refreshToken.findUnique.mockRejectedValue(failure);

    const error = await service.refreshTokens(signRefresh()).catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['garbage', () => 'not-a-jwt'],
    [
      'expired',
      () =>
        jwt.sign(
          { sub: 'user-1', tenantId: 'tenant-1', role: 'MASTER' },
          { secret: 'refresh-secret', expiresIn: -10 },
        ),
    ],
    [
      'signed with another secret',
      () => jwt.sign({ sub: 'user-1' }, { secret: 'other-secret', expiresIn: '1h' }),
    ],
  ])('answers 401 for a token that is %s', async (_name, token) => {
    await expect(service.refreshTokens(token())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the specific reason of a rejected stored token (expired row)', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      familyId: 'family-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000),
      user: { ...user },
    });

    await expect(service.refreshTokens(signRefresh())).rejects.toMatchObject({
      message: 'El token de actualización ha expirado',
    });
  });

  it('revokes on logout by the hash of the token', async () => {
    await service.logout('user-1', 'some.refresh.jwt');

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { in: [hashRefreshToken('some.refresh.jwt')] } },
      data: { isRevoked: true },
    });
  });

  it('revokes every token it is given, always bound to the user', async () => {
    await service.logout('user-1', ['planted.jwt', 'real.jwt']);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        token: { in: [hashRefreshToken('planted.jwt'), hashRefreshToken('real.jwt')] },
      },
      data: { isRevoked: true },
    });
  });

  it('revokes nothing on logout with an empty list', async () => {
    await service.logout('user-1', []);

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('revokes nothing on logout without a token instead of matching every session', async () => {
    await service.logout('user-1', undefined);

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
