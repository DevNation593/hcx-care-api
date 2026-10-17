import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlatformTenantsService } from '../src/platform/platform-tenants.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(30000);

describe('Invoice history, read-only (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let token: string;
  let otherToken: string;

  const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
  const server = () => app.getHttpServer();

  async function login(email: string): Promise<string> {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken;
  }

  const patientBody = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Ana',
    lastName: 'Vega',
    email: 'ana@patient.test',
    ...overrides,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.cleanDatabase();

    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    token = await login('admin+1@tenant.test');
    otherToken = await login('admin+2@tenant.test');
    adminId = (
      await prisma.user.findFirstOrThrow({ where: { tenantId, email: 'admin+1@tenant.test' } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('no longer exposes invoice issuing', async () => {
    await request(server())
      .post(`/api/v1/tenants/${tenantId}/billing/invoices`)
      .set(auth(token))
      .send({ patientId: 'any', subtotal: 100, description: 'Consulta' })
      .expect(404);
  });

  it('lists and reads an invoice that was stored before the retirement', async () => {
    const patient = await prisma.patient.create({
      data: { tenantId, firstName: 'Ana', lastName: 'Vega' },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        issuerId: adminId,
        patientId: patient.id,
        status: 'ISSUED',
        subtotal: '100.00',
        tax: '15.00',
        total: '115.00',
        customerName: 'Luis Vega',
        customerEmail: 'luis@payer.test',
        customerTaxIdType: 'CEDULA',
        customerTaxId: '1712345678',
        description: 'Consulta',
        idempotencyKey: `${tenantId}:history-1`,
      },
    });

    const list = await request(server())
      .get(`/api/v1/tenants/${tenantId}/billing/invoices`)
      .query({ patientId: patient.id })
      .set(auth(token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: invoice.id, customerName: 'Luis Vega' });
    expect(list.body[0].patient).toEqual({ id: patient.id, firstName: 'Ana', lastName: 'Vega' });

    const detail = await request(server())
      .get(`/api/v1/tenants/${tenantId}/billing/invoices/${invoice.id}`)
      .set(auth(token))
      .expect(200);
    expect(detail.body).toMatchObject({ id: invoice.id, status: 'ISSUED', total: '115' });
  });

  it('does not list another clinic invoices', async () => {
    const list = await request(server())
      .get(`/api/v1/tenants/${otherTenantId}/billing/invoices`)
      .set(auth(otherToken))
      .expect(200);
    expect(list.body).toEqual([]);
    await request(server())
      .get(`/api/v1/tenants/${tenantId}/billing/invoices`)
      .set(auth(otherToken))
      .expect(403);
  });

  it('rejects billing fields when creating a patient', async () => {
    await request(server())
      .post(`/api/v1/tenants/${tenantId}/patients`)
      .set(auth(token))
      .send(patientBody({ billingTaxId: '1712345678' }))
      .expect(400);
  });

  it('rejects billing fields when updating a patient and returns none in responses', async () => {
    const created = await request(server())
      .post(`/api/v1/tenants/${tenantId}/patients`)
      .set(auth(token))
      .send(patientBody())
      .expect(201);
    expect(Object.keys(created.body).filter((key) => key.startsWith('billing'))).toEqual([]);

    await request(server())
      .patch(`/api/v1/tenants/${tenantId}/patients/${created.body.id}`)
      .set(auth(token))
      .send({ billingTaxId: '1712345678' })
      .expect(400);

    const detail = await request(server())
      .get(`/api/v1/tenants/${tenantId}/patients/${created.body.id}`)
      .set(auth(token))
      .expect(200);
    expect(Object.keys(detail.body).filter((key) => key.startsWith('billing'))).toEqual([]);
  });
});
