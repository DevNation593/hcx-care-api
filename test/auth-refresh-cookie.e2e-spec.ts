import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { hashRefreshToken } from './../src/auth/refresh-token';
import { totpCode, totpStep } from './../src/auth/totp';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

const EMAIL = 'admin+1@tenant.test';
const AUTH = '/api/v1/auth';

/** The refresh token of the web client travels in an HttpOnly cookie and rests hashed in the table. */
describe('Refresh token cookie (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const setCookies = (res: request.Response) =>
    res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookieOf = (res: request.Response): string | undefined =>
    setCookies(res)?.find((c) => c.startsWith('refresh_token='));
  const valueOf = (cookie: string | undefined) => cookie!.split(';')[0].split('=')[1];
  const loginWeb = () =>
    http()
      .post(`${AUTH}/login`)
      .set('X-Client', 'web')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.cleanDatabase();
    await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the cookie with the expected attributes and keeps the token out of the web body', async () => {
    const res = await loginWeb();

    const cookie = cookieOf(res);
    expect(cookie).toBeDefined();
    const attributes = cookie!.split('; ').slice(1);
    expect(attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth']),
    );
    // NODE_ENV is "test": plain http, so no Secure (production adds it, see refresh-token.spec).
    expect(attributes).not.toContain('Secure');
    const maxAge = Number(attributes.find((a) => a.startsWith('Max-Age='))!.split('=')[1]);
    expect(maxAge).toBeGreaterThan(7 * 24 * 3600 - 30);
    expect(maxAge).toBeLessThanOrEqual(7 * 24 * 3600);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: EMAIL });
    expect(res.body).not.toHaveProperty('refreshToken');
    expect(res.body).not.toHaveProperty('refreshTokenExpiresAt');
  });

  it('stores the hash of the token, with the JWT expiry', async () => {
    const res = await loginWeb();
    const token = valueOf(cookieOf(res));

    const rows = await prisma.refreshToken.findMany({ where: { token } });
    expect(rows).toHaveLength(0);
    const stored = await prisma.refreshToken.findUniqueOrThrow({
      where: { token: hashRefreshToken(token) },
    });
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.isRevoked).toBe(false);
    const secondsLeft = (stored.expiresAt.getTime() - Date.now()) / 1000;
    expect(secondsLeft).toBeGreaterThan(7 * 24 * 3600 - 30);
  });

  it('keeps the refresh token in the body and sets no cookie without X-Client (mobile)', async () => {
    const res = await http()
      .post(`${AUTH}/login`)
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);

    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('refreshTokenExpiresAt');
    expect(setCookies(res)).toBeUndefined();
  });

  it('sets no cookie for a cross-site form post (login CSRF): urlencoded, no X-Client', async () => {
    // What a page of another site can submit: top-level, urlencoded, no custom header, no preflight.
    const res = await http()
      .post(`${AUTH}/login`)
      .type('form')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);

    expect(setCookies(res)).toBeUndefined();
  });

  it('does not swap the cookie of the browser on a refresh without X-Client', async () => {
    const attacker = await http()
      .post(`${AUTH}/login`)
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);

    const res = await http()
      .post(`${AUTH}/refresh`)
      .type('form')
      .send({ refreshToken: attacker.body.refreshToken })
      .expect(200);

    expect(setCookies(res)).toBeUndefined();
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it('refuses a refresh by cookie without X-Client: web, and keeps the session usable', async () => {
    const session = await loginWeb();
    const cookie = valueOf(cookieOf(session));

    await http().post(`${AUTH}/refresh`).set('Cookie', `refresh_token=${cookie}`).expect(403);
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'mobile')
      .expect(403);

    // The rejected attempts neither consumed nor revoked the token.
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  it('answers 401 when no token arrives at all', async () => {
    await http().post(`${AUTH}/refresh`).set('X-Client', 'web').expect(401);
  });

  it('rotates the cookie on refresh and detects the reuse of the old token', async () => {
    const session = await loginWeb();
    const first = valueOf(cookieOf(session));

    const rotated = await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${first}`)
      .set('X-Client', 'web')
      .expect(200);
    const second = valueOf(cookieOf(rotated));
    expect(second).not.toBe(first);
    expect(rotated.body.accessToken).toEqual(expect.any(String));
    expect(rotated.body).not.toHaveProperty('refreshToken');

    // The old token is presented again: refused, the cookie is cleared, and the whole family
    // (including the token just issued) is revoked.
    const reused = await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${first}`)
      .set('X-Client', 'web')
      .expect(401);
    expect(cookieOf(reused)).toContain('refresh_token=; Max-Age=0');
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${second}`)
      .set('X-Client', 'web')
      .expect(401);
  });

  it('refreshes by body without the header (mobile contract)', async () => {
    const login = await http()
      .post(`${AUTH}/login`)
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);

    const res = await http()
      .post(`${AUTH}/refresh`)
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);

    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).not.toBe(login.body.refreshToken);
    expect(setCookies(res)).toBeUndefined();
    // The old one is spent: reuse is detected for the body too.
    await http()
      .post(`${AUTH}/refresh`)
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  it('logs out by cookie: revokes the token and clears the cookie', async () => {
    const session = await loginWeb();
    const cookie = valueOf(cookieOf(session));

    const res = await http()
      .post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'web')
      .send({})
      .expect(200);

    const cleared = cookieOf(res)!;
    expect(cleared).toContain('refresh_token=; Max-Age=0');
    expect(cleared).toContain('Path=/api/v1/auth');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('SameSite=Lax');

    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'web')
      .expect(401);
  });

  it('logs out by body (mobile) and leaves the other sessions alone', async () => {
    const mobile = await http()
      .post(`${AUTH}/login`)
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);
    const web = await loginWeb();

    await http()
      .post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${mobile.body.accessToken}`)
      .send({ refreshToken: mobile.body.refreshToken })
      .expect(200);

    await http()
      .post(`${AUTH}/refresh`)
      .send({ refreshToken: mobile.body.refreshToken })
      .expect(401);
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${valueOf(cookieOf(web))}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  it('a logout without a token revokes nothing', async () => {
    const web = await loginWeb();
    const bystander = await loginWeb();

    await http()
      .post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${web.body.accessToken}`)
      .send({})
      .expect(200);

    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${valueOf(cookieOf(bystander))}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  it('revokes every refresh_token cookie on logout when there are several, and no other session', async () => {
    const a = await loginWeb();
    const b = await loginWeb();
    const bystander = await loginWeb();

    const res = await http()
      .post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .set('Cookie', `refresh_token=${valueOf(cookieOf(a))}; refresh_token=${valueOf(cookieOf(b))}`)
      .set('X-Client', 'web')
      .send({})
      .expect(200);
    expect(cookieOf(res)).toContain('refresh_token=; Max-Age=0');

    for (const revoked of [a, b]) {
      await http()
        .post(`${AUTH}/refresh`)
        .set('Cookie', `refresh_token=${valueOf(cookieOf(revoked))}`)
        .set('X-Client', 'web')
        .expect(401);
    }
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${valueOf(cookieOf(bystander))}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  it('clears the cookie on logout-all and ends every session', async () => {
    const one = await loginWeb();
    const two = await loginWeb();

    const res = await http()
      .post(`${AUTH}/logout-all`)
      .set('Authorization', `Bearer ${one.body.accessToken}`)
      .set('X-Client', 'web')
      .expect(200);

    expect(cookieOf(res)).toContain('refresh_token=; Max-Age=0');
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${valueOf(cookieOf(two))}`)
      .set('X-Client', 'web')
      .expect(401);
  });

  it('refuses several refresh_token cookies without using any of them', async () => {
    const session = await loginWeb();
    const real = valueOf(cookieOf(session));

    const res = await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=planted; refresh_token=${real}`)
      .set('X-Client', 'web')
      .expect(401);
    // It cannot delete the planted cookie, so it sends no Set-Cookie at all.
    expect(res.headers['set-cookie']).toBeUndefined();

    // The real token was neither used nor revoked.
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${real}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  it('does not answer 401 nor clear the cookie when the database fails during a refresh', async () => {
    const session = await loginWeb();
    const cookie = valueOf(cookieOf(session));
    const failure = jest
      .spyOn(prisma.refreshToken, 'findUnique')
      .mockRejectedValueOnce(new Error('connection pool timeout'));

    const res = await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'web');

    expect(failure).toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(setCookies(res)).toBeUndefined();

    // The session is intact: the same cookie refreshes once the database is back.
    failure.mockRestore();
    await http()
      .post(`${AUTH}/refresh`)
      .set('Cookie', `refresh_token=${cookie}`)
      .set('X-Client', 'web')
      .expect(200);
  });

  describe('two-factor sign-in', () => {
    const MFA_EMAIL = 'admin+2@tenant.test';
    let secret: string;
    let recoveryCodes: string[];
    let accessToken: string;

    beforeAll(async () => {
      await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 2);
      const login = await http()
        .post(`${AUTH}/login`)
        .send({ email: MFA_EMAIL, password: TEST_PASSWORD })
        .expect(200);
      accessToken = login.body.accessToken;
    });

    it('mfa/enable gives a web client the new session in the cookie only', async () => {
      const setup = await http()
        .post(`${AUTH}/mfa/setup`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: TEST_PASSWORD })
        .expect(200);
      secret = setup.body.secret;

      const res = await http()
        .post(`${AUTH}/mfa/enable`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Client', 'web')
        .send({ code: totpCode(secret, totpStep(new Date())) })
        .expect(200);

      recoveryCodes = res.body.recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body).not.toHaveProperty('refreshToken');
      const cookie = cookieOf(res)!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/api/v1/auth');
      // That cookie is a live session.
      await http()
        .post(`${AUTH}/refresh`)
        .set('Cookie', `refresh_token=${valueOf(cookie)}`)
        .set('X-Client', 'web')
        .expect(200);
    });

    it('mfa/verify sets the cookie and hides the token for the web client', async () => {
      const challenge = await http()
        .post(`${AUTH}/login`)
        .set('X-Client', 'web')
        .send({ email: MFA_EMAIL, password: TEST_PASSWORD })
        .expect(200);
      expect(challenge.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
      expect(setCookies(challenge)).toBeUndefined();

      const res = await http()
        .post(`${AUTH}/mfa/verify`)
        .set('X-Client', 'web')
        .send({ mfaToken: challenge.body.mfaToken, recoveryCode: recoveryCodes[0] })
        .expect(200);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(cookieOf(res)).toMatch(
        /^refresh_token=[^;]+; Max-Age=\d+; Path=\/api\/v1\/auth; HttpOnly; SameSite=Lax$/,
      );
    });

    it('mfa/verify without X-Client sets no cookie and keeps the token in the body', async () => {
      const challenge = await http()
        .post(`${AUTH}/login`)
        .send({ email: MFA_EMAIL, password: TEST_PASSWORD })
        .expect(200);

      const res = await http()
        .post(`${AUTH}/mfa/verify`)
        .send({ mfaToken: challenge.body.mfaToken, recoveryCode: recoveryCodes[1] })
        .expect(200);

      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(setCookies(res)).toBeUndefined();
    });

    it('mfa/enable without X-Client keeps the token in the body and sets no cookie (mobile)', async () => {
      // Back to a session of this account, then turn the second factor off to enrol it again.
      const challenge = await http()
        .post(`${AUTH}/login`)
        .send({ email: MFA_EMAIL, password: TEST_PASSWORD })
        .expect(200);
      const session = await http()
        .post(`${AUTH}/mfa/verify`)
        .send({ mfaToken: challenge.body.mfaToken, recoveryCode: recoveryCodes[2] })
        .expect(200);
      // A later step than the one the enrolment used, so the code is accepted once more.
      await http()
        .post(`${AUTH}/mfa/disable`)
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({ password: TEST_PASSWORD, code: totpCode(secret, totpStep(new Date()) + 1) })
        .expect(200);
      const login = await http()
        .post(`${AUTH}/login`)
        .send({ email: MFA_EMAIL, password: TEST_PASSWORD })
        .expect(200);
      const bearer = `Bearer ${login.body.accessToken}`;
      const setup = await http()
        .post(`${AUTH}/mfa/setup`)
        .set('Authorization', bearer)
        .send({ password: TEST_PASSWORD })
        .expect(200);

      const res = await http()
        .post(`${AUTH}/mfa/enable`)
        .set('Authorization', bearer)
        .send({ code: totpCode(setup.body.secret, totpStep(new Date())) })
        .expect(200);

      expect(res.body.recoveryCodes).toHaveLength(10);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(setCookies(res)).toBeUndefined();
      // The token of the body is a live session.
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refreshToken: res.body.refreshToken })
        .expect(200);
    });
  });

  it('rejects an unknown body property and a non-string refresh token', async () => {
    await http().post(`${AUTH}/refresh`).send({ refreshToken: 12345 }).expect(400);
    await http().post(`${AUTH}/refresh`).send({ other: 'x' }).expect(400);
  });
});
