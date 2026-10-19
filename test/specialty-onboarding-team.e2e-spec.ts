import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { createPlatformAdmin } from '../prisma/create-platform-admin';
import { PlatformTenantsService } from '../src/platform/platform-tenants.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenantSpecialtiesService } from '../src/specialties/tenant-specialties.service';
import { assertSpecialtyStageDatabaseSafety } from './helpers/assert-e2e-database';

jest.setTimeout(60000);

describe('Specialty onboarding and clinic team (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let platformTenants: PlatformTenantsService;
  let platformToken: string;
  let platformAdminId: string;
  let selections: TenantSpecialtiesService;
  let psychologyId: string;
  let nutritionId: string;
  const suffix = randomUUID();
  const password = 'Password123!';

  const platformPassword = 'Platform-Pass-123!';
  const clinicPayload = (label: string) => ({
    name: `Specialty ${label}`,
    email: `CONTACT-${label}-${suffix}@example.test`,
    tenantType: 'CLINIC' as const,
    timezone: 'America/Guayaquil',
    locale: 'es-EC',
    masterFirstName: 'Ada',
    masterLastName: label,
    masterEmail: `MASTER-${label}-${suffix}@example.test`,
    temporaryPassword: password,
    planType: 'TRIAL' as const,
    specialtyCodes: [' psychology '],
  });

  // The master receives a temporary password; clear the flag so the suite can use the account.
  const clearTemporaryPassword = (masterId: string) =>
    prisma.user.update({ where: { id: masterId }, data: { mustChangePassword: false } });

  beforeAll(async () => {
    assertSpecialtyStageDatabaseSafety(process.env.DATABASE_URL_TEST);

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    platformTenants = app.get(PlatformTenantsService);
    selections = app.get(TenantSpecialtiesService);
    await prisma.cleanDatabase();
    const platformAdmin = await createPlatformAdmin(prisma, {
      email: `platform-${suffix}@example.test`,
      password: platformPassword,
      firstName: 'Plat',
      lastName: 'Admin',
    });
    platformAdminId = platformAdmin.userId;
    const platformLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `platform-${suffix}@example.test`, password: platformPassword })
      .expect(200);
    platformToken = platformLogin.body.accessToken;

    const psychology = await prisma.specialty.upsert({
      where: { code: 'PSYCHOLOGY' },
      update: { name: 'Psicología', isActive: true },
      create: { code: 'PSYCHOLOGY', name: 'Psicología', isActive: true },
    });
    const nutrition = await prisma.specialty.upsert({
      where: { code: 'NUTRITION' },
      update: { name: 'Nutrición', isActive: true },
      create: { code: 'NUTRITION', name: 'Nutrición', isActive: true },
    });
    psychologyId = psychology.id;
    nutritionId = nutrition.id;
    await prisma.specialtyModule.upsert({
      where: { specialtyId_moduleKey: { specialtyId: psychologyId, moduleKey: 'psychologyNotes' } },
      update: {},
      create: { specialtyId: psychologyId, moduleKey: 'psychologyNotes' },
    });
    await prisma.specialtyModule.upsert({
      where: { specialtyId_moduleKey: { specialtyId: nutritionId, moduleKey: 'nutritionPlans' } },
      update: {},
      create: { specialtyId: nutritionId, moduleKey: 'nutritionPlans' },
    });
  });

  afterAll(async () => app?.close());

  it('serves the public catalog and completes authenticated specialty and team administration', async () => {
    const server = app.getHttpServer();
    const catalog = await request(server).get('/api/v1/specialties').expect(200);
    expect(catalog.body.map((item: { code: string }) => item.code)).toEqual(
      expect.arrayContaining(['PSYCHOLOGY', 'NUTRITION']),
    );
    expect(
      catalog.body.find((item: { code: string }) => item.code === 'NUTRITION').modules,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ moduleKey: 'nutritionPlans' })]));

    const created = await request(server)
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send(clinicPayload('primary'))
      .expect(201);
    const tenantId: string = created.body.tenant.id;
    const adminId: string = created.body.master.id;
    expect(created.body.tenant).toMatchObject({ tenantType: 'CLINIC', isActive: true });
    expect(created.body.master).toMatchObject({
      email: `master-primary-${suffix}@example.test`,
      mustChangePassword: true,
    });
    expect(created.body.subscription).toMatchObject({ planType: 'TRIAL', status: 'TRIALING' });
    // `mustChangePassword` is expected; a password field or a bcrypt hash is not.
    expect(JSON.stringify(created.body)).not.toMatch(/"(temporary)?password"|\$2[aby]\$/i);
    expect(created.body.specialties.map((item: { code: string }) => item.code)).toEqual([
      'PSYCHOLOGY',
    ]);
    expect(created.body.sections).toHaveLength(8);
    await clearTemporaryPassword(adminId);

    // Login deliberately uses the normalized value returned by the platform panel.
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: created.body.master.email, password })
      .expect(200);
    expect(login.body.user).toMatchObject({ id: adminId, tenantId });
    expect(JSON.stringify(login.body.user)).not.toMatch(/"(temporary)?password"|\$2[aby]\$/i);
    const token: string = login.body.accessToken;
    expect(token).toEqual(expect.any(String));
    const initialSpecialties = await request(server)
      .get(`/api/v1/tenants/${tenantId}/specialties`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(initialSpecialties.body.map((item: { code: string }) => item.code)).toEqual([
      'PSYCHOLOGY',
    ]);
    const initialModules = await request(server)
      .get(`/api/v1/tenants/${tenantId}/modules`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(initialModules.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleKey: 'psychologyNotes', enabled: true }),
      ]),
    );

    const selectionUrl = `/api/v1/platform/tenants/${tenantId}/specialties`;
    const selection = { specialtyCodes: ['PSYCHOLOGY', 'NUTRITION'] };
    const first = await request(server)
      .put(selectionUrl)
      .set('Authorization', `Bearer ${platformToken}`)
      .send(selection)
      .expect(200);
    const second = await request(server)
      .put(selectionUrl)
      .set('Authorization', `Bearer ${platformToken}`)
      .send(selection)
      .expect(200);
    expect(first.body.pricing).toEqual(second.body.pricing);
    expect(second.body.pricing).toMatchObject({
      selectedSpecialties: 2,
      billableSpecialties: 1,
      specialtyAddonsPrice: 15,
      totalMonthly: 15,
    });
    expect(second.body.specialties.map((item: { code: string }) => item.code)).toEqual([
      'PSYCHOLOGY',
      'NUTRITION',
    ]);
    const subscription = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    expect(Number(subscription.basePrice)).toBe(15);
    expect(await prisma.tenantSpecialty.count({ where: { tenantId } })).toBe(2);
    expect(
      await prisma.subscriptionSpecialty.count({
        where: { tenantSubscriptionId: subscription.id },
      }),
    ).toBe(2);
    expect(
      await prisma.tenantModule.count({ where: { tenantId, moduleKey: 'psychologyNotes' } }),
    ).toBe(1);
    expect(
      await prisma.tenantModule.count({ where: { tenantId, moduleKey: 'nutritionPlans' } }),
    ).toBe(1);

    // The master holds no professional profile, so the specialty is only in use once a
    // psychology professional exists.
    const psychologist = await request(server)
      .post(`/api/v1/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `psychology-${suffix}@example.test`,
        password,
        firstName: 'Pia',
        lastName: 'Psychology',
        role: 'PROFESIONAL',
        professionalProfile: { specialtyId: psychologyId },
      })
      .expect(201);
    const psychologistId: string = psychologist.body.id;

    const blocked = await request(server)
      .put(selectionUrl)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ specialtyCodes: ['NUTRITION'] })
      .expect(409);
    expect(blocked.body.code).toBe('SPECIALTY_IN_USE_BY_ACTIVE_PROFESSIONAL');
    expect(await prisma.tenantSpecialty.count({ where: { tenantId } })).toBe(2);

    const inactive = await request(server)
      .patch(`/api/v1/tenants/${tenantId}/users/${psychologistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ professionalProfile: { specialtyId: psychologyId, isActive: false } })
      .expect(200);
    expect(inactive.body.professionalProfile).toMatchObject({
      specialtyId: psychologyId,
      isActive: false,
    });
    expect(inactive.body.isActive).toBe(true);

    const nutritionOnly = await request(server)
      .put(selectionUrl)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ specialtyCodes: ['NUTRITION'] })
      .expect(200);
    expect(nutritionOnly.body.specialties.map((item: { code: string }) => item.code)).toEqual([
      'NUTRITION',
    ]);
    expect(nutritionOnly.body.pricing).toMatchObject({ selectedSpecialties: 1, totalMonthly: 0 });
    expect(await prisma.tenantSpecialty.count({ where: { tenantId } })).toBe(1);
    expect(
      await prisma.subscriptionSpecialty.count({
        where: { tenantSubscriptionId: subscription.id },
      }),
    ).toBe(1);
    expect(
      await prisma.tenantModule.count({ where: { tenantId, moduleKey: 'psychologyNotes' } }),
    ).toBe(0);
    expect(
      await prisma.tenantModule.count({ where: { tenantId, moduleKey: 'nutritionPlans' } }),
    ).toBe(1);

    const professional = await request(server)
      .post(`/api/v1/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `nutrition-${suffix}@example.test`,
        password,
        firstName: 'Noa',
        lastName: 'Nutrition',
        role: 'PROFESIONAL',
        professionalProfile: { specialtyId: nutritionId },
      })
      .expect(201);
    expect(professional.body).toMatchObject({
      tenantId,
      role: 'PROFESIONAL',
      isActive: true,
      managedByProvider: false,
      professionalProfile: { specialtyId: nutritionId, isActive: true },
    });
    expect(JSON.stringify(professional.body)).not.toMatch(/"(temporary)?password"|\$2[aby]\$/i);
    const professionalLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: professional.body.email, password })
      .expect(200);
    expect(professionalLogin.body.user.id).toBe(professional.body.id);
    const team = await request(server)
      .get(`/api/v1/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(team.body).toHaveLength(3);
    expect(team.body.map((user: { id: string }) => user.id)).toEqual(
      expect.arrayContaining([adminId, psychologistId, professional.body.id]),
    );
    expect(JSON.stringify(team.body)).not.toMatch(/"(temporary)?password"|\$2[aby]\$/i);

    const other = await request(server)
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send(clinicPayload('other'))
      .expect(201);
    await clearTemporaryPassword(other.body.master.id);
    const otherLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: other.body.master.email, password })
      .expect(200);
    const otherSpecialties = await request(server)
      .get(`/api/v1/tenants/${other.body.tenant.id}/specialties`)
      .set('Authorization', `Bearer ${otherLogin.body.accessToken}`)
      .expect(200);
    expect(otherSpecialties.body.map((item: { code: string }) => item.code)).toEqual([
      'PSYCHOLOGY',
    ]);
    expect(otherSpecialties.body[0].id).toBe(psychologyId);
    const foreign = await request(server)
      .post(`/api/v1/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `foreign-${suffix}@example.test`,
        password,
        firstName: 'Foreign',
        lastName: 'Specialty',
        role: 'PROFESIONAL',
        professionalProfile: { specialtyId: psychologyId },
      })
      .expect(409);
    expect(foreign.body.code).toBe('SPECIALTY_NOT_ENABLED');
    expect(await prisma.user.count({ where: { tenantId } })).toBe(3);

    const selfDeactivate = await request(server)
      .patch(`/api/v1/tenants/${tenantId}/users/${adminId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
      .expect(400);
    expect(selfDeactivate.body.code).toBe('MASTER_IMMUTABLE');
    expect(await prisma.user.count({ where: { id: adminId, isActive: true } })).toBe(1);

    await request(server)
      .patch(`/api/v1/tenants/${other.body.tenant.id}/users/${other.body.master.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Intruder' })
      .expect(403);
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: other.body.master.id },
        select: { firstName: true },
      }),
    ).toEqual({ firstName: 'Ada' });
  });

  it('rolls back tenant and administrator when specialty selection fails after writes', async () => {
    const payload = clinicPayload('rollback');
    const external = new PrismaClient();
    try {
      const failure = new Error('selection failed after writes');
      const spy = jest.spyOn(selections, 'applySelection').mockImplementation(async (tx, input) => {
        expect(await tx.tenant.findUnique({ where: { id: input.tenantId } })).not.toBeNull();
        expect(
          await tx.user.findFirst({
            where: { tenantId: input.tenantId, email: payload.masterEmail.toLowerCase() },
          }),
        ).not.toBeNull();
        throw failure;
      });
      try {
        await expect(platformTenants.create(payload, platformAdminId)).rejects.toThrow(
          failure.message,
        );
      } finally {
        spy.mockRestore();
      }
      expect(await external.tenant.count({ where: { email: payload.email.toLowerCase() } })).toBe(
        0,
      );
      expect(
        await external.user.count({ where: { email: payload.masterEmail.toLowerCase() } }),
      ).toBe(0);
    } finally {
      await external.$disconnect();
    }
  });
});
