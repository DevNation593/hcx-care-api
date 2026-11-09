import { MfaService } from './mfa.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/** Real JWT signing and bcrypt; only the database and the mail provider are replaced. */
describe('AuthService password reset', () => {
  const config: Record<string, string> = {
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_RESET_EXPIRATION: '1h',
  };
  let user: Record<string, any>;
  let refreshTokens: { userId: string; isRevoked: boolean }[];
  const mail = { sendPasswordReset: jest.fn().mockResolvedValue(true) };

  const matches = (where: Record<string, any>) =>
    (where.email === undefined || where.email === user.email) &&
    (where.id === undefined || where.id === user.id) &&
    (where.tenantId === undefined || where.tenantId === user.tenantId) &&
    (where.isActive === undefined || where.isActive === user.isActive);
  const tx = {
    user: { update: jest.fn(async ({ data }) => Object.assign(user, data)) },
    refreshToken: {
      updateMany: jest.fn(async () => {
        refreshTokens.forEach((token) => (token.isRevoked = true));
        return { count: refreshTokens.length };
      }),
    },
  };
  const prisma = {
    user: { findFirst: jest.fn(async ({ where }) => (matches(where) ? { ...user } : null)) },
    withRlsContext: jest.fn(async (_context, callback) => callback()),
    applyRlsContext: jest.fn(),
    $transaction: jest.fn(async (callback) => callback(tx)),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    new JwtService({}),
    { get: (name: string) => config[name] } as unknown as ConfigService,
    mail as unknown as MailService,
    { enrollmentRequired: () => false } as unknown as MfaService,
  );
  const sentToken = () => mail.sendPasswordReset.mock.calls[0][1].token as string;

  beforeEach(async () => {
    jest.clearAllMocks();
    user = {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      firstName: 'Ana',
      isActive: true,
      password: await bcrypt.hash('OldPassword1!', 4),
    };
    refreshTokens = [{ userId: 'user-1', isRevoked: false }];
  });

  afterEach(() => jest.useRealTimers());

  it('sends the link to the account address and keeps the token out of the logs', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args) => logged.push(args));
    }

    await service.requestPasswordReset('ana@example.com');

    expect(mail.sendPasswordReset).toHaveBeenCalledWith('ana@example.com', {
      firstName: 'Ana',
      token: expect.any(String),
      expiresIn: '1h',
    });
    expect(JSON.stringify(logged)).not.toContain(sentToken());
  });

  it.each([
    ['an unknown address', () => undefined, 'nobody@example.com'],
    ['an inactive account', () => (user.isActive = false), 'ana@example.com'],
  ])('sends nothing and still succeeds for %s', async (_label, arrange, email) => {
    arrange();

    await expect(service.requestPasswordReset(email)).resolves.toBeUndefined();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('does not fail the request when the mail provider is down', async () => {
    mail.sendPasswordReset.mockResolvedValueOnce(false);

    await expect(service.requestPasswordReset('ana@example.com')).resolves.toBeUndefined();
  });

  it('changes the password with the mailed token and closes open sessions', async () => {
    await service.requestPasswordReset('ana@example.com');

    await service.resetPassword(sentToken(), 'NewPassword2!');

    expect(await bcrypt.compare('NewPassword2!', user.password)).toBe(true);
    expect(refreshTokens).toEqual([{ userId: 'user-1', isRevoked: true }]);
  });

  it('clears mustChangePassword after a reset by e-mail', async () => {
    user.mustChangePassword = true;
    await service.requestPasswordReset('ana@example.com');

    await service.resetPassword(sentToken(), 'NewPassword2!');

    expect(user.mustChangePassword).toBe(false);
  });

  it('accepts the token only once', async () => {
    await service.requestPasswordReset('ana@example.com');
    const token = sentToken();
    await service.resetPassword(token, 'NewPassword2!');

    await expect(service.resetPassword(token, 'Another3!')).rejects.toMatchObject({ status: 400 });
    expect(await bcrypt.compare('NewPassword2!', user.password)).toBe(true);
  });

  it('rejects the token after it expires', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    await service.requestPasswordReset('ana@example.com');
    const token = sentToken();

    jest.setSystemTime(new Date('2026-10-16T12:59:00Z'));
    const oldHash = user.password;
    jest.setSystemTime(new Date('2026-10-16T13:00:01Z'));

    await expect(service.resetPassword(token, 'NewPassword2!')).rejects.toMatchObject({
      status: 400,
    });
    expect(user.password).toBe(oldHash);
  });

  it.each(['not-a-token', ''])('rejects the malformed token "%s"', async (token) => {
    await expect(service.resetPassword(token, 'NewPassword2!')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects a token issued for another purpose', async () => {
    const accessLike = new JwtService({}).sign(
      { sub: 'user-1', tenantId: 'tenant-1', type: 'access' },
      { secret: `access-secret:${user.password}`, expiresIn: '1h' },
    );

    await expect(service.resetPassword(accessLike, 'NewPassword2!')).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
