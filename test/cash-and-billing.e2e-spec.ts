import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-cash-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);

// 1x1 PNG, as a signature pad would send it.
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const CONSENT_BODY = 'Yo, {{paciente}}, autorizo {{tratamiento}} con {{profesional}} el {{fecha}}.';

const FORM_SCHEMA = {
  sections: [
    {
      key: 'history',
      title: 'Antecedentes',
      fields: [{ key: 'note', label: 'Nota', type: 'text', required: false }],
    },
  ],
};

const BILLABLE_SESSION_KEYS = [
  'branchId',
  'compliant',
  'completedAt',
  'createdAt',
  'id',
  'patient',
  'price',
  'status',
  'taxRatePercent',
  'treatment',
];

describe('Cash register, orders, payments and billing eligibility (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let tenantId: string;
  let otherTenantId: string;
  let specialtyId: string;
  let professionalId: string;
  let assistantId: string;
  let branchId: string;
  let formId: string;
  let simpleTreatmentId: string;
  let formTreatmentId: string;
  let consentTreatmentId: string;
  let consentTemplateVersionId: string;
  let companyProfileId: string;
  let counter = 0;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const unique = (prefix: string) => `${prefix} ${++counter}`;

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

  const newPatient = async (): Promise<string> => {
    const born = new Date();
    born.setUTCFullYear(born.getUTCFullYear() - 35);
    const created = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({
        firstName: 'Paciente',
        lastName: unique('Caja'),
        dateOfBirth: born.toISOString().slice(0, 10),
        identificationType: 'PASSPORT',
        identificationNumber: `CB${Date.now()}${counter}`,
      })
      .expect(201);
    await request(server())
      .put(`${base()}/patients/${created.body.id}/team/${professionalId}`)
      .set(as('master'))
      .expect(200);
    return created.body.id;
  };

  const createTreatment = async (
    name: string,
    requirements: unknown,
    version: Record<string, unknown> = {},
  ) => {
    const created = await request(server())
      .post(`${base()}/treatments`)
      .set(as('master'))
      .send({
        name: unique(name),
        specialtyId,
        version: { price: 120, taxRatePercent: 15, durationMinutes: 30, requirements, ...version },
      })
      .expect(201);
    return created.body.id as string;
  };

  const sessionUrl = (sessionId: string, suffix = '') =>
    `${base()}/treatment-sessions/${sessionId}${suffix}`;

  const openSession = async (patientId: string, treatmentId: string) => {
    const response = await request(server())
      .post(`${base()}/patients/${patientId}/treatment-sessions`)
      .set(as('pro'))
      .send({ treatmentId })
      .expect(201);
    return response.body as { id: string };
  };

  /** A session of the «Simple» treatment taken to CLINICAL_COMPLETE. */
  const closedSession = async (patientId?: string) => {
    const patient = patientId ?? (await newPatient());
    const session = await openSession(patient, simpleTreatmentId);
    await request(server()).post(sessionUrl(session.id, '/start')).set(as('pro')).expect(201);
    const completed = await request(server())
      .post(sessionUrl(session.id, '/complete'))
      .set(as('pro'))
      .send({ procedureNotes: 'Sin incidencias.' })
      .expect(201);
    expect(completed.body.status).toBe('CLINICAL_COMPLETE');
    return { patientId: patient, sessionId: session.id };
  };

  /** A session of the consent treatment with its consent signed (status CONSENTED). */
  const consentedSession = async () => {
    const patient = await newPatient();
    const session = await openSession(patient, consentTreatmentId);
    const document = await request(server())
      .post(sessionUrl(session.id, '/consents'))
      .set(as('pro'))
      .expect(201);
    await request(server())
      .post(`${base()}/consent-documents/${document.body.id}/sign`)
      .set(as('pro'))
      .send({
        signerRole: 'PATIENT',
        signerName: 'Ana Paciente',
        signerIdentification: '0102030405',
        understood: true,
        questionsAnswered: true,
        signature: SIGNATURE,
      })
      .expect(201);
    return { patientId: patient, sessionId: session.id, documentId: document.body.id as string };
  };

  const openRegister = (who = 'assistant', openingCash = '50.00') =>
    request(server())
      .post(`${base()}/cash-registers/open`)
      .set(as(who))
      .send({ branchId, openingCash });

  const closeRegister = (id: string, body: Record<string, unknown>, who = 'assistant') =>
    request(server()).post(`${base()}/cash-registers/${id}/close`).set(as(who)).send(body);

  /** Closes whatever register is open in the branch (counting what it expects) and opens a new one. */
  const freshRegister = async (openingCash = '50.00') => {
    const open = await prisma.cashRegisterSession.findFirst({
      where: { tenantId, branchId, status: 'OPEN' },
    });
    if (open) {
      const detail = await request(server())
        .get(`${base()}/cash-registers/${open.id}`)
        .set(as('assistant'))
        .expect(200);
      await closeRegister(open.id, { countedCash: detail.body.summary.expectedCash }).expect(201);
    }
    const response = await openRegister('assistant', openingCash).expect(201);
    return response.body.id as string;
  };

  const createOrder = (body: Record<string, unknown>, who = 'assistant') =>
    request(server()).post(`${base()}/orders`).set(as(who)).send(body);

  const getOrder = async (id: string, who = 'assistant') =>
    (await request(server()).get(`${base()}/orders/${id}`).set(as(who)).expect(200)).body;

  const assignProfile = async (orderId: string, profileId = companyProfileId) => {
    const order = await getOrder(orderId);
    return request(server())
      .put(`${base()}/orders/${orderId}/billing-profile`)
      .set(as('assistant'))
      .send({ version: order.version, billingProfileId: profileId })
      .expect(200);
  };

  const pay = (orderId: string, body: Record<string, unknown>, who = 'assistant') =>
    request(server()).post(`${base()}/orders/${orderId}/payments`).set(as(who)).send(body);

  const eligibility = async (orderId: string) =>
    (
      await request(server())
        .get(`${base()}/orders/${orderId}/billing-eligibility`)
        .set(as('assistant'))
        .expect(200)
    ).body as { eligible: boolean; missing: string[]; items: unknown[] };

  const recordedTotal = async (orderId: string) => {
    const sum = await prisma.payment.aggregate({
      where: { orderId, status: 'RECORDED' },
      _sum: { amount: true },
    });
    return sum._sum.amount?.toFixed(2) ?? '0.00';
  };

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
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: {
        planType: 'CLINIC_BASIC',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        featureClinicalNotes: true,
        featureAttachments: true,
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;
    branchId = (await prisma.branch.findFirstOrThrow({ where: { tenantId, isActive: true } })).id;

    const billingConnection = await prisma.invoicingConnection.create({
      data: {
        tenantId,
        apiKeyEncrypted: 'fixture-not-used',
        externalTenantId: 'fixture-tenant',
        taxpayerId: 'fixture-taxpayer',
        taxpayerName: 'Fixture',
        taxpayerRuc: '1790012345001',
        environment: '1',
        validatedAt: new Date(),
      },
    });
    await prisma.branchEmissionPoint.create({
      data: {
        branchId,
        connectionId: billingConnection.id,
        establishmentId: 'fixture-establishment',
        emissionPointId: 'fixture-point',
        establishmentCode: '001',
        emissionPointCode: '001',
      },
    });

    professionalId = (await member(tenantId, 'pro@tenant.test', 'PROFESIONAL')).id;
    assistantId = (await member(tenantId, 'assistant@tenant.test', 'ASISTENTE')).id;

    tokens.master = await login('admin+1@tenant.test');
    tokens.otherMaster = await login('admin+2@tenant.test');
    tokens.pro = await login('pro@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');

    // The assistant runs the cash desk but may not adjust: no billing.adjust.
    await request(server())
      .put(`${base()}/users/${assistantId}/permissions`)
      .set(as('master'))
      .send({ revoked: [], granted: ['billing.view', 'billing.create', 'cash.manage'] })
      .expect(200);

    const form = await request(server())
      .post(`${base()}/form-definitions`)
      .set(as('master'))
      .send({ name: 'Ficha de caja', schema: FORM_SCHEMA })
      .expect(201);
    formId = form.body.id;

    const template = await request(server())
      .post(`${base()}/consent-templates`)
      .set(as('master'))
      .send({ name: unique('Plantilla'), title: 'Consentimiento de caja', body: CONSENT_BODY })
      .expect(201);
    const published = await request(server())
      .post(`${base()}/consent-templates/${template.body.id}/publish`)
      .set(as('master'))
      .expect(200);
    consentTemplateVersionId = published.body.versions.find(
      (candidate: { status: string }) => candidate.status === 'PUBLISHED',
    ).id;

    simpleTreatmentId = await createTreatment('Simple', {});
    formTreatmentId = await createTreatment(
      'Con ficha',
      { medicalForm: { required: true } },
      { formDefinitionId: formId, formVersion: 1 },
    );
    consentTreatmentId = await createTreatment(
      'Con consentimiento',
      { informedConsent: { required: true, validityDays: 365 } },
      { consentTemplateVersionId },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes two closed sessions from the cash desk to a paid, eligible order and a balanced close', async () => {
    const first = await closedSession();
    const second = await closedSession();
    const registerId = (await openRegister().expect(201)).body.id as string;

    // Both sessions are listed with the compliance flag and nothing else than BillableSession.
    for (const { patientId, sessionId } of [first, second]) {
      const listed = await request(server())
        .get(`${base()}/treatment-sessions/billable?patientId=${patientId}`)
        .set(as('assistant'))
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].id).toBe(sessionId);
      expect(listed.body[0].compliant).toBe(true);
      expect(Object.keys(listed.body[0]).sort()).toEqual([...BILLABLE_SESSION_KEYS].sort());
    }

    const created = await createOrder({
      branchId,
      treatmentSessionIds: [first.sessionId, second.sessionId],
    }).expect(201);
    const orderId = created.body.id as string;
    expect(created.body.status).toBe('OPEN');
    expect(created.body.total).toBe('276.00');
    expect(created.body.items).toHaveLength(2);

    // A COMPANY profile, apart from any patient.
    const profile = await request(server())
      .post(`${base()}/billing-profiles`)
      .set(as('assistant'))
      .send({
        kind: 'COMPANY',
        idType: '04',
        idNumber: '1710034065001',
        legalName: 'Empresa Caja S.A.',
        email: 'facturas@empresa.test',
      })
      .expect(201);
    companyProfileId = profile.body.id;
    const assigned = await assignProfile(orderId);
    expect(assigned.body.billingProfile.id).toBe(companyProfileId);

    const patientBefore = (
      await request(server())
        .get(`${base()}/patients/${first.patientId}`)
        .set(as('master'))
        .expect(200)
    ).body;

    const cash = await pay(orderId, { method: 'CASH', amount: '10.00' }).expect(201);
    expect(cash.body.status).toBe('OPEN');
    expect(cash.body.balance).toBe('266.00');
    const card = await pay(orderId, { method: 'CREDIT_CARD', amount: '266.00' }).expect(201);
    expect(card.body.status).toBe('PAID');
    expect(card.body.paidTotal).toBe('276.00');
    expect(card.body.balance).toBe('0.00');

    expect(await eligibility(orderId)).toEqual({ eligible: true, missing: [], items: [] });

    const closed = await closeRegister(registerId, { countedCash: '60.00' }).expect(201);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.difference).toBe('0.00');

    // E2E-04: the third party never became a patient and the patient did not change.
    const patientAfter = (
      await request(server())
        .get(`${base()}/patients/${first.patientId}`)
        .set(as('master'))
        .expect(200)
    ).body;
    expect(patientAfter).toEqual(patientBefore);
    expect(await prisma.patient.count({ where: { identificationNumber: '1710034065001' } })).toBe(
      0,
    );
  });

  it('E2E-02: a paid order of a session without its form lists the form and the completion', async () => {
    await freshRegister();
    const patient = await newPatient();
    const session = await openSession(patient, formTreatmentId);
    const order = (await createOrder({ branchId, treatmentSessionIds: [session.id] }).expect(201))
      .body;
    await assignProfile(order.id);
    await pay(order.id, { method: 'CASH', amount: order.total }).expect(201);

    const result = await eligibility(order.id);
    expect(result.eligible).toBe(false);
    expect(result.missing).toEqual(['FINALIZED_MEDICAL_FORM', 'CLINICAL_COMPLETION']);
  });

  it('E2E-03: a paid order of a session without a signed consent lists the consent', async () => {
    await freshRegister();
    const patient = await newPatient();
    const session = await openSession(patient, consentTreatmentId);
    const order = (await createOrder({ branchId, treatmentSessionIds: [session.id] }).expect(201))
      .body;
    await assignProfile(order.id);
    await pay(order.id, { method: 'CASH', amount: order.total }).expect(201);

    const result = await eligibility(order.id);
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain('SIGNED_APPLICABLE_CONSENT');
  });

  it('refuses a payment with the register closed and a count that differs without a note', async () => {
    const registerId = await freshRegister();
    const { sessionId } = await closedSession();
    const order = (await createOrder({ branchId, treatmentSessionIds: [sessionId] }).expect(201))
      .body;

    const noNote = await closeRegister(registerId, { countedCash: '49.00' }).expect(422);
    expect(noNote.body.code).toBe('CASH_CLOSING_NOTE_REQUIRED');
    const withNote = await closeRegister(registerId, {
      countedCash: '49.00',
      closingNote: 'Faltó un dólar.',
    }).expect(201);
    expect(withNote.body.difference).toBe('-1.00');

    const closed = await pay(order.id, { method: 'CASH', amount: '10.00' }).expect(409);
    expect(closed.body.code).toBe('CASH_REGISTER_CLOSED');
  });

  it('lets the master add a free item and refuses the assistant, who lacks billing.adjust', async () => {
    const order = (await createOrder({ branchId }).expect(201)).body;
    const item = (version: number) => ({
      version,
      kind: 'FREE',
      description: 'Kit de cuidado',
      quantity: '1',
      unitPrice: '25.00',
      taxRatePercent: 15,
    });
    await request(server())
      .post(`${base()}/orders/${order.id}/items`)
      .set(as('assistant'))
      .send(item(order.version))
      .expect(403);
    const added = await request(server())
      .post(`${base()}/orders/${order.id}/items`)
      .set(as('master'))
      .send(item(order.version))
      .expect(201);
    expect(added.body.items).toHaveLength(1);
    expect(added.body.total).toBe('28.75');
  });

  it('answers 404 to the master of another tenant for the order, profile, register and payment', async () => {
    const registerId = await freshRegister();
    const { sessionId } = await closedSession();
    const order = (await createOrder({ branchId, treatmentSessionIds: [sessionId] }).expect(201))
      .body;
    const payment = (await pay(order.id, { method: 'CASH', amount: '5.00' }).expect(201)).body
      .payments[0];

    const foreign = (path: string) =>
      request(server())
        .get(`${base(otherTenantId)}${path}`)
        .set(as('otherMaster'));
    expect((await foreign(`/orders/${order.id}`).expect(404)).body.code).toBe('ORDER_NOT_FOUND');
    expect((await foreign(`/billing-profiles/${companyProfileId}`).expect(404)).body.code).toBe(
      'BILLING_PROFILE_NOT_FOUND',
    );
    expect((await foreign(`/cash-registers/${registerId}`).expect(404)).body.code).toBe(
      'CASH_REGISTER_NOT_FOUND',
    );
    const refund = await request(server())
      .post(`${base(otherTenantId)}/payments/${payment.id}/refund`)
      .set(as('otherMaster'))
      .send({ reason: 'Intento ajeno' })
      .expect(404);
    expect(refund.body.code).toBe('PAYMENT_NOT_FOUND');
    // Reaching the resource through the own tenant's prefix is refused too.
    await request(server()).get(`${base()}/orders/${order.id}`).set(as('otherMaster')).expect(403);
  });

  describe('concurrency', () => {
    it('two full payments at once: one is recorded and the recorded sum equals the total', async () => {
      await freshRegister();
      const { sessionId } = await closedSession();
      const order = (await createOrder({ branchId, treatmentSessionIds: [sessionId] }).expect(201))
        .body;

      const results = await Promise.all([
        pay(order.id, { method: 'CASH', amount: order.total }),
        pay(order.id, { method: 'CREDIT_CARD', amount: order.total }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      const loser = results.find((r) => r.status !== 201)!;
      expect([409, 422]).toContain(loser.status);

      expect(await recordedTotal(order.id)).toBe(order.total);
      expect((await getOrder(order.id)).status).toBe('PAID');
    });

    it('two openings at once: one 201 and one 409', async () => {
      const open = await prisma.cashRegisterSession.findFirst({
        where: { tenantId, branchId, status: 'OPEN' },
      });
      if (open) {
        await closeRegister(open.id, { countedCash: '0.00', closingNote: 'Cierre de prueba' });
      }
      const results = await Promise.all([openRegister(), openRegister('master')]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('CASH_REGISTER_ALREADY_OPEN');
      expect(
        await prisma.cashRegisterSession.count({ where: { tenantId, branchId, status: 'OPEN' } }),
      ).toBe(1);
    });

    it('the same session in two orders at once: one 201 and one 409', async () => {
      const { sessionId } = await closedSession();
      const results = await Promise.all([
        createOrder({ branchId, treatmentSessionIds: [sessionId] }),
        createOrder({ branchId, treatmentSessionIds: [sessionId] }, 'master'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.orderItem.count({
          where: { treatmentSessionId: sessionId, releasedAt: null },
        }),
      ).toBe(1);
    });
  });

  it('a consent revoked before the session starts makes the paid order not billable, and the refund reopens it', async () => {
    await freshRegister();
    const { sessionId, documentId } = await consentedSession();
    const order = (await createOrder({ branchId, treatmentSessionIds: [sessionId] }).expect(201))
      .body;
    await assignProfile(order.id);
    const paid = await pay(order.id, { method: 'CASH', amount: order.total }).expect(201);
    expect(paid.body.status).toBe('PAID');
    expect((await eligibility(order.id)).missing).not.toContain('SESSION_NOT_BILLABLE');

    await request(server())
      .post(`${base()}/consent-documents/${documentId}/revoke`)
      .set(as('pro'))
      .send({ reason: 'El paciente retiró su consentimiento.' })
      .expect(201);

    const blocked = await eligibility(order.id);
    expect(blocked.eligible).toBe(false);
    expect(blocked.missing).toContain('SESSION_NOT_BILLABLE');

    const refunded = await request(server())
      .post(`${base()}/payments/${paid.body.payments[0].id}/refund`)
      .set(as('master'))
      .send({ reason: 'Consentimiento revocado' })
      .expect(200);
    expect(refunded.body.status).toBe('OPEN');
    const after = await getOrder(order.id);
    expect(after.status).toBe('OPEN');
    expect(after.paidTotal).toBe('0.00');
  });

  it('serves GET /treatment-sessions/billable to an assistant instead of treating it as a session id', async () => {
    const response = await request(server())
      .get(`${base()}/treatment-sessions/billable`)
      .set(as('assistant'))
      .expect(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
