import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-invoicing-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlatformTenantsService } from '../src/platform/platform-tenants.service';
import { UsersService } from '../src/users/users.service';
import { createTestP12 } from '../src/invoicing/sri/testing/test-certificate';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';
import { SIMULATED_SRI_MESSAGE, SriSimulator, startSriSimulator } from './helpers/sri-simulator';

jest.setTimeout(120000);

const TICK_SECRET = 'e2e-secret';
const CERTIFICATE_PASSWORD = 'clave-prueba';
const ISSUER = {
  ruc: '1790012345001',
  legalName: 'Consultorio Emisor de Prueba',
  tradeName: 'Consultorio Prueba',
  headOfficeAddress: 'Av. Amazonas N1-23, Quito',
  accountingRequired: false,
  rimpeRegime: 'NONE',
  environment: '1',
};

describe('invoicing against a simulated SRI', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sri: SriSimulator;
  let tenantId: string;
  let actorId: string;
  let branchId: string;
  let registerId: string;
  /** Customer with an e-mail address: the authorized invoice is mailed to it. */
  let mailedProfileId: string;
  /** Customer without an e-mail address: the e-mail step is skipped. */
  let profileId: string;
  let token: string;
  let foreignTenantId: string;
  let foreignToken: string;
  let assistantToken: string;
  let orderNumber = 0;

  const server = () => app.getHttpServer();
  const base = () => `/api/v1/tenants/${tenantId}`;
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function login(email: string) {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function paidOrder(total = 40, billingProfileId = profileId) {
    const order = await prisma.order.create({
      data: {
        tenantId,
        branchId,
        number: ++orderNumber,
        status: 'PAID',
        billingProfileId,
        createdById: actorId,
        subtotal: total,
        total,
        paidTotal: total,
        items: {
          create: {
            tenantId,
            kind: 'FREE',
            description: 'Consulta psicológica',
            quantity: 1,
            unitPrice: total,
            taxRatePercent: 0,
            lineSubtotal: total,
            lineTax: 0,
            createdById: actorId,
          },
        },
      },
    });
    await prisma.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        cashRegisterSessionId: registerId,
        method: 'CASH',
        amount: total,
        receivedById: actorId,
      },
    });
    return order;
  }

  const submit = (orderId: string, key: string = randomUUID(), t = token) =>
    request(server())
      .post(`${base()}/orders/${orderId}/invoice-requests`)
      .set(auth(t))
      .set('Idempotency-Key', key);

  /** Downloads an artifact as raw bytes. */
  const download = (id: string, kind: 'xml' | 'ride') =>
    request(server())
      .get(`${base()}/invoice-requests/${id}/${kind}`)
      .set(auth())
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

  async function detail(id: string) {
    return (await request(server()).get(`${base()}/invoice-requests/${id}`).set(auth()).expect(200))
      .body;
  }

  /** Makes the given requests due and runs one scheduler tick through HTTP. */
  async function tick(...ids: string[]) {
    await prisma.invoiceRequest.updateMany({
      where: { id: { in: ids } },
      data: { nextAttemptAt: new Date(0) },
    });
    return request(server())
      .post('/api/v1/internal/invoicing/tick')
      .set('Authorization', `Bearer ${TICK_SECRET}`)
      .expect(200);
  }

  async function orderStatus(id: string) {
    return (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
  }

  beforeAll(async () => {
    sri = await startSriSimulator();
    process.env.SRI_TEST_BASE_URL = sri.baseUrl;
    process.env.INVOICING_TICK_SECRET = TICK_SECRET;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.cleanDatabase();

    const tenants = app.get(PlatformTenantsService);
    const tenant = await createTestTenant({ prisma, tenants }, 901);
    tenantId = tenant.id;
    actorId = tenant.master!.id;
    branchId = (await prisma.branch.findFirstOrThrow({ where: { tenantId } })).id;
    registerId = (
      await prisma.cashRegisterSession.create({
        data: { tenantId, branchId, openedById: actorId, openingCash: 0 },
      })
    ).id;
    profileId = (
      await prisma.billingProfile.create({
        data: {
          tenantId,
          kind: 'PERSON',
          idType: '06',
          idNumber: 'PAS-FISCAL-1',
          legalName: 'Cliente Fiscal',
          createdById: actorId,
        },
      })
    ).id;
    mailedProfileId = (
      await prisma.billingProfile.create({
        data: {
          tenantId,
          kind: 'PERSON',
          idType: '06',
          idNumber: 'PAS-FISCAL-2',
          legalName: 'Cliente Con Correo',
          email: 'cliente@tenant.test',
          createdById: actorId,
        },
      })
    ).id;
    token = await login('admin+901@tenant.test');

    foreignTenantId = (await createTestTenant({ prisma, tenants }, 902)).id;
    foreignToken = await login('admin+902@tenant.test');

    await app.get(UsersService).create(
      {
        tenantId,
        email: 'invoicing-assistant@tenant.test',
        password: TEST_PASSWORD,
        firstName: 'Asistente',
        lastName: 'Caja',
        role: 'ASISTENTE',
      },
      actorId,
    );
    assistantToken = await login('invoicing-assistant@tenant.test');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (sri) await sri.close();
  });

  beforeEach(() => sri.mode('authorize'));

  it('requires issuer, certificate and point before invoicing', async () => {
    const order = await paidOrder();
    const blocked = await submit(order.id).expect(422);
    expect(blocked.body.missing).toContain('INVOICING_NOT_CONFIGURED');

    const issuer = await request(server())
      .put(`${base()}/invoicing/issuer`)
      .set(auth())
      .send(ISSUER)
      .expect(200);
    expect(issuer.body.ruc).toBe(ISSUER.ruc);
    expect(issuer.body.certificate).toBeNull();
    // Without a certificate the issuer still cannot invoice.
    expect((await submit(order.id).expect(422)).body.missing).toContain('INVOICING_NOT_CONFIGURED');

    await request(server())
      .put(`${base()}/invoicing/issuer/certificate`)
      .set(auth())
      .attach('file', Buffer.alloc(51 * 1024, 1), 'grande.p12')
      .field('password', CERTIFICATE_PASSWORD)
      .expect(413);
    const certificate = await request(server())
      .put(`${base()}/invoicing/issuer/certificate`)
      .set(auth())
      .attach('file', createTestP12({ password: CERTIFICATE_PASSWORD }), 'firma.p12')
      .field('password', CERTIFICATE_PASSWORD)
      .expect(200);
    expect(certificate.body.certificate.rucVerified).toBe(true);
    expect(JSON.stringify(certificate.body)).not.toContain(CERTIFICATE_PASSWORD);
    const stored = await prisma.invoicingIssuer.findUniqueOrThrow({ where: { tenantId } });
    expect(stored.certificatePasswordEncrypted).not.toContain(CERTIFICATE_PASSWORD);
    // Still no emission point for the branch.
    expect((await submit(order.id).expect(422)).body.missing).toContain('INVOICING_NOT_CONFIGURED');

    const point = await request(server())
      .put(`${base()}/branches/${branchId}/emission-point`)
      .set(auth())
      .send({
        establishmentCode: '001',
        emissionPointCode: '002',
        establishmentAddress: 'Av. Amazonas N1-23, Quito',
        nextSequential: 500,
      })
      .expect(200);
    expect(point.body).toMatchObject({ establishmentCode: '001', nextSequential: 500 });

    const check = await request(server()).post(`${base()}/invoicing/test`).set(auth()).expect(200);
    expect(check.body).toEqual({
      certificateValid: true,
      certificateError: null,
      rucVerified: true,
      sriReachable: true,
    });
    sri.mode('down');
    expect(
      (await request(server()).post(`${base()}/invoicing/test`).set(auth()).expect(200)).body
        .sriReachable,
    ).toBe(false);

    // The refused attempts created nothing and left the order invoiceable.
    expect(await prisma.invoiceRequest.count({ where: { orderId: order.id } })).toBe(0);
    expect(await orderStatus(order.id)).toBe('PAID');
  });

  it('authorizes inline and serves XML and RIDE', async () => {
    const order = await paidOrder(40, mailedProfileId);
    const result = (await submit(order.id).expect(202)).body;
    expect(result.status).toBe('AUTHORIZED');
    expect(result.number).toBe('001-002-000000500');
    expect(result.accessKey).toMatch(/^\d{49}$/);
    expect(result.authorizationNumber).toBe(result.accessKey);
    expect(result.artifacts).toEqual({ xml: true, ride: true });
    expect(await orderStatus(order.id)).toBe('INVOICED');
    expect(sri.received.filter((r) => r.accessKey === result.accessKey)).toHaveLength(1);

    const xml = await download(result.id, 'xml');
    expect(xml.headers['content-type']).toContain('application/xml');
    const text = (xml.body as Buffer).toString('utf8');
    expect(text).toContain('<estado>AUTORIZADO</estado>');
    expect(text).toContain(`<claveAcceso>${result.accessKey}</claveAcceso>`);
    const ride = await download(result.id, 'ride');
    expect(ride.headers['content-type']).toContain('application/pdf');
    expect((ride.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // No mail provider runs in the e2e (setup-e2e.ts), so the send is refused and recorded.
    const types = (await detail(result.id)).events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['REQUESTED', 'SIGNED', 'AUTHORIZED']));
    expect(types.some((t: string) => t === 'EMAILED' || t === 'EMAIL_FAILED')).toBe(true);
    await submit(order.id).expect(409);
  });

  it('keeps the issuer and invoice requests inside their tenant and role', async () => {
    const row = await prisma.invoiceRequest.findFirstOrThrow({
      where: { tenantId, status: 'AUTHORIZED' },
    });
    const foreign = `/api/v1/tenants/${foreignTenantId}`;
    await request(server()).get(`${foreign}/invoicing/issuer`).set(auth()).expect(403);
    await request(server()).put(`${foreign}/invoicing/issuer`).set(auth()).send(ISSUER).expect(403);
    await request(server()).get(`${base()}/invoicing/issuer`).set(auth(foreignToken)).expect(403);
    await request(server())
      .get(`${base()}/invoice-requests/${row.id}`)
      .set(auth(foreignToken))
      .expect(403);
    // Through its own tenant, the other clinic cannot reach this clinic's request either.
    await request(server())
      .get(`${foreign}/invoice-requests/${row.id}`)
      .set(auth(foreignToken))
      .expect(404);
    await request(server())
      .get(`${foreign}/invoice-requests/${row.id}/xml`)
      .set(auth(foreignToken))
      .expect(404);
    const foreignIssuer = await request(server())
      .get(`${foreign}/invoicing/issuer`)
      .set(auth(foreignToken))
      .expect(200);
    expect(foreignIssuer.body).not.toHaveProperty('ruc');

    // Only the MASTER configures the issuer.
    await request(server())
      .put(`${base()}/invoicing/issuer`)
      .set(auth(assistantToken))
      .send(ISSUER)
      .expect(403);
    await request(server())
      .put(`${base()}/invoicing/issuer/certificate`)
      .set(auth(assistantToken))
      .attach('file', createTestP12({ password: CERTIFICATE_PASSWORD }), 'firma.p12')
      .field('password', CERTIFICATE_PASSWORD)
      .expect(403);
    expect(
      (await prisma.invoicingIssuer.findUniqueOrThrow({ where: { tenantId } })).legalName,
    ).toBe(ISSUER.legalName);
  });

  it('guards the scheduler tick with its secret', async () => {
    const tickRoute = '/api/v1/internal/invoicing/tick';
    delete process.env.INVOICING_TICK_SECRET;
    try {
      await request(server())
        .post(tickRoute)
        .set('Authorization', `Bearer ${TICK_SECRET}`)
        .expect(404);
    } finally {
      process.env.INVOICING_TICK_SECRET = TICK_SECRET;
    }
    await request(server()).post(tickRoute).set('Authorization', 'Bearer wrong-secret').expect(401);
    await request(server()).post(tickRoute).expect(401);
    await request(server()).post(tickRoute).set(auth()).expect(401);
    const ok = await request(server())
      .post(tickRoute)
      .set('Authorization', `Bearer ${TICK_SECRET}`)
      .expect(200);
    expect(ok.body).toEqual({ processed: expect.any(Number) });
  });

  it('leaves PENDING inline and authorizes from the tick', async () => {
    sri.mode('pending');
    const order = await paidOrder();
    const pending = (await submit(order.id).expect(202)).body;
    expect(pending.status).toBe('PROCESSING');
    expect(pending.externalState).toBe('RECEIVED');
    expect(pending.number).toBe('001-002-000000501');

    sri.mode('authorize');
    await tick(pending.id);
    const done = await detail(pending.id);
    expect(done.status).toBe('AUTHORIZED');
    expect(done.accessKey).toBe(pending.accessKey);
    expect(done.authorizationNumber).toBe(pending.accessKey);
    expect(done.artifacts).toEqual({ xml: true, ride: true });
    // This customer has no e-mail address.
    expect(done.events.map((e: { type: string }) => e.type)).toContain('EMAIL_SKIPPED');
    expect(sri.received.filter((r) => r.accessKey === pending.accessKey)).toHaveLength(1);
  });

  it('recovers a reception timeout through the access key', async () => {
    const before = sri.received.length;
    sri.mode('reception-timeout');
    const order = await paidOrder();
    const uncertain = (await submit(order.id).expect(202)).body;
    expect(uncertain.status).toBe('PROCESSING');
    expect(uncertain.lastError.code).toBe('SRI_TIMEOUT');
    expect(await orderStatus(order.id)).toBe('INVOICED');

    sri.mode('authorize');
    await tick(uncertain.id);
    const done = await detail(uncertain.id);
    expect(done.status).toBe('AUTHORIZED');
    expect(done.accessKey).toBe(uncertain.accessKey);
    expect(done.sequential).toBe(uncertain.sequential);
    // The voucher reached the SRI once; the tick found it by its key instead of sending another.
    const arrived = sri.received.slice(before);
    expect(arrived).toHaveLength(1);
    expect(arrived[0].accessKey).toBe(uncertain.accessKey);
  });

  it('rejects, releases the order and reissues with a new sequential', async () => {
    const order = await paidOrder();
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    sri.mode('return');
    const rejected = (await submit(order.id).expect(202)).body;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.lastError.code).toBe('SRI_REJECTED');
    expect(rejected.lastError.messages[0].message).toBe(SIMULATED_SRI_MESSAGE);
    expect(JSON.stringify(rejected.events)).not.toContain(SIMULATED_SRI_MESSAGE);
    expect(await orderStatus(order.id)).toBe('PAID');
    expect(await prisma.payment.findMany({ where: { orderId: order.id } })).toEqual(payments);

    sri.mode('authorize');
    const reissued = (await submit(order.id).expect(202)).body;
    expect(reissued.status).toBe('AUTHORIZED');
    expect(reissued.replacesInvoiceRequestId).toBe(rejected.id);
    expect(Number(reissued.sequential)).toBeGreaterThan(Number(rejected.sequential));
    expect(reissued.accessKey).not.toBe(rejected.accessKey);
    expect(await orderStatus(order.id)).toBe('INVOICED');
  });

  it('gives distinct sequentials to concurrent invoices of one point', async () => {
    const [a, b] = await Promise.all([paidOrder(), paidOrder()]);
    const results = await Promise.all([submit(a.id), submit(b.id)]);
    const bodies = results.map((r) => {
      expect(r.status).toBe(202);
      expect(r.body.status).toBe('AUTHORIZED');
      return r.body;
    });
    const sequentials = bodies.map((r) => Number(r.sequential)).sort((x, y) => x - y);
    expect(sequentials[1]).toBe(sequentials[0] + 1);
    expect(new Set(bodies.map((r) => r.accessKey)).size).toBe(2);
  });

  it('keeps SRI messages behind billing.view', async () => {
    await prisma.tenantRolePermission.create({
      data: { tenantId, role: 'ASISTENTE', permission: 'billing.create', granted: true },
    });
    const order = await paidOrder();
    const key = randomUUID();
    sri.mode('not-authorized');
    const accepted = (await submit(order.id, key, assistantToken).expect(202)).body;
    expect(accepted.status).toBe('REJECTED');
    expect(accepted.lastError).toBeNull();
    expect(JSON.stringify(accepted)).not.toContain(SIMULATED_SRI_MESSAGE);
    await request(server())
      .get(`${base()}/invoice-requests/${accepted.id}`)
      .set(auth(assistantToken))
      .expect(403);
    await request(server()).get(`${base()}/invoice-requests`).set(auth(assistantToken)).expect(403);
    const replay = (await submit(order.id, key, assistantToken).expect(202)).body;
    expect(replay.id).toBe(accepted.id);
    expect(replay.status).toBe('REJECTED');
    expect(replay.lastError).toBeNull();
    expect(JSON.stringify(replay)).not.toContain(SIMULATED_SRI_MESSAGE);
    const full = await detail(accepted.id);
    expect(full.lastError.messages[0].message).toBe(SIMULATED_SRI_MESSAGE);
  });

  it('blocks refunds while an invoice is PROCESSING', async () => {
    sri.mode('pending');
    const order = await paidOrder();
    const pending = (await submit(order.id).expect(202)).body;
    expect(pending.status).toBe('PROCESSING');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const refused = await request(server())
      .post(`${base()}/payments/${payment.id}/refund`)
      .set(auth())
      .send({ reason: 'Devolución de prueba' })
      .expect(409);
    expect(refused.body.code).toBe('PAYMENT_NOT_REFUNDABLE');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'RECORDED',
    );
    expect(await orderStatus(order.id)).toBe('INVOICED');

    // Settle it so later ticks find nothing pending.
    sri.mode('authorize');
    await tick(pending.id);
    expect((await detail(pending.id)).status).toBe('AUTHORIZED');
  });

  it('enforces the monthly limit', async () => {
    const subscription = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    const used = await prisma.invoiceRequest.count({
      where: { tenantId, status: { in: ['REQUESTED', 'PROCESSING', 'AUTHORIZED'] } },
    });
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { monthlyElectronicInvoicesLimit: used },
    });
    try {
      const order = await paidOrder();
      const refused = await submit(order.id).expect(409);
      expect(refused.body.code).toBe('INVOICE_LIMIT_REACHED');
      expect(await prisma.invoiceRequest.count({ where: { orderId: order.id } })).toBe(0);
      expect(await orderStatus(order.id)).toBe('PAID');
    } finally {
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { monthlyElectronicInvoicesLimit: subscription.monthlyElectronicInvoicesLimit },
      });
    }
  });

  it('refuses a final consumer invoice above USD 50', async () => {
    const finalConsumer = await prisma.billingProfile.create({
      data: {
        tenantId,
        kind: 'PERSON',
        idType: '07',
        idNumber: '9999999999999',
        legalName: 'CONSUMIDOR FINAL',
        createdById: actorId,
      },
    });
    const order = await paidOrder(60, finalConsumer.id);
    const sent = sri.received.length;
    const refused = await submit(order.id).expect(422);
    // The billing eligibility refuses it first, naming the billing profile (ruling R9).
    expect(refused.body.code).toBe('ORDER_NOT_BILLABLE');
    expect(refused.body.missing).toContain('BILLING_PROFILE');
    expect(await prisma.invoiceRequest.count({ where: { orderId: order.id } })).toBe(0);
    expect(await orderStatus(order.id)).toBe('PAID');
    expect(sri.received.length).toBe(sent);
  });
});
