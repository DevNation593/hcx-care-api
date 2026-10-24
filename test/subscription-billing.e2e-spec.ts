import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/auth.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { SubscriptionLifecycleService } from './../src/subscription/subscription-lifecycle.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

describe('Subscription billing (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let lifecycle: SubscriptionLifecycleService;
  let tenantId: string;
  let masterToken: string;
  let adminToken: string;
  let paymentId: string;

  const login = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const subscription = () => prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
  const days = (count: number) => new Date(Date.now() + count * 24 * 60 * 60 * 1000);

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
    prisma = app.get<PrismaService>(PrismaService);
    lifecycle = app.get<SubscriptionLifecycleService>(SubscriptionLifecycleService);

    await prisma.cleanDatabase();
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    const platformTenantId = (
      await prisma.tenant.create({
        data: { name: 'Platform', email: 'platform@tenant.test', isPlatform: true },
      })
    ).id;
    await prisma.user.create({
      data: {
        tenantId: platformTenantId,
        email: 'platform-admin@tenant.test',
        password: await app.get<AuthService>(AuthService).hashPassword(TEST_PASSWORD),
        firstName: 'Platform',
        lastName: 'Admin',
        role: 'ADMIN',
        isActive: true,
      },
    });

    masterToken = await login('admin+1@tenant.test');
    adminToken = await login('platform-admin@tenant.test');
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts on a trial of Clínica Básico', async () => {
    expect(await subscription()).toMatchObject({
      planId: 'plan_clinic_basic',
      status: 'TRIALING',
      seatsPsychologistsMax: 3,
    });
  });

  it.each(['upgrade', 'downgrade', 'plans'])(
    'no longer lets the clinic change or browse plans itself (%s)',
    async (route) => {
      const call = request(app.getHttpServer());
      await (
        route === 'plans'
          ? call.get(`/api/v1/tenants/${tenantId}/subscription/plans`)
          : call.post(`/api/v1/tenants/${tenantId}/subscription/${route}`).send({})
      )
        .set(bearer(masterToken))
        .expect(404);
    },
  );

  it('charges the first month of the plan when the trial is about to end', async () => {
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { trialEndsAt: days(3) },
    });
    await lifecycle.run();
    await lifecycle.run();

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/tenants/${tenantId}/subscription/payments`)
      .set(bearer(masterToken))
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      kind: 'RENEWAL',
      status: 'PENDING',
      planId: 'plan_clinic_basic',
      planName: 'Clínica Básico',
    });
    expect(Number(listed.body[0].amount)).toBe(99);
    paymentId = listed.body[0].id;
    expect((await subscription()).status).toBe('TRIALING');
  });

  it('does not let the tenant confirm its own payment', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/platform/subscription-payments/${paymentId}/confirm`)
      .set(bearer(masterToken))
      .send({ reference: 'SELF-1' })
      .expect(403);
    expect((await subscription()).status).toBe('TRIALING');
  });

  it('activates the plan when the platform admin confirms, and only once', async () => {
    const confirm = () =>
      request(app.getHttpServer())
        .post(`/api/v1/platform/subscription-payments/${paymentId}/confirm`)
        .set(bearer(adminToken))
        .send({ reference: 'TRF-0001' })
        .expect(200);

    const first = await confirm();
    expect(first.body.alreadyConfirmed).toBe(false);
    const active = await subscription();
    expect(active).toMatchObject({ planId: 'plan_clinic_basic', status: 'ACTIVE' });
    expect(active.currentPeriodEnd!.getTime()).toBeGreaterThan(days(30).getTime());

    const second = await confirm();
    expect(second.body.alreadyConfirmed).toBe(true);
    expect((await subscription()).updatedAt).toEqual(active.updatedAt);

    const events = await prisma.subscriptionEvent.findMany({
      where: { tenantId, eventType: { in: ['SUBSCRIPTION_REACTIVATED', 'PAYMENT_SUCCEEDED'] } },
    });
    expect(events).toHaveLength(2);
  });

  it('issues one renewal and refuses to confirm it with a used reference', async () => {
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodStart: days(-27), currentPeriodEnd: days(3) },
    });
    await lifecycle.run();
    await lifecycle.run();
    const renewals = await prisma.subscriptionPayment.findMany({
      where: { tenantId, kind: 'RENEWAL', status: 'PENDING' },
    });
    expect(renewals).toHaveLength(1);
    paymentId = renewals[0].id;

    const response = await request(app.getHttpServer())
      .post(`/api/v1/platform/subscription-payments/${paymentId}/confirm`)
      .set(bearer(adminToken))
      .send({ reference: 'TRF-0001' })
      .expect(409);
    expect(response.body.code).toBe('PAYMENT_REFERENCE_ALREADY_USED');
  });

  it('restricts and then blocks an unpaid subscription until it is paid', async () => {
    await lifecycle.run(days(4));
    expect((await subscription()).status).toBe('PAST_DUE');
    // Read-only, but the subscription routes stay reachable so the tenant can see what it owes.
    await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/patients`)
      .set(bearer(masterToken))
      .send({ firstName: 'Ana', lastName: 'Paciente' })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/tenants/${tenantId}/subscription/payments`)
      .set(bearer(masterToken))
      .expect(200);

    await lifecycle.run(days(11));
    expect((await subscription()).status).toBe('UNPAID');

    await request(app.getHttpServer())
      .post(`/api/v1/platform/subscription-payments/${paymentId}/confirm`)
      .set(bearer(adminToken))
      .send({ reference: 'TRF-0002' })
      .expect(200);
    const renewed = await subscription();
    expect(renewed.status).toBe('ACTIVE');
    expect(renewed.currentPeriodEnd).toEqual(
      (await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } })).periodEnd,
    );
  });
});
