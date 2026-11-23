import {
  REFRESH_COOKIE_NAME,
  buildClearedRefreshCookie,
  buildRefreshCookie,
  clearRefreshCookie,
  hasAmbiguousRefreshCookie,
  hashRefreshToken,
  isWebClient,
  parseCookieHeader,
  readAllRefreshCookies,
  readRefreshCookie,
  refreshCookiePath,
  setRefreshCookie,
} from './refresh-token';

describe('refresh token helpers', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('hashRefreshToken', () => {
    it('is the SHA-256 of the token in lowercase hex', () => {
      // Known vector: sha256("abc").
      expect(hashRefreshToken('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(hashRefreshToken('a.b.c')).toMatch(/^[0-9a-f]{64}$/);
      expect(hashRefreshToken('a.b.c')).not.toBe(hashRefreshToken('a.b.d'));
    });
  });

  describe('parseCookieHeader', () => {
    it('reads several cookies, trims them and decodes values', () => {
      expect(parseCookieHeader('a=1;  refresh_token=x%2By.z ; theme="dark"')).toEqual({
        a: '1',
        refresh_token: 'x+y.z',
        theme: 'dark',
      });
    });

    it('keeps the first occurrence of a name and skips malformed pairs', () => {
      expect(parseCookieHeader('a=1; a=2; broken; =nameless; b=%E0%A4%A')).toEqual({
        a: '1',
        b: '%E0%A4%A',
      });
    });

    it('answers nothing for a missing or empty header', () => {
      expect(parseCookieHeader(undefined)).toEqual({});
      expect(parseCookieHeader('')).toEqual({});
    });

    it('accepts the header repeated', () => {
      expect(parseCookieHeader(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
    });

    it('does not let a value reach the prototype', () => {
      const cookies = parseCookieHeader('__proto__=polluted; constructor=x');
      expect(Object.getPrototypeOf(cookies)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(cookies, 'constructor')).toBe(true);
      expect(cookies.constructor).toBe('x');
    });
  });

  describe('request readers', () => {
    it('detects the web client by the X-Client header, whatever its case', () => {
      expect(isWebClient({ headers: { 'x-client': 'web' } })).toBe(true);
      expect(isWebClient({ headers: { 'x-client': ' WEB ' } })).toBe(true);
      expect(isWebClient({ headers: { 'x-client': 'mobile' } })).toBe(false);
      expect(isWebClient({ headers: {} })).toBe(false);
    });

    it('reads the refresh token from the cookie only by its name', () => {
      expect(readRefreshCookie({ headers: { cookie: `x=1; ${REFRESH_COOKIE_NAME}=tok` } })).toBe(
        'tok',
      );
      expect(readRefreshCookie({ headers: { cookie: 'x_refresh_token=tok' } })).toBeUndefined();
      expect(readRefreshCookie({ headers: { cookie: `${REFRESH_COOKIE_NAME}=` } })).toBeUndefined();
      expect(readRefreshCookie({ headers: {} })).toBeUndefined();
    });
  });

  describe('cookie tossing', () => {
    it('trusts none of several refresh_token cookies instead of picking the first', () => {
      const req = { headers: { cookie: 'refresh_token=planted; a=1; refresh_token=real' } };
      expect(hasAmbiguousRefreshCookie(req)).toBe(true);
      expect(readRefreshCookie(req)).toBeUndefined();
    });

    it('reads every refresh_token value, several included, only to revoke them', () => {
      expect(
        readAllRefreshCookies({
          headers: {
            cookie:
              'refresh_token=planted; a=1; x_refresh_token=n; refresh_token=real; refresh_token=',
          },
        }),
      ).toEqual(['planted', 'real']);
      expect(readAllRefreshCookies({ headers: {} })).toEqual([]);
    });

    it('counts only the exact name', () => {
      expect(
        hasAmbiguousRefreshCookie({ headers: { cookie: 'refresh_token=a; x_refresh_token=b' } }),
      ).toBe(false);
      expect(readRefreshCookie({ headers: { cookie: 'refresh_token=a' } })).toBe('a');
    });
  });

  describe('cookie attributes', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const sevenDays = new Date(now + 7 * 24 * 3600 * 1000);

    it('is HttpOnly, SameSite=Lax, limited to the auth routes and lasts as long as the token', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.API_PREFIX;
      const cookie = buildRefreshCookie('a.b.c', sevenDays, now);
      expect(cookie.split('; ')).toEqual([
        'refresh_token=a.b.c',
        `Max-Age=${7 * 24 * 3600}`,
        'Path=/api/v1/auth',
        'HttpOnly',
        'SameSite=Lax',
        'Secure',
      ]);
    });

    it('follows API_PREFIX for the path, ignoring stray slashes', () => {
      process.env.API_PREFIX = '/v2/api/';
      expect(refreshCookiePath()).toBe('/v2/api/auth');
    });

    it('is not Secure in development and test, which run over http', () => {
      for (const env of ['development', 'test']) {
        process.env.NODE_ENV = env;
        expect(buildRefreshCookie('t', sevenDays, now)).not.toContain('Secure');
      }
      delete process.env.NODE_ENV;
      expect(buildRefreshCookie('t', sevenDays, now)).toContain('Secure');
    });

    it('never has a negative Max-Age', () => {
      expect(buildRefreshCookie('t', new Date(now - 5000), now)).toContain('Max-Age=0');
    });

    it('clears with the same attributes and Max-Age=0', () => {
      process.env.NODE_ENV = 'production';
      const set = buildRefreshCookie('t', sevenDays, now).split('; ').slice(2);
      const cleared = buildClearedRefreshCookie().split('; ');
      expect(cleared[0]).toBe('refresh_token=');
      expect(cleared[1]).toBe('Max-Age=0');
      expect(cleared.slice(2)).toEqual(set);
    });

    it('writes the Set-Cookie header', () => {
      const setHeader = jest.fn();
      setRefreshCookie({ setHeader }, 'tok', new Date(Date.now() + 60_000));
      expect(setHeader).toHaveBeenLastCalledWith(
        'Set-Cookie',
        expect.stringMatching(/^refresh_token=tok; Max-Age=(59|60); /),
      );
      clearRefreshCookie({ setHeader });
      expect(setHeader).toHaveBeenLastCalledWith(
        'Set-Cookie',
        expect.stringContaining('refresh_token=; Max-Age=0'),
      );
    });
  });
});
