import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-bill-as-patient-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { createPlatformAdmin } from './../prisma/create-platform-admin';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);

// Valid Ecuadorian cedulas (modulo 10 check digit).
const CEDULA_A = '1710034065';
const CEDULA_B = '0926687856';

describe("Invoice in the patient's own name (E2E)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let counter = 0;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const own = (patientId: string, tenant = tenantId) =>
    `${base(tenant)}/patients/${patientId}/billing-profiles/own`;

  const login = async (email: string) => {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };

  const newPatient = async (data: Record<string, unknown> = {}): Promise<string> => {
    counter += 1;
    const created = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({ firstName: 'Ana', lastName: `Factura ${counter}`, ...data })
      .expect(201);
    return created.body.id;
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

    await prisma.cleanDatabase();
    await createPlatformAdmin(prisma, {
      email: 'platform-bill-as-patient@example.test',
      password: TEST_PASSWORD,
      firstName: 'Platform',
      lastName: 'Admin',
    });
    const tenants = app.get(PlatformTenantsService);
    tenantId = (await createTestTenant({ tenants, prisma }, 1)).id;
    otherTenantId = (await createTestTenant({ tenants, prisma }, 2)).id;
    tokens.master = await login('admin+1@tenant.test');
    tokens.otherMaster = await login('admin+2@tenant.test');

    await request(server())
      .post(`${base()}/users`)
      .set(as('master'))
      .send({
        email: 'cajero-own@tenant.test',
        password: TEST_PASSWORD,
        firstName: 'Cajera',
        lastName: 'Factura',
        role: 'CAJERO',
      })
      .expect(201);
    tokens.cashier = await login('cajero-own@tenant.test');
  });

  afterAll(async () => {
    await app.close();
  });

  it('builds the recipient from complete patient data and makes it the default', async () => {
    const patientId = await newPatient({
      identificationType: 'CEDULA',
      identificationNumber: CEDULA_A,
      email: 'ana@example.test',
      address: 'Av. Amazonas',
    });

    const response = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({})
      .expect(201);

    expect(response.body).toMatchObject({
      kind: 'PERSON',
      idType: '05',
      idNumber: CEDULA_A,
      legalName: expect.stringMatching(/^Ana Factura \d+$/),
      email: 'ana@example.test',
      address: 'Av. Amazonas',
      isDefault: true,
    });

    // Asking again reuses the same profile.
    const again = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({})
      .expect(201);
    expect(again.body.id).toBe(response.body.id);
    expect(await prisma.billingProfile.count({ where: { tenantId, idNumber: CEDULA_A } })).toBe(1);
  });

  it('names what is missing, then completes the patient record and bills in its name', async () => {
    const patientId = await newPatient();

    const missing = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({})
      .expect(422);
    expect(missing.body).toMatchObject({
      code: 'PATIENT_BILLING_DATA_INCOMPLETE',
      details: { missing: ['identification', 'email'], identificationOnFile: false },
    });

    const response = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({
        identificationType: 'CEDULA',
        identificationNumber: CEDULA_B,
        email: 'b@example.test',
      })
      .expect(201);
    expect(response.body).toMatchObject({ idType: '05', idNumber: CEDULA_B, isDefault: true });

    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(patient).toMatchObject({
      identificationType: 'CEDULA',
      identificationNumber: CEDULA_B,
      email: 'b@example.test',
    });
  });

  it('never overwrites data the patient already has', async () => {
    const patientId = await newPatient({ email: 'kept@example.test' });

    await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({
        identificationType: 'PASSPORT',
        identificationNumber: `PX${Date.now()}`,
        email: 'other@example.test',
      })
      .expect(201);

    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(patient.email).toBe('kept@example.test');
  });

  it('rejects an invalid cedula without touching the patient', async () => {
    const patientId = await newPatient({ email: 'c@example.test' });

    const response = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({ identificationType: 'CEDULA', identificationNumber: '1710034066' })
      .expect(422);
    expect(response.body.code).toBe('BILLING_PROFILE_INVALID');
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(patient.identificationNumber).toBeNull();
  });

  it('says to fix an identification on file that cannot be invoiced', async () => {
    const patientId = await newPatient({
      identificationType: 'OTHER',
      identificationNumber: `OT${Date.now()}`,
      email: 'd@example.test',
    });

    const response = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({})
      .expect(422);
    expect(response.body).toMatchObject({
      code: 'PATIENT_BILLING_DATA_INCOMPLETE',
      details: { missing: ['identification'], identificationOnFile: true },
    });
  });

  it('refuses an identification another patient already has', async () => {
    const patientId = await newPatient({ email: 'e@example.test' });

    const response = await request(server())
      .post(own(patientId))
      .set(as('master'))
      .send({ identificationType: 'CEDULA', identificationNumber: CEDULA_A })
      .expect(409);
    expect(response.body.code).toBe('PATIENT_IDENTIFICATION_TAKEN');
  });

  it('lets the cashier bill a complete patient but not complete the record', async () => {
    const complete = await newPatient({
      identificationType: 'PASSPORT',
      identificationNumber: `PC${Date.now()}`,
      email: 'f@example.test',
    });
    await request(server()).post(own(complete)).set(as('cashier')).send({}).expect(201);

    const incomplete = await newPatient();
    const refused = await request(server())
      .post(own(incomplete))
      .set(as('cashier'))
      .send({
        identificationType: 'PASSPORT',
        identificationNumber: `PI${Date.now()}`,
        email: 'g@example.test',
      })
      .expect(403);
    expect(refused.body.code).toBe('PERMISSION_DENIED');
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: incomplete } });
    expect(patient.identificationNumber).toBeNull();
  });

  it("answers 404 to another clinic's master", async () => {
    const patientId = await newPatient({
      identificationType: 'PASSPORT',
      identificationNumber: `PO${Date.now()}`,
      email: 'h@example.test',
    });

    await request(server()).post(own(patientId)).set(as('otherMaster')).send({}).expect(403);
    await request(server())
      .post(own(patientId, otherTenantId))
      .set(as('otherMaster'))
      .send({})
      .expect(404);
    expect(await prisma.patientBillingProfile.count({ where: { patientId } })).toBe(0);
  });
});
