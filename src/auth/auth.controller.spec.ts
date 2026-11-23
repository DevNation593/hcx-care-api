import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService, IssuedSession } from './auth.service';
import { MfaService } from './mfa.service';

describe('AuthController refresh cookie', () => {
  const originalEnv = { ...process.env };
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const issued = (): IssuedSession => ({
    accessToken: 'access.jwt',
    refreshToken: 'refresh.jwt',
    refreshTokenExpiresAt: expiresAt,
    user: { id: 'u1' } as IssuedSession['user'],
  });

  const authService = {
    login: jest.fn(),
    verifyMfaLogin: jest.fn(),
    sessionAfterMfaEnrolment: jest.fn(),
    refreshTokens: jest.fn(),
    logout: jest.fn(),
    logoutAll: jest.fn(),
    resetPassword: jest.fn(),
  };
  const mfa = { enable: jest.fn() };
  const controller = new AuthController(
    authService as unknown as AuthService,
    mfa as unknown as MfaService,
  );

  const request = (headers: Record<string, string> = {}) => ({ headers }) as unknown as Request;
  const response = () => {
    const setHeader = jest.fn();
    return { res: { setHeader } as unknown as Response, setHeader };
  };
  const setCookieOf = (setHeader: jest.Mock): string | undefined =>
    setHeader.mock.calls.find(([name]) => name === 'Set-Cookie')?.[1];

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, NODE_ENV: 'production', API_PREFIX: 'api/v1' };
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  describe('login', () => {
    it('sets the cookie with the expected attributes', async () => {
      authService.login.mockResolvedValue(issued());
      const { res, setHeader } = response();

      await controller.login(
        { email: 'a@b.c', password: 'secret1' },
        request({ 'x-client': 'web' }),
        res,
      );

      const cookie = setCookieOf(setHeader)!;
      const [pair, ...attributes] = cookie.split('; ');
      expect(pair).toBe('refresh_token=refresh.jwt');
      expect(attributes).toEqual(
        expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/v1/auth']),
      );
      const maxAge = Number(attributes.find((a) => a.startsWith('Max-Age='))!.split('=')[1]);
      expect(maxAge).toBeGreaterThan(7 * 24 * 3600 - 5);
      expect(maxAge).toBeLessThanOrEqual(7 * 24 * 3600);
    });

    it('leaves the refresh token out of the body for the web client', async () => {
      authService.login.mockResolvedValue(issued());
      const { res } = response();

      const body = await controller.login(
        { email: 'a@b.c', password: 'secret1' },
        request({ 'x-client': 'web' }),
        res,
      );

      expect(body).toEqual({ accessToken: 'access.jwt', user: { id: 'u1' } });
      expect(body).not.toHaveProperty('refreshToken');
      expect(body).not.toHaveProperty('refreshTokenExpiresAt');
    });

    it('keeps the refresh token in the body and sets no cookie without the header (mobile)', async () => {
      authService.login.mockResolvedValue(issued());
      const { res, setHeader } = response();

      const body = await controller.login({ email: 'a@b.c', password: 'secret1' }, request(), res);

      // No Set-Cookie: a cross-site form could otherwise sign the victim in as the attacker.
      expect(setHeader).not.toHaveBeenCalled();
      expect(body).toEqual({
        accessToken: 'access.jwt',
        refreshToken: 'refresh.jwt',
        user: { id: 'u1' },
      });
    });

    it('sets no cookie for a second-factor challenge', async () => {
      authService.login.mockResolvedValue({ mfaRequired: true, mfaToken: 'm' });
      const { res, setHeader } = response();

      const body = await controller.login({ email: 'a@b.c', password: 'secret1' }, request(), res);

      expect(body).toEqual({ mfaRequired: true, mfaToken: 'm' });
      expect(setHeader).not.toHaveBeenCalled();
    });
  });

  describe('mfa', () => {
    it('sets the cookie and hides the token from the web client on verify', async () => {
      authService.verifyMfaLogin.mockResolvedValue(issued());
      const { res, setHeader } = response();

      const body = await controller.verifyMfa(
        { mfaToken: 'm', code: '123456' },
        request({ 'x-client': 'web' }),
        res,
      );

      expect(setCookieOf(setHeader)).toContain('refresh_token=refresh.jwt');
      expect(body).not.toHaveProperty('refreshToken');
    });

    it('sets no cookie and keeps the token in the body on verify without the header', async () => {
      authService.verifyMfaLogin.mockResolvedValue(issued());
      const { res, setHeader } = response();

      const body = await controller.verifyMfa({ mfaToken: 'm', code: '123456' }, request(), res);

      expect(setHeader).not.toHaveBeenCalled();
      expect(body).toMatchObject({ refreshToken: 'refresh.jwt' });
    });

    it('keeps the token in the body and sets no cookie on enable without the header (mobile)', async () => {
      mfa.enable.mockResolvedValue({ recoveryCodes: ['k1'] });
      authService.sessionAfterMfaEnrolment.mockResolvedValue(issued());
      const { res, setHeader } = response();

      const body = await controller.enableMfa(
        { userId: 'u1' } as never,
        { code: '123456' },
        request(),
        res,
      );

      expect(setHeader).not.toHaveBeenCalled();
      expect(body).toEqual({
        recoveryCodes: ['k1'],
        accessToken: 'access.jwt',
        refreshToken: 'refresh.jwt',
        user: { id: 'u1' },
      });
    });

    it('replaces the cookie when enabling it opens a new session', async () => {
      mfa.enable.mockResolvedValue({ recoveryCodes: ['k1'] });
      authService.sessionAfterMfaEnrolment.mockResolvedValue(issued());
      const { res, setHeader } = response();

      const body = await controller.enableMfa(
        { userId: 'u1' } as never,
        { code: '123456' },
        request({ 'x-client': 'web' }),
        res,
      );

      expect(setCookieOf(setHeader)).toContain('refresh_token=refresh.jwt');
      expect(body).toEqual({
        recoveryCodes: ['k1'],
        accessToken: 'access.jwt',
        user: { id: 'u1' },
      });
    });
  });

  describe('refresh', () => {
    it('refuses a cookie token without X-Client: web, before touching the token', async () => {
      const { res } = response();

      await expect(
        controller.refresh({}, request({ cookie: 'refresh_token=cookie.jwt' }), res),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(authService.refreshTokens).not.toHaveBeenCalled();
    });

    it('rotates a cookie token for the web client and replaces the cookie', async () => {
      authService.refreshTokens.mockResolvedValue({ ...issued(), refreshToken: 'next.jwt' });
      const { res, setHeader } = response();

      const body = await controller.refresh(
        {},
        request({ cookie: 'a=1; refresh_token=cookie.jwt', 'x-client': 'web' }),
        res,
      );

      expect(authService.refreshTokens).toHaveBeenCalledWith('cookie.jwt');
      expect(setCookieOf(setHeader)).toContain('refresh_token=next.jwt');
      expect(body).not.toHaveProperty('refreshToken');
    });

    it('accepts the token in the body without the header (mobile), answers it in the body and sets no cookie', async () => {
      authService.refreshTokens.mockResolvedValue({ ...issued(), refreshToken: 'next.jwt' });
      const { res, setHeader } = response();

      const body = await controller.refresh({ refreshToken: 'body.jwt' }, request(), res);

      expect(authService.refreshTokens).toHaveBeenCalledWith('body.jwt');
      expect(body).toMatchObject({ refreshToken: 'next.jwt' });
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('does not let a stale cookie break a mobile client that sends the body', async () => {
      authService.refreshTokens.mockResolvedValue(issued());
      const { res } = response();

      await controller.refresh(
        { refreshToken: 'body.jwt' },
        request({ cookie: 'refresh_token=stale.jwt' }),
        res,
      );

      expect(authService.refreshTokens).toHaveBeenCalledWith('body.jwt');
    });

    it('answers 401 when no token arrives by either way', async () => {
      const { res } = response();

      await expect(
        controller.refresh({}, request({ 'x-client': 'web' }), res),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authService.refreshTokens).not.toHaveBeenCalled();
    });

    it('refuses several refresh_token cookies without using any of them', async () => {
      const { res, setHeader } = response();

      await expect(
        controller.refresh(
          {},
          request({
            cookie: 'refresh_token=planted.jwt; refresh_token=real.jwt',
            'x-client': 'web',
          }),
          res,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(authService.refreshTokens).not.toHaveBeenCalled();
      // It cannot delete the planted cookie, so it sends no Set-Cookie at all.
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('keeps the cookie, and does not answer 401, when the failure is not the token (database down)', async () => {
      const failure = new Error('Prisma: connection pool timeout');
      authService.refreshTokens.mockRejectedValue(failure);
      const { res, setHeader } = response();

      const error = await controller
        .refresh({}, request({ cookie: 'refresh_token=good.jwt', 'x-client': 'web' }), res)
        .catch((e: unknown) => e);

      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(UnauthorizedException);
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('clears the cookie when the token read from it is rejected', async () => {
      authService.refreshTokens.mockRejectedValue(new UnauthorizedException());
      const { res, setHeader } = response();

      await expect(
        controller.refresh(
          {},
          request({ cookie: 'refresh_token=reused.jwt', 'x-client': 'web' }),
          res,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(setCookieOf(setHeader)).toContain('refresh_token=; Max-Age=0');
    });
  });

  describe('logout', () => {
    it('revokes the cookie token and clears the cookie', async () => {
      const { res, setHeader } = response();

      await controller.logout(
        { userId: 'u1' } as never,
        {},
        request({ cookie: 'refresh_token=cookie.jwt' }),
        res,
      );

      expect(authService.logout).toHaveBeenCalledWith('u1', ['cookie.jwt']);
      const cookie = setCookieOf(setHeader)!;
      expect(cookie).toContain('refresh_token=; Max-Age=0');
      expect(cookie).toContain('Path=/api/v1/auth');
      expect(cookie).toContain('HttpOnly');
    });

    it('revokes every refresh_token cookie when there are several, and clears the cookie', async () => {
      const { res, setHeader } = response();

      await controller.logout(
        { userId: 'u1' } as never,
        {},
        request({ cookie: 'refresh_token=planted.jwt; a=1; refresh_token=real.jwt' }),
        res,
      );

      expect(authService.logout).toHaveBeenCalledWith('u1', ['planted.jwt', 'real.jwt']);
      expect(setCookieOf(setHeader)).toContain('refresh_token=; Max-Age=0');
    });

    it('revokes the token of the body (mobile)', async () => {
      const { res } = response();

      await controller.logout(
        { userId: 'u1' } as never,
        { refreshToken: 'body.jwt' },
        request(),
        res,
      );

      expect(authService.logout).toHaveBeenCalledWith('u1', ['body.jwt']);
    });

    it('clears the cookie on logout-all and after a password reset', async () => {
      const all = response();
      await controller.logoutAll({ userId: 'u1' } as never, all.res);
      expect(setCookieOf(all.setHeader)).toContain('refresh_token=; Max-Age=0');

      const reset = response();
      await controller.resetPassword({ token: 't', password: 'NewPassword1!' }, reset.res);
      expect(setCookieOf(reset.setHeader)).toContain('refresh_token=; Max-Age=0');
    });
  });
});
