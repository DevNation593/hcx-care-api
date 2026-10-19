import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';
import { migrateBillingProfiles } from './../prisma/migrate-billing-profiles';

jest.setTimeout(60000);

describe('Billing profiles deployment script (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let masterId: string;
  let patientA: string;
  let patientB: string;
  let patientBadRuc: string;
  let patientNoEmail: string;
  let patientNoType: string;
  let patientUnknownType: string;
  let freshProfessional: string;
  let revokedProfessional: string;

  const newPatient = async (data: Record<string, unknown>) =>
    (
      await prisma.patient.create({
        data: { tenantId, firstName: 'Paciente', lastName: 'Prueba', ...data },
      })
    ).id;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<PrismaService>(PrismaService);
    const users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    const tenant = await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1);
    tenantId = tenant.id;
    masterId = tenant.master!.id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId },
      data: { planType: 'CLINIC_BASIC', status: 'ACTIVE', seatsPsychologistsMax: 5 },
    });
    const specialtyId = (
      await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })
    ).id;
    const professional = async (email: string) =>
      (
        await users.create(
          {
            tenantId,
            email,
            password: TEST_PASSWORD,
            firstName: 'Pro',
            lastName: 'Member',
            role: 'PROFESIONAL',
            professionalProfile: { specialtyId },
          },
          'fixture-actor',
        )
      ).id;
    freshProfessional = await professional('fresh@tenant.test');
    revokedProfessional = await professional('revoked@tenant.test');
    await prisma.userPermission.deleteMany({ where: { tenantId } });
    await prisma.userPermission.create({
      data: {
        tenantId,
        userId: revokedProfessional,
        permission: 'billing.create',
        granted: false,
      },
    });

    patientA = await newPatient({
      billingName: 'Ana Paciente',
      billingTaxIdType: 'CEDULA',
      billingTaxId: '1710034065',
      billingEmail: 'ana@billing.test',
      billingAddress: 'Av. Siempre Viva 123',
    });
    patientB = await newPatient({
      email: 'beto@patient.test',
      billingName: 'Beto Paciente',
      billingTaxIdType: 'CEDULA',
      billingTaxId: '171003406-5',
    });
    patientBadRuc = await newPatient({
      billingName: 'Empresa Mala',
      billingTaxIdType: 'RUC',
      billingTaxId: '1234567890001',
      billingEmail: 'mala@billing.test',
    });
    patientNoEmail = await newPatient({
      billingName: 'Sin Correo',
      billingTaxIdType: 'PASSPORT',
      billingTaxId: 'ab123456',
    });
    patientNoType = await newPatient({
      billingName: 'Sin Tipo',
      billingTaxId: '1710034065',
      billingEmail: 'sintipo@billing.test',
    });
    patientUnknownType = await newPatient({
      billingName: 'Tipo Raro',
      billingTaxIdType: 'DNI',
      billingTaxId: '12345678',
      billingEmail: 'raro@billing.test',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates and reuses profiles without assigning personal or role permissions', async () => {
    const first = await migrateBillingProfiles(prisma);

    expect(first.profilesCreated).toBe(1);
    expect(first.profilesReused).toBe(1);
    expect(first.linksCreated).toBe(2);
    expect(first.skippedInvalid).toEqual(
      expect.arrayContaining([
        { patientId: patientBadRuc, reason: 'IDENTIFICATION_INVALID' },
        { patientId: patientNoEmail, reason: 'EMAIL_MISSING' },
        { patientId: patientNoType, reason: 'TAX_ID_TYPE_INVALID' },
        { patientId: patientUnknownType, reason: 'TAX_ID_TYPE_INVALID' },
      ]),
    );
    expect(first.skippedInvalid).toHaveLength(4);

    const profiles = await prisma.billingProfile.findMany({ where: { tenantId } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      idType: '05',
      idNumber: '1710034065',
      kind: 'PERSON',
      legalName: 'Ana Paciente',
      email: 'ana@billing.test',
      address: 'Av. Siempre Viva 123',
      createdById: masterId,
    });
    const links = await prisma.patientBillingProfile.findMany({ where: { tenantId } });
    expect(links.map((link) => link.patientId).sort()).toEqual([patientA, patientB].sort());
    expect(links.every((link) => link.isDefault)).toBe(true);

    const permissions = await prisma.userPermission.findMany({
      where: { tenantId },
      orderBy: [{ userId: 'asc' }, { permission: 'asc' }],
    });
    expect(permissions).toMatchObject([
      { userId: revokedProfessional, permission: 'billing.create', granted: false },
    ]);
    expect(permissions.some((row) => row.userId === freshProfessional)).toBe(false);
    expect(await prisma.tenantRolePermission.count({ where: { tenantId } })).toBe(0);

    const second = await migrateBillingProfiles(prisma);
    expect(second).toMatchObject({
      profilesCreated: 0,
      profilesReused: 0,
      linksCreated: 0,
    });
    expect(second.skippedInvalid).toHaveLength(4);
  });
});
