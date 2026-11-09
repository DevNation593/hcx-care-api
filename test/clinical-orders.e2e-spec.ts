import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

/**
 * Orders, results and follow-ups against PostgreSQL: the acceptance criteria CA-006 (a received
 * result waits for review in the inbox), CA-007 (attaching it does not inform the patient) and
 * CA-008 (cancelling an appointment does not close a pending follow-up), plus who can reach them.
 */
describe('Clinical orders, results and follow-ups (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let tenantId: string;
  let otherTenantId: string;
  let specialtyId: string;
  let colleagueId: string;
  let patientId: string;
  let orderId: string;
  let resultId: string;
  let followUpId: string;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;

  const login = async (email: string) => {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };

  const member = async (tenant: string, email: string, role: 'PROFESIONAL' | 'ASISTENTE') =>
    users.create(
      {
        tenantId: tenant,
        email,
        password: TEST_PASSWORD,
        firstName: role,
        lastName: 'Member',
        role,
        ...(role === 'PROFESIONAL' ? { professionalProfile: { specialtyId } } : {}),
      },
      'fixture-actor',
    );

  const order = () =>
    request(server()).get(`${base()}/clinical-orders/${orderId}`).set(as('pro')).expect(200);

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
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: { planId: 'plan_clinic_basic', status: 'ACTIVE', seatsPsychologistsMax: 5 },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;

    await member(tenantId, 'pro@tenant.test', 'PROFESIONAL');
    colleagueId = (await member(tenantId, 'colleague@tenant.test', 'PROFESIONAL')).id;
    await member(tenantId, 'assistant@tenant.test', 'ASISTENTE');
    await member(otherTenantId, 'outsider@tenant.test', 'PROFESIONAL');
    patientId = (
      await prisma.patient.create({
        data: { tenantId, firstName: 'Lucía', lastName: 'Paciente' },
      })
    ).id;

    tokens.master = await login('admin+1@tenant.test');
    tokens.pro = await login('pro@tenant.test');
    tokens.colleague = await login('colleague@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');
    tokens.outsider = await login('outsider@tenant.test');
  });

  afterAll(async () => {
    await app.close();
  });

  it('asks the password to sign an order saved outside any encounter', async () => {
    const input = { orderType: 'PATHOLOGY', studyName: 'Citología cervicovaginal' };
    const refused = await request(server())
      .post(`${base()}/patients/${patientId}/clinical-orders`)
      .set(as('pro'))
      .send({ ...input, password: 'wrong' })
      .expect(403);
    expect(refused.body.code).toBe('SIGNATURE_PASSWORD_INVALID');

    const created = await request(server())
      .post(`${base()}/patients/${patientId}/clinical-orders`)
      .set(as('pro'))
      .send({ ...input, indication: 'Tamizaje', password: TEST_PASSWORD })
      .expect(201);
    orderId = created.body.id;
    expect(created.body).toMatchObject({ status: 'ORDERED', version: 1 });
    expect(created.body.contentHash).toMatch(/^v1:/);

    const stored = await prisma.clinicalOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(stored.studyName).not.toContain('Citología');
  });

  it('keeps orders away from the assistant and from another clinic', async () => {
    await request(server())
      .get(`${base()}/patients/${patientId}/clinical-orders`)
      .set(as('assistant'))
      .expect(403);
    await request(server()).get(`${base()}/clinical-inbox`).set(as('assistant')).expect(403);
    // Knowing the id is not enough from another clinic, through its own tenant or this one.
    await request(server())
      .get(`${base(otherTenantId)}/clinical-orders/${orderId}`)
      .set(as('outsider'))
      .expect(404);
    await request(server())
      .get(`${base()}/clinical-orders/${orderId}`)
      .set(as('outsider'))
      .expect(403);
  });

  it('puts a received result in the inbox, pending review, without informing the patient', async () => {
    await request(server())
      .post(`${base()}/clinical-orders/${orderId}/sent`)
      .set(as('colleague'))
      .send({ version: 1, provider: 'Laboratorio Central', externalReference: 'LC-1' })
      .expect(201);
    const stale = await request(server())
      .post(`${base()}/clinical-orders/${orderId}/results`)
      .set(as('pro'))
      .send({ version: 1, content: 'Informe' })
      .expect(409);
    expect(stale.body.code).toBe('CLINICAL_ORDER_VERSION_CONFLICT');

    const withResult = await request(server())
      .post(`${base()}/clinical-orders/${orderId}/results`)
      .set(as('pro'))
      .send({ version: 2, content: 'Muestra insuficiente para evaluación.' })
      .expect(201);
    resultId = withResult.body.currentResult.id;
    expect(withResult.body.status).toBe('PENDING_REVIEW');
    expect(withResult.body.currentResult).toMatchObject({
      status: 'PENDING_REVIEW',
      communicatedAt: null,
      reviewedAt: null,
    });

    const inbox = await request(server())
      .get(`${base()}/clinical-inbox`)
      .set(as('pro'))
      .expect(200);
    expect(inbox.body.pendingReview).toEqual([
      expect.objectContaining({
        id: resultId,
        order: expect.objectContaining({ studyName: 'Citología cervicovaginal' }),
      }),
    ]);
    // The colleague placed no order: their own inbox is empty, the clinic's is not.
    const colleagueInbox = await request(server())
      .get(`${base()}/clinical-inbox`)
      .set(as('colleague'))
      .expect(200);
    expect(colleagueInbox.body.pendingReview).toEqual([]);
    const clinic = await request(server())
      .get(`${base()}/clinical-inbox?scope=all`)
      .set(as('colleague'))
      .expect(200);
    expect(clinic.body.pendingReview).toHaveLength(1);
  });

  it('does not close an order with a result that nobody reviewed', async () => {
    const refused = await request(server())
      .post(`${base()}/clinical-orders/${orderId}/complete`)
      .set(as('pro'))
      .send({ version: 3, note: 'Cerrar' })
      .expect(409);
    expect(refused.body.code).toBe('CLINICAL_ORDER_INVALID_STATE');
  });

  it('reviews with a repetition, which opens a follow-up for the colleague', async () => {
    const reviewed = await request(server())
      .post(`${base()}/clinical-results/${resultId}/review`)
      .set(as('pro'))
      .send({
        decision: 'REPEAT_REQUIRED',
        note: 'Muestra inadecuada: repetir la toma.',
        appointmentNeeded: true,
        followUp: {
          title: 'Repetir citología',
          dueDate: '2026-12-15T00:00:00.000Z',
          assignedToId: colleagueId,
        },
      })
      .expect(201);
    expect(reviewed.body.status).toBe('REVIEWED');
    expect(reviewed.body.followUps).toHaveLength(1);
    followUpId = reviewed.body.followUps[0].id;

    const colleagueInbox = await request(server())
      .get(`${base()}/clinical-inbox`)
      .set(as('colleague'))
      .expect(200);
    expect(colleagueInbox.body.followUps).toEqual([
      expect.objectContaining({ id: followUpId, title: 'Repetir citología' }),
    ]);
  });

  it('keeps the follow-up open when the next appointment is cancelled', async () => {
    const appointment = await prisma.appointment.create({
      data: {
        tenantId,
        patientId,
        professionalId: colleagueId,
        psychologistId: colleagueId,
        title: 'Control',
        startTime: new Date('2026-12-14T15:00:00Z'),
        endTime: new Date('2026-12-14T16:00:00Z'),
        duration: 60,
      },
    });
    await request(server())
      .post(`${base()}/appointments/${appointment.id}/cancel`)
      .set(as('assistant'))
      .send({ reason: 'La paciente pidió cambiar la fecha' })
      .expect(201);

    const followUp = await prisma.clinicalFollowUp.findUniqueOrThrow({ where: { id: followUpId } });
    expect(followUp.status).toBe('OPEN');
    expect((await order()).body.status).toBe('REVIEWED');
  });

  it('closes the order only after the contact and the follow-up', async () => {
    const contacted = await request(server())
      .post(`${base()}/clinical-results/${resultId}/communication`)
      .set(as('pro'))
      .send({ channel: 'PHONE', note: 'Se le explicó que hay que repetir la toma.' })
      .expect(201);
    expect(contacted.body.status).toBe('PATIENT_CONTACTED');

    const open = await request(server())
      .post(`${base()}/clinical-orders/${orderId}/complete`)
      .set(as('pro'))
      .send({ version: contacted.body.version })
      .expect(409);
    expect(open.body.code).toBe('CLINICAL_ORDER_FOLLOW_UPS_OPEN');

    await request(server())
      .post(`${base()}/clinical-follow-ups/${followUpId}/close`)
      .set(as('colleague'))
      .send({ version: 1, status: 'DONE', note: 'Se ordenó una nueva citología.' })
      .expect(201);
    const completed = await request(server())
      .post(`${base()}/clinical-orders/${orderId}/complete`)
      .set(as('pro'))
      .send({ version: contacted.body.version })
      .expect(201);
    expect(completed.body.status).toBe('COMPLETED');
  });

  it('audits every read and change of the order, without clinical text in the clear', async () => {
    const entries = await prisma.auditLog.findMany({
      where: {
        tenantId,
        entity: { in: ['CLINICAL_ORDER', 'CLINICAL_RESULT', 'CLINICAL_FOLLOW_UP'] },
      },
    });
    const kinds = new Set(entries.map(({ entity, action }) => `${entity}:${action}`));
    expect([...kinds].sort()).toEqual(
      [
        'CLINICAL_FOLLOW_UP:CREATE',
        'CLINICAL_FOLLOW_UP:READ',
        'CLINICAL_FOLLOW_UP:UPDATE',
        'CLINICAL_ORDER:CREATE',
        'CLINICAL_ORDER:READ',
        'CLINICAL_ORDER:UPDATE',
        'CLINICAL_RESULT:CREATE',
        'CLINICAL_RESULT:UPDATE',
      ].sort(),
    );
    expect(JSON.stringify(entries)).not.toContain('Citología');
  });
});
