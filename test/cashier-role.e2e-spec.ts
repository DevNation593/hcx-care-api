import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-cashier-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createPlatformAdmin } from './../prisma/create-platform-admin';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);

const CASHIER_PERMISSIONS = ['billing.view', 'billing.create', 'billing.adjust', 'cash.manage'];

describe('Cashier role: cash desk without clinical reach (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let tenantId: string;
  let branchId: string;
  let specialtyId: string;
  let treatmentId: string;
  let cashierId: string;
  let counter = 0;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = () => `/api/v1/tenants/${tenantId}`;
  const roleUrl = () => `/api/v1/platform/tenants/${tenantId}/roles/CAJERO/permissions`;

  const login = async (email: string) => {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };

  /** A completed, billable session for a new patient. */
  const closedSession = async () => {
    const born = new Date();
    born.setUTCFullYear(born.getUTCFullYear() - 35);
    counter += 1;
    const patient = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({
        firstName: 'Paciente',
        lastName: `Cajero ${counter}`,
        dateOfBirth: born.toISOString().slice(0, 10),
        identificationType: 'PASSPORT',
        identificationNumber: `CJ${Date.now()}${counter}`,
      })
      .expect(201);
    await request(server())
      .put(`${base()}/patients/${patient.body.id}/team/${professionalId}`)
      .set(as('master'))
      .expect(200);
    const session = await request(server())
      .post(`${base()}/patients/${patient.body.id}/treatment-sessions`)
      .set(as('pro'))
      .send({ treatmentId })
      .expect(201);
    const sessionUrl = `${base()}/treatment-sessions/${session.body.id}`;
    await request(server()).post(`${sessionUrl}/start`).set(as('pro')).expect(201);
    await request(server())
      .post(`${sessionUrl}/complete`)
      .set(as('pro'))
      .send({ procedureNotes: 'Sin incidencias.' })
      .expect(201);
    return session.body.id as string;
  };

  const createOrder = (sessionId: string) =>
    request(server())
      .post(`${base()}/orders`)
      .set(as('cashier'))
      .send({ branchId, treatmentSessionIds: [sessionId] });

  const discount = (order: { id: string; version: number; items: { id: string }[] }) =>
    request(server())
      .patch(`${base()}/orders/${order.id}/items/${order.items[0].id}`)
      .set(as('cashier'))
      .send({ version: order.version, discount: '20.00' });

  let professionalId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // The same options as the global pipe in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get<PrismaService>(PrismaService);
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    await createPlatformAdmin(prisma, {
      email: 'platform-cashier-e2e@example.test',
      password: TEST_PASSWORD,
      firstName: 'Platform',
      lastName: 'Admin',
    });
    tenantId = (await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId },
      data: {
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;
    branchId = (await prisma.branch.findFirstOrThrow({ where: { tenantId, isActive: true } })).id;

    professionalId = (
      await users.create(
        {
          tenantId,
          email: 'pro-cashier@tenant.test',
          password: TEST_PASSWORD,
          firstName: 'Profesional',
          lastName: 'Member',
          role: 'PROFESIONAL',
          professionalProfile: { specialtyId },
        },
        'fixture-actor',
      )
    ).id;

    tokens.master = await login('admin+1@tenant.test');
    tokens.platform = await login('platform-cashier-e2e@example.test');
    tokens.pro = await login('pro-cashier@tenant.test');

    treatmentId = (
      await request(server())
        .post(`${base()}/treatments`)
        .set(as('master'))
        .send({
          name: 'Tratamiento de caja',
          code: 'CAJERO-1',
          specialtyId,
          version: { price: 120, taxRatePercent: 15, durationMinutes: 30, requirements: {} },
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. the account holder creates a cashier without touching the professional seats', async () => {
    const seatsBefore = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    const profilesBefore = await prisma.professionalProfile.count({
      where: { isActive: true, user: { tenantId } },
    });

    const created = await request(server())
      .post(`${base()}/users`)
      .set(as('master'))
      .send({
        email: 'cajero@tenant.test',
        password: TEST_PASSWORD,
        firstName: 'Cajera',
        lastName: 'Principal',
        role: 'CAJERO',
      })
      .expect(201);
    cashierId = created.body.id;
    expect(created.body.role).toBe('CAJERO');
    // Created active with a password, as an assistant is: there is no invitation to activate.
    expect(created.body.isActive).toBe(true);

    const seatsAfter = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    expect(seatsAfter.seatsPsychologistsUsed).toBe(seatsBefore.seatsPsychologistsUsed);
    expect(
      await prisma.professionalProfile.count({ where: { isActive: true, user: { tenantId } } }),
    ).toBe(profilesBefore);
    expect(await prisma.professionalProfile.count({ where: { userId: cashierId } })).toBe(0);

    tokens.cashier = await login('cajero@tenant.test');
  });

  it('2. the cashier reads branches, the tenant and exactly its four permissions', async () => {
    const branches = await request(server())
      .get(`${base()}/branches`)
      .set(as('cashier'))
      .expect(200);
    expect(branches.body.map((b: { id: string }) => b.id)).toContain(branchId);
    await request(server()).get(base()).set(as('cashier')).expect(200);

    const mine = await request(server())
      .get(`${base()}/users/me/permissions`)
      .set(as('cashier'))
      .expect(200);
    expect([...mine.body.effective].sort()).toEqual([...CASHIER_PERMISSIONS].sort());
  });

  it('3. the cashier opens the register, charges a session with a discount and closes with a count', async () => {
    const sessionId = await closedSession();

    const register = await request(server())
      .post(`${base()}/cash-registers/open`)
      .set(as('cashier'))
      .send({ branchId, openingCash: '50.00' })
      .expect(201);

    const created = await createOrder(sessionId).expect(201);
    expect(created.body.total).toBe('138.00');

    const discounted = await discount(created.body).expect(200);
    expect(discounted.body.total).toBe('115.00');

    const paid = await request(server())
      .post(`${base()}/orders/${created.body.id}/payments`)
      .set(as('cashier'))
      .send({ method: 'CASH', amount: discounted.body.total })
      .expect(201);
    expect(paid.body.status).toBe('PAID');

    const closed = await request(server())
      .post(`${base()}/cash-registers/${register.body.id}/close`)
      .set(as('cashier'))
      .send({ countedCash: '165.00' })
      .expect(201);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.difference).toBe('0.00');
  });

  it('4. the cashier cannot read patients, appointments or clinical notes', async () => {
    for (const path of ['patients', 'appointments', 'clinical-notes']) {
      const refused = await request(server())
        .get(`${base()}/${path}`)
        .set(as('cashier'))
        .expect(403);
      expect(refused.body.message).toMatch(/Required roles/);
    }
  });

  it('5. with billing.adjust withdrawn for the role, a new discount is refused', async () => {
    const sessionId = await closedSession();
    await request(server())
      .post(`${base()}/cash-registers/open`)
      .set(as('cashier'))
      .send({ branchId, openingCash: '0.00' })
      .expect(201);
    const created = await createOrder(sessionId).expect(201);

    await request(server())
      .put(roleUrl())
      .set(as('platform'))
      .send({ allowed: CASHIER_PERMISSIONS.filter((p) => p !== 'billing.adjust') })
      .expect(200);

    const refused = await discount(created.body).expect(403);
    expect(refused.body).toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'billing.adjust',
      message: 'El administrador de la plataforma retiró este permiso de tu rol.',
    });
    const unchanged = await request(server())
      .get(`${base()}/orders/${created.body.id}`)
      .set(as('cashier'))
      .expect(200);
    expect(unchanged.body.total).toBe('138.00');

    // The rest of the desk keeps working.
    await request(server())
      .post(`${base()}/orders/${created.body.id}/payments`)
      .set(as('cashier'))
      .send({ method: 'CASH', amount: '138.00' })
      .expect(201);
  });

  it('6. the inventory is closed to the cashier until inventory.manage is granted', async () => {
    const refused = await request(server())
      .get(`${base()}/products`)
      .set(as('cashier'))
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'inventory.manage',
    });

    await request(server())
      .put(roleUrl())
      .set(as('platform'))
      .send({
        allowed: [...CASHIER_PERMISSIONS.filter((p) => p !== 'billing.adjust'), 'inventory.manage'],
      })
      .expect(200);

    await request(server()).get(`${base()}/products`).set(as('cashier')).expect(200);
  });

  it('7. the owner cannot assign a patient task to the cashier', async () => {
    const born = new Date();
    born.setUTCFullYear(born.getUTCFullYear() - 30);
    const patient = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({
        firstName: 'Paciente',
        lastName: 'Tarea',
        dateOfBirth: born.toISOString().slice(0, 10),
        identificationType: 'PASSPORT',
        identificationNumber: `TK${Date.now()}`,
      })
      .expect(201);

    const refused = await request(server())
      .post(`${base()}/tasks`)
      .set(as('master'))
      .send({
        title: 'Llamar al paciente',
        patientId: patient.body.id,
        priority: 'MEDIUM',
        assignedToId: cashierId,
      })
      .expect(400);
    expect(refused.body).toMatchObject({
      code: 'TASK_ASSIGNEE_NOT_ALLOWED',
      message: 'Solo se pueden asignar actividades al titular, a profesionales o a asistentes.',
    });
  });
});
