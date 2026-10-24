import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { createHash, createHmac, randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlatformTenantsService } from '../src/platform/platform-tenants.service';
import { UsersService } from '../src/users/users.service';
import { Prisma } from '@prisma/client';
import { InvoiceWorkerService } from '../src/invoicing/invoice-worker.service';
import { TreatmentSessionsService } from '../src/treatment-sessions/treatment-sessions.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);
const tid = '11111111-1111-4111-8111-111111111111';
const eid = '22222222-2222-4222-8222-222222222222';
const pid = '33333333-3333-4333-8333-333333333333';
const customerId = '44444444-4444-4444-8444-444444444444';
const secret = 'whsec_' + Buffer.alloc(32, 3).toString('base64');
const taxpayer = {
  id: tid,
  ruc: '1790012345001',
  legalName: 'Issuer',
  tradeName: null,
  headOfficeAddress: 'Quito',
  defaultEnvironment: '1',
  accountingRequired: false,
  specialTaxpayerCode: null,
  withholdingAgentCode: null,
  rimpeRegime: 'NONE',
  productionEnabledAt: null,
};

describe('durable invoicing HTTP / PostgreSQL / provider simulator', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let upstream: Server;
  let tenantId: string;
  let actorId: string;
  let branchId: string;
  let profileId: string;
  let token: string;
  let connectionId: string;
  let seq = 0;
  let posts: { key: string; body: any }[] = [];
  let mode = 'normal';
  let customerName = 'Fiscal buyer';
  let invoiceGate: { entered: () => void; release?: () => void } | null = null;
  const docs = new Map<string, any>();
  const products: any[] = [];
  const base = () => `/api/v1/tenants/${tenantId}`;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();
  async function order() {
    const o = await prisma.order.create({
      data: {
        tenantId,
        branchId,
        number: ++seq,
        status: 'PAID',
        billingProfileId: profileId,
        createdById: actorId,
        subtotal: 40,
        total: 40,
        paidTotal: 40,
        items: {
          create: {
            tenantId,
            kind: 'FREE',
            description: 'Service',
            quantity: 1,
            unitPrice: 40,
            taxRatePercent: 0,
            lineSubtotal: 40,
            lineTax: 0,
            createdById: actorId,
          },
        },
      },
    });
    const register = await prisma.cashRegisterSession.findFirst({ where: { tenantId } });
    await prisma.payment.create({
      data: {
        tenantId,
        orderId: o.id,
        cashRegisterSessionId: register!.id,
        method: 'CASH',
        amount: 40,
        receivedById: actorId,
      },
    });
    return o;
  }
  async function sessionOrder(treatmentVersionId: string, completed = true) {
    const patient = await prisma.patient.create({
      data: {
        tenantId,
        firstName: 'PRIVATE_PATIENT_NAME',
        lastName: 'PRIVATE_SURNAME',
        notes: 'PRIVATE_NOTES',
      },
    });
    const specialty = await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } });
    const encounter = await prisma.encounter.create({
      data: {
        tenantId,
        patientId: patient.id,
        professionalId: actorId,
        specialtyId: specialty.id,
        branchId,
        encounterType: 'PROCEDURE',
        reason: 'PRIVATE_REASON',
      },
    });
    const session = await prisma.treatmentSession.create({
      data: {
        tenantId,
        patientId: patient.id,
        professionalId: actorId,
        branchId,
        encounterId: encounter.id,
        treatmentVersionId,
        status: completed ? 'CLINICAL_COMPLETE' : 'IN_PROGRESS',
        startedAt: new Date(),
        completedAt: completed ? new Date() : null,
        procedureNotes: 'PRIVATE_CLINICAL_NOTES',
      },
    });
    const o = await order();
    await prisma.orderItem.updateMany({
      where: { orderId: o.id },
      data: { kind: 'TREATMENT_SESSION', treatmentSessionId: session.id, patientId: patient.id },
    });
    return { order: o, session };
  }
  async function treatment(early = false) {
    return prisma.treatment.create({
      data: {
        tenantId,
        name: 'Service ' + randomUUID(),
        code: 'SRV-' + randomUUID().slice(0, 8).toUpperCase(),
        versions: {
          create: {
            tenantId,
            version: 1,
            price: 40,
            taxRatePercent: 0,
            durationMinutes: 30,
            createdById: actorId,
            requirements: {
              medicalForm: { required: false },
              informedConsent: { required: false, validityDays: null },
              photos: { minimumBefore: 0, minimumAfter: 0 },
              clinicalNotes: { requiredForCompletion: false },
              billingGate: { requireClinicalCompletion: !early },
            },
          },
        },
      },
      include: { versions: true },
    });
  }
  async function concurrentCompletionFixture(outcome: string) {
    const t = await treatment(true);
    const fixture = await sessionOrder(t.versions[0].id, false);
    const receipt = (await submit(fixture.order.id).expect(202)).body;
    const worker = app.get(InvoiceWorkerService);
    let finalize: () => Promise<void>;
    if (outcome === 'FAILED') {
      const claimed = (await worker.claim()).find((row) => row.id === receipt.id)!;
      // A definitive pre-POST customer mismatch safely releases this order.
      finalize = async () => {
        customerName = 'Outdated';
        try {
          await worker.process(claimed);
        } finally {
          customerName = 'Fiscal buyer';
        }
      };
    } else {
      await dispatch();
      const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: receipt.id } });
      const document = {
        ...docs.get(row.externalDocumentId!),
        state: outcome === 'REJECTED' ? 'NOT_AUTHORIZED' : 'AUTHORIZED',
      };
      finalize = () => worker.applyDocument(row.id, document, 'RECONCILER');
    }
    return { ...fixture, receipt, finalize };
  }
  const submit = (id: string, key = randomUUID()) =>
    request(server())
      .post(`${base()}/orders/${id}/invoice-requests`)
      .set(auth())
      .set('Idempotency-Key', key);
  async function dispatch() {
    const { InvoiceWorkerService } = await import('../src/invoicing/invoice-worker.service');
    await app.get(InvoiceWorkerService).dispatch();
  }
  async function reconcile() {
    const { InvoiceWorkerService } = await import('../src/invoicing/invoice-worker.service');
    await prisma.invoiceRequest.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await app.get(InvoiceWorkerService).reconcile();
  }
  beforeAll(async () => {
    process.env.CLINICAL_ENCRYPTION_KEYS = 'b2:' + Buffer.alloc(32, 7).toString('base64');
    process.env.STORAGE_LOCAL_PATH = mkdtempSync(join(tmpdir(), 'hcx-b2-'));
    upstream = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://localhost');
        const path = url.pathname;
        const json = (v: unknown, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        if (req.headers['x-api-key'] !== 'test-key') return json({ code: 'UNAUTHENTICATED' }, 401);
        if (path.endsWith('/tenants/current'))
          return json({ id: tid, name: 'Company', status: 'ACTIVE', role: 'BILLER' });
        if (path.endsWith('/taxpayers')) return json([taxpayer]);
        if (path.endsWith('/establishments'))
          return json([{ id: eid, taxpayerId: tid, code: '001', address: 'Quito' }]);
        if (path.endsWith('/emission-points'))
          return json([{ id: pid, establishmentId: eid, code: '002', enabled: true }]);
        if (path.endsWith('/tax-rates'))
          return json([{ taxCode: '2', rateCode: '0', description: '0%', rate: '0.00' }]);
        if (path.endsWith('/customers'))
          return json({
            items: [
              {
                id: customerId,
                idType: '06',
                idNumber: 'FISCAL1',
                name: customerName,
                email: null,
                address: null,
                phone: null,
              },
            ],
            page: 0,
            size: 20,
            total: 1,
          });
        if (path.endsWith('/products')) {
          if (req.method === 'POST') {
            const p = { ...JSON.parse(text), id: randomUUID() };
            products.push(p);
            return json(p, 201);
          }
          return json({ items: products, page: 0, size: 20, total: products.length });
        }
        if (path.endsWith('/invoices')) {
          const body = JSON.parse(text);
          const key = req.headers['idempotency-key'] as string;
          posts.push({ key, body });
          if (mode === '429') return json({ code: 'RATE_LIMITED' }, 429);
          if (mode === 'reserved') return json({ errorCode: 'IDEMPOTENCY_KEY_REUSED' }, 409);
          let d = [...docs.values()].find((d) => d.key === key);
          if (!d) {
            d = {
              id: randomUUID(),
              key,
              documentType: '01',
              state: 'RESERVED',
              environment: '1',
              taxpayerId: tid,
              number: '001-002-' + String(docs.size + 1).padStart(9, '0'),
              sequence: String(docs.size + 1).padStart(9, '0'),
              accessKey: '1'.repeat(49),
              issueDate: body.issueDate,
              currency: 'USD',
              customer: { idType: '06', idNumber: 'FISCAL1', name: 'Fiscal buyer' },
              subtotal: '40.00',
              totalDiscount: '0.00',
              taxes: [],
              totalTax: '0.00',
              total: '40.00',
              lines: [],
              payments: body.payments,
              authorizationNumber: null,
              authorizedAt: null,
              customerId,
              replacesDocumentId: body.replacesDocumentId ?? null,
              replacedByDocumentId: null,
            };
            docs.set(d.id, d);
          }
          if (mode === 'timeout') {
            req.socket.destroy();
            return;
          }
          if (invoiceGate) {
            const gate = invoiceGate;
            invoiceGate = null;
            gate.release = () =>
              json({ id: d.id, state: d.state, statusUrl: '/api/v1/documents/' + d.id }, 202);
            gate.entered();
            return;
          }
          return json({ id: d.id, state: d.state, statusUrl: '/api/v1/documents/' + d.id }, 202);
        }
        const id = path.split('/')[4];
        const d = docs.get(id);
        if (d && path.includes('/artifacts/')) {
          const bytes = Buffer.from(path.endsWith('/ride') ? '%PDF-test' : '<invoice/>');
          res.writeHead(200, {
            'content-type': path.endsWith('/ride') ? 'application/pdf' : 'application/xml',
            etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"',
          });
          return res.end(bytes);
        }
        if (d && path.endsWith('/sri-attempts'))
          return json([
            {
              id: randomUUID(),
              operation: 'RECEPTION',
              outcome: 'RETURNED',
              sriStatus: 'DEVUELTA',
              httpStatus: 200,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              messages: [
                {
                  identifier: '999',
                  message: 'EXPLICACION_FISCAL_REAL',
                  additionalInfo: null,
                  type: 'ERROR',
                },
              ],
            },
          ]);
        if (d) return json(d);
        return json({ code: 'NOT_FOUND' }, 404);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env.EMITE_FACIL_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/v1`;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.cleanDatabase();
    const t = await createTestTenant({ prisma, tenants: app.get(PlatformTenantsService) }, 901);
    tenantId = t.id;
    actorId = t.master!.id;
    branchId = (await prisma.branch.findFirst({ where: { tenantId } }))!.id;
    profileId = (
      await prisma.billingProfile.create({
        data: {
          tenantId,
          kind: 'PERSON',
          idType: '06',
          idNumber: 'FISCAL1',
          legalName: 'Fiscal buyer',
          createdById: actorId,
        },
      })
    ).id;
    await prisma.professionalProfile.create({
      data: {
        userId: actorId,
        specialtyId: (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } }))
          .id,
      },
    });
    await prisma.cashRegisterSession.create({
      data: { tenantId, branchId, openedById: actorId, openingCash: 0 },
    });
    token = (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email: 'admin+901@tenant.test', password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken;
  });
  afterAll(async () => {
    if (app) await app.close();
    if (upstream) await new Promise<void>((r) => upstream.close(() => r()));
  });
  it('requires configuration, tests an unsaved key, stores secrets encrypted and validates points', async () => {
    const o = await order();
    const blocked = await submit(o.id).expect(422);
    expect(blocked.body.missing).toContain('INVOICING_NOT_CONFIGURED');
    await request(server())
      .post(`${base()}/invoicing/test`)
      .set(auth())
      .send({ apiKey: 'test-key' })
      .expect(200);
    expect(await prisma.invoicingConnection.count()).toBe(0);
    const saved = await request(server())
      .put(`${base()}/invoicing/connection`)
      .set(auth())
      .send({ apiKey: 'test-key', taxpayerId: tid, webhookSecret: secret })
      .expect(200);
    connectionId = saved.body.id;
    expect(JSON.stringify(saved.body)).not.toContain('test-key');
    expect(saved.body.hasApiKey).toBe(true);
    expect(
      (await prisma.invoicingConnection.findUnique({ where: { id: connectionId } }))!
        .apiKeyEncrypted,
    ).toMatch(/^enc:v1:/);
    await request(server())
      .put(`${base()}/invoicing/connection`)
      .set(auth())
      .send({ taxpayerId: tid })
      .expect(200);
    await request(server())
      .put(`${base()}/branches/${branchId}/emission-point`)
      .set(auth())
      .send({ establishmentId: randomUUID(), emissionPointId: pid })
      .expect(422);
    await request(server())
      .put(`${base()}/branches/${branchId}/emission-point`)
      .set(auth())
      .send({ establishmentId: eid, emissionPointId: pid })
      .expect(200);
  });
  it('creates without HTTP, replays same key, blocks parallel requests and refunds', async () => {
    const o = await order();
    const key = randomUUID();
    const before = posts.length;
    const a = await submit(o.id, key).expect(202);
    expect(a.body.status).toBe('REQUESTED');
    expect(posts.length).toBe(before);
    expect((await submit(o.id, key).expect(202)).body.id).toBe(a.body.id);
    await submit((await order()).id, key).expect(409);
    await submit(o.id).expect(409);
    const payment = await prisma.payment.findFirst({ where: { orderId: o.id } });
    await request(server())
      .post(`${base()}/payments/${payment!.id}/refund`)
      .set(auth())
      .send({ reason: 'test refund' })
      .expect(409);
    expect((await prisma.order.findUnique({ where: { id: o.id } }))!.status).toBe('INVOICED');
  });
  it('persists exact body before POST; timeout retry ignores changed profile/catalog and blocks replacement', async () => {
    const o = await order();
    const a = (await submit(o.id).expect(202)).body;
    mode = 'timeout';
    await dispatch();
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.requiresReconciliation).toBe(true);
    expect(row.providerBodyEncrypted).toMatch(/^enc:v1:/);
    const original = posts.find((p) => p.key === row.providerIdempotencyKey)!;
    customerName = 'Changed upstream';
    mode = 'normal';
    await prisma.invoiceRequest.update({
      where: { id: a.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatch();
    expect(posts.filter((p) => p.key === row.providerIdempotencyKey).at(-1)).toEqual(original);
    await submit(o.id).expect(409);
    customerName = 'Fiscal buyer';
  });
  it('authorizes monotonically, deduplicates signed callbacks and stores hashed encrypted artifacts', async () => {
    mode = 'normal';
    await prisma.invoiceRequest.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await dispatch();
    const row = await prisma.invoiceRequest.findFirstOrThrow({
      where: { externalDocumentId: { not: null } },
    });
    const d = docs.get(row.externalDocumentId!);
    d.state = 'AUTHORIZED';
    d.authorizationNumber = '2'.repeat(49);
    d.authorizedAt = new Date().toISOString();
    const event = {
      eventId: randomUUID(),
      eventType: 'document.authorized',
      occurredAt: new Date().toISOString(),
      tenantId: tid,
      document: d,
    };
    const raw = JSON.stringify(event);
    const stamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.alloc(32, 3))
      .update(`${event.eventId}.${stamp}.${raw}`)
      .digest('base64');
    const hook = () =>
      request(server())
        .post(`/api/v1/integrations/emite-facil/webhook/${connectionId}`)
        .set({
          'content-type': 'application/json',
          'webhook-id': event.eventId,
          'webhook-timestamp': stamp,
          'webhook-signature': 'v1,' + sig,
        })
        .send(raw);
    await hook().expect(204);
    await hook().expect(204);
    expect(
      await prisma.invoiceRequestEvent.count({ where: { webhookEventId: event.eventId } }),
    ).toBe(1);
    await reconcile();
    const result = await request(server())
      .get(`${base()}/invoice-requests/${row.id}`)
      .set(auth())
      .expect(200);
    expect(result.body.status).toBe('AUTHORIZED');
    expect(result.body.artifacts.xml).toBe(true);
    const lateEvent = {
      ...event,
      eventId: randomUUID(),
      eventType: 'document.returned',
      document: { ...d, state: 'RETURNED' },
    };
    const lateRaw = JSON.stringify(lateEvent);
    const lateSignature = createHmac('sha256', Buffer.alloc(32, 3))
      .update(`${lateEvent.eventId}.${stamp}.${lateRaw}`)
      .digest('base64');
    await request(server())
      .post(`/api/v1/integrations/emite-facil/webhook/${connectionId}`)
      .set({
        'content-type': 'application/json',
        'webhook-id': lateEvent.eventId,
        'webhook-timestamp': stamp,
        'webhook-signature': 'v1,' + lateSignature,
      })
      .send(lateRaw)
      .expect(204);
    expect((await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'AUTHORIZED',
    );
    await request(server()).get(`${base()}/invoice-requests/${row.id}/xml`).set(auth()).expect(200);
    await request(server())
      .get(`${base()}/invoice-requests/${row.id}/ride`)
      .set(auth())
      .expect(200);
    await submit(row.orderId).expect(409);
  });
  it('treats signature failure as recoverable and locks refunds until the SAME document authorizes', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    await dispatch();
    let row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    const doc = docs.get(row.externalDocumentId!);
    doc.state = 'SIGNATURE_FAILED';
    await reconcile();
    row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.lastErrorEncrypted).toMatch(/^enc:v1:/);
    await submit(o.id).expect(409);
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id } });
    await request(server())
      .post(`${base()}/payments/${pay.id}/refund`)
      .set(auth())
      .send({ reason: 'blocked refund' })
      .expect(409);
    doc.state = 'SIGNED';
    await reconcile();
    expect((await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'PROCESSING',
    );
    doc.state = 'AUTHORIZED';
    doc.authorizationNumber = '3'.repeat(49);
    doc.authorizedAt = new Date().toISOString();
    await reconcile();
    expect((await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'AUTHORIZED',
    );
  });
  it('releases safe rejections without changing payments and links the replacement', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    await dispatch();
    let row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    docs.get(row.externalDocumentId!).state = 'RETURNED';
    const before = await prisma.payment.findMany({ where: { orderId: o.id } });
    await reconcile();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PAID');
    expect(await prisma.payment.findMany({ where: { orderId: o.id } })).toEqual(before);
    const rejection = (
      await request(server()).get(`${base()}/invoice-requests/${r.id}`).set(auth()).expect(200)
    ).body;
    expect(rejection.lastError.attempts[0].messages[0].message).toBe('EXPLICACION_FISCAL_REAL');
    expect(JSON.stringify(rejection.events)).not.toContain('EXPLICACION_FISCAL_REAL');
    const replacement = (await submit(o.id).expect(202)).body;
    expect(replacement.replacesInvoiceRequestId).toBe(r.id);
    await dispatch();
    const latest = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(
      posts.find((p) => p.key === latest.providerIdempotencyKey)!.body.replacesDocumentId,
    ).toBe(row.externalDocumentId);
  });
  it('fails changed fiscal customers safely before invoice POST and permits correction', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    customerName = 'Other name';
    const count = posts.length;
    await dispatch();
    customerName = 'Fiscal buyer';
    const result = (
      await request(server()).get(`${base()}/invoice-requests/${r.id}`).set(auth()).expect(200)
    ).body;
    expect(result.status).toBe('FAILED');
    expect(result.lastError.code).toBe('CUSTOMER_SYNC_REQUIRED');
    expect(result.requiresReconciliation).toBe(false);
    expect(posts.length).toBe(count);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PAID');
  });
  it('keeps SRI explanations behind billing.view when a create-only assistant replays a rejected request', async () => {
    await app.get(UsersService).create(
      {
        tenantId,
        email: 'b2-create-only@tenant.test',
        password: TEST_PASSWORD,
        firstName: 'Assistant',
        lastName: 'Billing',
        role: 'ASISTENTE',
      },
      actorId,
    );
    await prisma.tenantRolePermission.create({
      data: { tenantId, role: 'ASISTENTE', permission: 'billing.create', granted: true },
    });
    const assistantToken = (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email: 'b2-create-only@tenant.test', password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken;
    const asAssistant = { Authorization: `Bearer ${assistantToken}` };
    const o = await order();
    const key = randomUUID();
    const post = () =>
      request(server())
        .post(`${base()}/orders/${o.id}/invoice-requests`)
        .set(asAssistant)
        .set('Idempotency-Key', key);
    const accepted = (await post().expect(202)).body;
    expect(accepted.lastError).toBeNull();
    await dispatch();
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: accepted.id } });
    docs.get(row.externalDocumentId!).state = 'RETURNED';
    await reconcile();
    await request(server())
      .get(`${base()}/invoice-requests/${row.id}`)
      .set(asAssistant)
      .expect(403);
    await request(server()).get(`${base()}/invoice-requests`).set(asAssistant).expect(403);
    const replay = (await post().expect(202)).body;
    expect(replay.status).toBe('REJECTED');
    expect(replay.lastError).toBeNull();
    expect(JSON.stringify(replay)).not.toContain('EXPLICACION_FISCAL_REAL');
    const detail = (
      await request(server()).get(`${base()}/invoice-requests/${row.id}`).set(auth()).expect(200)
    ).body;
    expect(detail.lastError.attempts[0].messages[0].message).toBe('EXPLICACION_FISCAL_REAL');
  });
  it('preserves the rejected provider document across a safe preflight failure in its replacement chain', async () => {
    const o = await order();
    const original = (await submit(o.id).expect(202)).body;
    await dispatch();
    const initial = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: original.id } });
    docs.get(initial.externalDocumentId!).state = 'RETURNED';
    await reconcile();
    const failed = (await submit(o.id).expect(202)).body;
    customerName = 'Outdated';
    await dispatch();
    customerName = 'Fiscal buyer';
    expect(
      (await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: failed.id } })).status,
    ).toBe('FAILED');
    const replacement = (await submit(o.id).expect(202)).body;
    await dispatch();
    const latest = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(
      posts.find((p) => p.key === latest.providerIdempotencyKey)!.body.replacesDocumentId,
    ).toBe(initial.externalDocumentId);
  });
  it('reclaims expired leases and ignores stale workers before POST and CAS writes', async () => {
    const { InvoiceWorkerService } = await import('../src/invoicing/invoice-worker.service');
    const worker = app.get(InvoiceWorkerService);
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    const claimed = (await worker.claim()).find((x) => x.id === r.id)!;
    expect(claimed).toBeDefined();
    await prisma.invoiceRequest.update({ where: { id: r.id }, data: { leaseUntil: new Date(0) } });
    const newer = (await worker.claim()).find((x) => x.id === r.id)!;
    expect(newer.leaseToken).not.toBe(claimed.leaseToken);
    const count = posts.length;
    await worker.process(claimed);
    expect(posts.length).toBe(count);
    expect(
      (await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).leaseToken,
    ).toBe(newer.leaseToken);
    await worker.process(newer);
    expect((await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'PROCESSING',
    );
  });
  it('retains uncertainty across 24h expiry and later configuration failure', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    mode = 'timeout';
    await dispatch();
    mode = 'normal';
    await prisma.invoiceRequest.update({
      where: { id: r.id },
      data: { requestedAt: new Date(Date.now() - 90000000), nextAttemptAt: new Date(0) },
    });
    taxpayer.defaultEnvironment = '2';
    await dispatch();
    taxpayer.defaultEnvironment = '1';
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('FAILED');
    expect(row.requiresReconciliation).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('INVOICED');
    await submit(o.id).expect(409);
    await prisma.invoiceRequest.update({
      where: { id: r.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatch();
    expect((await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'PROCESSING',
    );
  });
  it('ignores a late POST response after lease takeover and recovers the same body and key', async () => {
    const { InvoiceWorkerService } = await import('../src/invoicing/invoice-worker.service');
    const worker = app.get(InvoiceWorkerService);
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    const claimed = (await worker.claim()).find((x) => x.id === r.id)!;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = { entered, release: undefined as (() => void) | undefined };
    invoiceGate = gate;
    const pending = worker.process(claimed);
    await reached;
    await prisma.invoiceRequest.update({ where: { id: r.id }, data: { leaseUntil: new Date(0) } });
    const newer = (await worker.claim()).find((x) => x.id === r.id)!;
    expect(newer.requiresReconciliation).toBe(true);
    gate.release!();
    await pending;
    const after = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.externalDocumentId).toBeNull();
    expect(after.requiresReconciliation).toBe(true);
    expect(after.leaseToken).toBe(newer.leaseToken);
    await worker.process(newer);
    const recovered = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(recovered.externalDocumentId).not.toBeNull();
    const replays = posts.filter((p) => p.key === claimed.providerIdempotencyKey);
    expect(replays).toHaveLength(2);
    expect(replays[0]).toEqual(replays[1]);
  });
  it('keeps 429 retries durable and respects a future retry time', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    mode = '429';
    await dispatch();
    mode = 'normal';
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.requiresReconciliation).toBe(true);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20000);
    const count = posts.length;
    await dispatch();
    expect(posts.length).toBe(count);
  });
  it('never releases a provider-reserved idempotency key without a known document', async () => {
    const o = await order();
    const r = (await submit(o.id).expect(202)).body;
    mode = 'reserved';
    await dispatch();
    mode = 'normal';
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.externalDocumentId).toBeNull();
    expect(row.requiresReconciliation).toBe(true);
    expect(row.lastErrorEncrypted).toMatch(/^enc:v1:/);
    await submit(o.id).expect(409);
    await prisma.invoiceRequest.update({
      where: { id: r.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatch();
    const recovered = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(recovered.externalDocumentId).not.toBeNull();
    expect(posts.filter((p) => p.key === row.providerIdempotencyKey)).toHaveLength(2);
  });
  it('reuses one product for two sessions of the same pinned treatment version and sends no clinical data', async () => {
    const t = await treatment();
    const version = t.versions[0].id;
    const one = await sessionOrder(version);
    const two = await sessionOrder(version);
    const before = products.length;
    const a = (await submit(one.order.id).expect(202)).body;
    const b = (await submit(two.order.id).expect(202)).body;
    await dispatch();
    expect(products.length - before).toBe(1);
    const rows = await prisma.invoiceRequest.findMany({ where: { id: { in: [a.id, b.id] } } });
    const bodies = rows.map((r) => posts.find((p) => p.key === r.providerIdempotencyKey)!.body);
    expect(bodies[0].lines[0].productId).toBe(bodies[1].lines[0].productId);
    const { ClinicalCryptoService } =
      await import('../src/clinical-access/clinical-crypto.service');
    const crypto = app.get(ClinicalCryptoService);
    for (const r of rows) {
      const fiscal = crypto.decrypt(tenantId, r.snapshotEncrypted);
      expect(JSON.parse(fiscal).lines[0].localId).toBe(version);
      expect(fiscal).not.toContain('PRIVATE_');
    }
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_');
    expect(
      (await prisma.treatmentSession.findUniqueOrThrow({ where: { id: one.session.id } })).status,
    ).toBe('BILLING_PENDING');
  });
  it('allows clinical completion after early authorization and preserves payment records', async () => {
    const t = await treatment(true);
    const fixture = await sessionOrder(t.versions[0].id, false);
    const payments = await prisma.payment.findMany({ where: { orderId: fixture.order.id } });
    const r = (await submit(fixture.order.id).expect(202)).body;
    expect(
      (await prisma.treatmentSession.findUniqueOrThrow({ where: { id: fixture.session.id } }))
        .status,
    ).toBe('IN_PROGRESS');
    await dispatch();
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } });
    const d = docs.get(row.externalDocumentId!);
    d.state = 'AUTHORIZED';
    d.authorizationNumber = '4'.repeat(49);
    d.authorizedAt = new Date().toISOString();
    await reconcile();
    expect(
      (await prisma.treatmentSession.findUniqueOrThrow({ where: { id: fixture.session.id } }))
        .status,
    ).toBe('IN_PROGRESS');
    await request(server())
      .post(`${base()}/treatment-sessions/${fixture.session.id}/complete`)
      .set(auth())
      .send({ procedureNotes: 'Completed private care' })
      .expect(201);
    expect(
      (await prisma.treatmentSession.findUniqueOrThrow({ where: { id: fixture.session.id } }))
        .status,
    ).toBe('BILLED');
    expect(await prisma.payment.findMany({ where: { orderId: fixture.order.id } })).toEqual(
      payments,
    );
  });
  it.each([
    ['AUTHORIZED', 'BILLED'],
    ['REJECTED', 'CLINICAL_COMPLETE'],
    ['FAILED', 'CLINICAL_COMPLETE'],
  ])(
    'serializes early invoice %s committed after the clinical invoice read',
    async (outcome, expectedStatus) => {
      const fixture = await concurrentCompletionFixture(outcome);
      const { receipt, finalize } = fixture;

      let reached!: () => void;
      const invoiceRead = new Promise<void>((resolve) => (reached = resolve));
      let release!: () => void;
      const resumeCompletion = new Promise<void>((resolve) => (release = resolve));
      let pause = true;
      const transaction = prisma.$transaction.bind(prisma);
      // Keep every query and transaction real; pause only after the first invoice read.
      const transactionSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((
        operation: any,
        options: any,
      ) => {
        if (options?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable)
          return transaction(operation, options);
        return transaction(async (tx) => {
          const invoiceRequest = new Proxy(tx.invoiceRequest, {
            get(target, property) {
              if (property !== 'findFirst') return Reflect.get(target, property);
              return async (args: Prisma.InvoiceRequestFindFirstArgs) => {
                const row = await target.findFirst(args);
                if (pause && row?.id === receipt.id) {
                  pause = false;
                  reached();
                  await resumeCompletion;
                }
                return row;
              };
            },
          });
          return operation(
            new Proxy(tx, {
              get(target, property) {
                return property === 'invoiceRequest'
                  ? invoiceRequest
                  : Reflect.get(target, property);
              },
            }),
          );
        }, options);
      }) as typeof prisma.$transaction);
      const completion = request(server())
        .post(`${base()}/treatment-sessions/${fixture.session.id}/complete`)
        .set(auth())
        .send({ procedureNotes: 'Completed concurrent care' })
        .then((response) => response);
      try {
        await invoiceRead;
        await finalize();
        expect(
          (await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: receipt.id } })).status,
        ).toBe(outcome);
        expect(
          (await prisma.treatmentSession.findUniqueOrThrow({ where: { id: fixture.session.id } }))
            .completedAt,
        ).toBeNull();
      } finally {
        release();
        transactionSpy.mockRestore();
        await completion;
      }
      expect((await completion).status).toBe(201);
      const completed = await prisma.treatmentSession.findUniqueOrThrow({
        where: { id: fixture.session.id },
      });
      expect(completed.completedAt).not.toBeNull();
      expect(completed.status).toBe(expectedStatus);
    },
  );
  it.each([
    ['AUTHORIZED', 'BILLED'],
    ['REJECTED', 'BILLING_FAILED'],
    ['FAILED', 'BILLING_FAILED'],
  ])(
    'waits for clinical completion holding the invoice lock before applying %s',
    async (outcome, expectedStatus) => {
      const fixture = await concurrentCompletionFixture(outcome);
      const sessions = app.get(TreatmentSessionsService);
      const transition = sessions.transition.bind(sessions);
      let reached!: (pid: number) => void;
      const beforeTransition = new Promise<number>((resolve) => (reached = resolve));
      let release!: () => void;
      const resumeCompletion = new Promise<void>((resolve) => (release = resolve));
      const transitionSpy = jest
        .spyOn(sessions, 'transition')
        .mockImplementation(async (tx, session, data) => {
          if (session.id === fixture.session.id) {
            const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            reached(pid);
            await resumeCompletion;
          }
          return transition(tx, session, data);
        });
      const completion = request(server())
        .post(`${base()}/treatment-sessions/${fixture.session.id}/complete`)
        .set(auth())
        .send({ procedureNotes: 'Completed while fiscal worker waits' })
        .then((response) => response);
      let finalization: Promise<void> | undefined;
      try {
        const completionPid = await beforeTransition;
        finalization = fixture.finalize();
        // Observe an actual PostgreSQL lock wait, rather than assuming one after a delay.
        const deadline = Date.now() + 2000;
        let waiting = false;
        do {
          [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE ${completionPid} = ANY(pg_blocking_pids(pid))
            ) AS waiting`;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        } while (!waiting && Date.now() < deadline);
        expect(waiting).toBe(true);
      } finally {
        release();
        transitionSpy.mockRestore();
        await Promise.all([completion, finalization]);
      }
      expect((await completion).status).toBe(201);
      const completed = await prisma.treatmentSession.findUniqueOrThrow({
        where: { id: fixture.session.id },
      });
      expect(completed.completedAt).not.toBeNull();
      expect(completed.status).toBe(expectedStatus);
      expect(
        (await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: fixture.receipt.id } }))
          .status,
      ).toBe(outcome);
    },
  );
  it('serializes concurrent identical submissions into one request', async () => {
    const o = await order();
    const key = randomUUID();
    const [a, b] = await Promise.all([submit(o.id, key), submit(o.id, key)]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.invoiceRequest.count({ where: { orderId: o.id } })).toBe(1);
  });
  it('enforces monthly capacity, tenant isolation and signed webhook isolation', async () => {
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { monthlyElectronicInvoicesLimit: 0 },
    });
    expect((await submit((await order()).id).expect(409)).body.code).toBe('INVOICE_LIMIT_REACHED');
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { monthlyElectronicInvoicesLimit: 50 },
    });
    const foreign = await createTestTenant(
      { prisma, tenants: app.get(PlatformTenantsService) },
      902,
    );
    const row = await prisma.invoiceRequest.findFirstOrThrow();
    await request(server())
      .get(`/api/v1/tenants/${foreign.id}/invoice-requests/${row.id}`)
      .set(auth())
      .expect(403);
    await request(server())
      .post(`/api/v1/integrations/emite-facil/webhook/${connectionId}`)
      .send({})
      .expect(401);
    const e = {
      eventId: randomUUID(),
      tenantId: randomUUID(),
      eventType: 'document.authorized',
      document: { id: row.externalDocumentId },
    };
    const raw = JSON.stringify(e);
    const stamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.alloc(32, 3))
      .update(`${e.eventId}.${stamp}.${raw}`)
      .digest('base64');
    await request(server())
      .post(`/api/v1/integrations/emite-facil/webhook/${connectionId}`)
      .set({
        'content-type': 'application/json',
        'webhook-id': e.eventId,
        'webhook-timestamp': stamp,
        'webhook-signature': 'v1,' + sig,
      })
      .send(raw)
      .expect(401);
  });
});
