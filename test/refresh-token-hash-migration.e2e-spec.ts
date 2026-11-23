import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { hashRefreshToken } from './../src/auth/refresh-token';
import { main } from './../prisma/verify-refresh-token-hash-migration';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

const EMAIL = 'admin+1@tenant.test';
const AUTH = '/api/v1/auth';

/**
 * Rows in clear text, as an old API instance writes them after the migration, are detected and
 * converted by the script, and the sessions behind them work again with the new API.
 */
describe('Refresh token hash check script (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  const http = () => request(app.getHttpServer());
  const login = async () =>
    (await http().post(`${AUTH}/login`).send({ email: EMAIL, password: TEST_PASSWORD }).expect(200))
      .body.refreshToken as string;
  const output = () => [...log.mock.calls, ...error.mock.calls].flat().join('\n');
  const run = async (...args: string[]) => {
    log.mockClear();
    error.mockClear();
    return main(args, prisma);
  };

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

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('detects clear-text rows, reconciles them and leaves the sessions working', async () => {
    // Two sessions issued by the new API (rows already hold the hash) ...
    const hashedA = await login();
    const hashedB = await login();
    // ... and sessions that an old instance would have written in clear text after the migration:
    // two usable, one revoked and one expired.
    const legacyA = await login();
    const legacyB = await login();
    const legacyRevoked = await login();
    const legacyExpired = await login();
    const asClearText = (token: string, data: { isRevoked?: boolean; expiresAt?: Date } = {}) =>
      prisma.refreshToken.updateMany({
        where: { token: hashRefreshToken(token) },
        data: { token, ...data },
      });
    await asClearText(legacyA);
    await asClearText(legacyB);
    await asClearText(legacyRevoked, { isRevoked: true });
    await asClearText(legacyExpired, { expiresAt: new Date(Date.now() - 3600 * 1000) });
    // Values that are close to a hash but are not one for the migration's criterion (usable rows).
    const userId = (await prisma.refreshToken.findFirstOrThrow()).userId;
    const sample = hashRefreshToken('near-miss');
    const nearMisses = [
      sample.toUpperCase(),
      `${sample}
`,
      sample.slice(1),
    ];
    for (const [index, token] of nearMisses.entries()) {
      await prisma.refreshToken.create({
        data: {
          userId,
          token,
          familyId: `near-miss-${index}`,
          expiresAt: new Date(Date.now() + 3600 * 1000),
        },
      });
    }
    const total = await prisma.refreshToken.count();
    const unconverted = 4 + nearMisses.length;
    // Usable and unconverted: legacyA, legacyB and the near misses (not the revoked or expired ones).
    const unconvertedActive = 2 + nearMisses.length;
    const secrets = [
      legacyA,
      legacyB,
      legacyRevoked,
      legacyExpired,
      hashedA,
      hashedB,
      hashRefreshToken(legacyA),
      sample,
      sample.toUpperCase(),
    ];

    // The new API cannot look the clear-text token up: this is the 401 the script prevents.
    await http().post(`${AUTH}/refresh`).send({ refreshToken: legacyA }).expect(401);

    // Verification: read-only, exit 1, exact counts, no secret in the output.
    const before = await prisma.refreshToken.findMany({ orderBy: { id: 'asc' } });
    expect(await run()).toBe(1);
    const verifyOutput = output();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      mode: 'verify',
      target: { host: new URL(process.env.DATABASE_URL!).hostname, source: 'env' },
      total,
      unconverted,
      unconvertedActive,
      converted: total - unconverted,
    });
    for (const secret of secrets) expect(verifyOutput).not.toContain(secret);
    expect(await prisma.refreshToken.findMany({ orderBy: { id: 'asc' } })).toEqual(before);

    // Reconciliation: converts exactly the unconverted rows, exit 0.
    expect(await run('--reconcile')).toBe(0);
    const reconcileOutput = output();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      mode: 'reconcile',
      reconciled: unconverted,
      before: { total, unconverted, unconvertedActive },
      after: { total, converted: total, unconverted: 0, unconvertedActive: 0 },
    });
    for (const secret of secrets) expect(reconcileOutput).not.toContain(secret);
    const rows = await prisma.refreshToken.findMany();
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.token))).toBe(true);
    // The hash written by SQL equals the one the API computes, and rows already hashed were not touched.
    expect(rows.map((row) => row.token)).toEqual(
      expect.arrayContaining([hashRefreshToken(legacyA), hashRefreshToken(legacyB)]),
    );
    for (const row of before.filter((r) => /^[0-9a-f]{64}$/.test(r.token))) {
      expect(rows.find((r) => r.id === row.id)).toEqual(row);
    }
    // Revocation and expiry survive the rewrite.
    const revoked = rows.find((r) => r.token === hashRefreshToken(legacyRevoked));
    expect(revoked?.isRevoked).toBe(true);
    const expired = rows.find((r) => r.token === hashRefreshToken(legacyExpired));
    expect(expired!.expiresAt.getTime()).toBeLessThan(Date.now());

    // Verification afterwards: exit 0; a second reconciliation changes nothing.
    expect(await run()).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ unconverted: 0, total });
    expect(await run('--reconcile')).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ reconciled: 0 });

    // The converted sessions refresh with the new API using the original clear-text token ...
    const refreshed = await http()
      .post(`${AUTH}/refresh`)
      .send({ refreshToken: legacyA })
      .expect(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    await http().post(`${AUTH}/refresh`).send({ refreshToken: legacyB }).expect(200);
    await http().post(`${AUTH}/refresh`).send({ refreshToken: hashedA }).expect(200);
    // ... and the revoked or expired ones stay refused.
    await http().post(`${AUTH}/refresh`).send({ refreshToken: legacyRevoked }).expect(401);
    await http().post(`${AUTH}/refresh`).send({ refreshToken: legacyExpired }).expect(401);
  });
});
