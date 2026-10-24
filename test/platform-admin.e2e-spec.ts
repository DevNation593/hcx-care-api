import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/auth.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { SECTION_KEYS } from './../src/common/sections/section-catalog';
import { TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

describe('Platform admin panel (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let adminToken: string;
  let masterToken: string;

  const masterEmail = 'titular@consultorio-e2e.test';
  const temporaryPassword = 'Temporal-2026';
  const ownPassword = 'Propia-2026!';
  const resetPassword = 'Reinicio-2026';
  const api = (path: string) => `/api/v1${path}`;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());
  const login = async (email: string, password: string) => {
    const response = await http().post(api('/auth/login')).send({ email, password }).expect(200);
    return response.body.accessToken as string;
  };

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

    await prisma.cleanDatabase();
    const psychology = await prisma.specialty.upsert({
      where: { code: 'PSYCHOLOGY' },
      update: { isActive: true },
      create: { code: 'PSYCHOLOGY', name: 'Psicología', isActive: true },
    });
    // The migration adds it to the catalog; a database cleaned by other suites may have lost it.
    await prisma.specialty.upsert({
      where: { code: 'AESTHETICS' },
      update: { isActive: true },
      create: { code: 'AESTHETICS', name: 'Estética', isActive: true },
    });
    const nutrition = await prisma.specialty.upsert({
      where: { code: 'NUTRITION' },
      update: { isActive: true },
      create: { code: 'NUTRITION', name: 'Nutrición', isActive: true },
    });
    await prisma.specialtyModule.upsert({
      where: {
        specialtyId_moduleKey: {
          specialtyId: psychology.id,
          moduleKey: 'psychology.assessments',
        },
      },
      update: {},
      create: { specialtyId: psychology.id, moduleKey: 'psychology.assessments' },
    });
    await prisma.specialtyModule.upsert({
      where: {
        specialtyId_moduleKey: {
          specialtyId: nutrition.id,
          moduleKey: 'nutrition.assessments',
        },
      },
      update: {},
      create: { specialtyId: nutrition.id, moduleKey: 'nutrition.assessments' },
    });
    const platformTenant = await prisma.tenant.create({
      data: { name: 'Plataforma', email: 'platform@tenant.test', isPlatform: true },
    });
    await prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: 'platform-admin@tenant.test',
        password: await app.get<AuthService>(AuthService).hashPassword(TEST_PASSWORD),
        firstName: 'Platform',
        lastName: 'Admin',
        role: 'ADMIN',
        isActive: true,
      },
    });
    adminToken = await login('platform-admin@tenant.test', TEST_PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the ADMIN create a clinic with tasks disabled', async () => {
    const response = await http()
      .post(api('/platform/tenants'))
      .set(bearer(adminToken))
      .send({
        name: 'Consultorio E2E',
        email: 'contacto@consultorio-e2e.test',
        tenantType: 'CLINIC',
        timezone: 'America/Guayaquil',
        locale: 'es-EC',
        masterFirstName: 'Titular',
        masterLastName: 'E2E',
        masterEmail,
        temporaryPassword,
        planType: 'TRIAL',
        specialtyCodes: ['PSYCHOLOGY'],
        sections: SECTION_KEYS.filter((key) => key !== 'core.agenda.tasks'),
      })
      .expect(201);

    tenantId = response.body.tenant.id;
    const sections = response.body.sections as { key: string; enabled: boolean }[];
    expect(sections).toHaveLength(SECTION_KEYS.length);
    expect(sections.find((section) => section.key === 'core.agenda.tasks')?.enabled).toBe(false);
    expect(sections.filter((section) => section.enabled)).toHaveLength(SECTION_KEYS.length - 1);
    expect(response.body.master).toMatchObject({ email: masterEmail, mustChangePassword: true });
    expect(response.body.master.password).toBeUndefined();
  });

  describe('an aesthetic-only clinic', () => {
    const alta = (extra: Record<string, unknown> = {}) =>
      http()
        .post(api('/platform/tenants'))
        .set(bearer(adminToken))
        .send({
          name: 'Estudio E2E',
          email: 'contacto@estudio-e2e.test',
          tenantType: 'CLINIC',
          timezone: 'America/Guayaquil',
          locale: 'es-EC',
          masterFirstName: 'Titular',
          masterLastName: 'Estudio',
          masterEmail: 'titular@estudio-e2e.test',
          temporaryPassword,
          planType: 'CLINIC_BASIC',
          specialtyCodes: ['AESTHETICS'],
          ...extra,
        });

    it('refuses the business kind an old web client may still send', async () => {
      await alta({ businessKind: 'AESTHETIC_STUDIO' }).expect(400);
    });

    it('starts without clinical notes but with patients, calendar and clinical modules', async () => {
      const response = await alta().expect(201);
      const enabled = Object.fromEntries(
        (response.body.sections as { key: string; enabled: boolean }[]).map((s) => [
          s.key,
          s.enabled,
        ]),
      );
      expect(enabled).toMatchObject({
        'core.clinical.notes': false,
        'core.patients': true,
        'core.agenda.calendar': true,
        'core.clinical.specialties': true,
      });
      expect(response.body.specialties.map((s: { code: string }) => s.code)).toEqual([
        'AESTHETICS',
      ]);
    });
  });

  it('blocks the new master with PASSWORD_CHANGE_REQUIRED', async () => {
    masterToken = await login(masterEmail, temporaryPassword);
    const response = await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(masterToken))
      .expect(403);
    expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('lets the master change the password and list patients', async () => {
    await http()
      .post(api('/auth/change-password'))
      .set(bearer(masterToken))
      .send({ currentPassword: temporaryPassword, newPassword: ownPassword })
      .expect(200);

    await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(masterToken))
      .expect(200);
  });

  it('answers SECTION_NOT_ENABLED on tasks', async () => {
    const response = await http()
      .get(api(`/tenants/${tenantId}/tasks`))
      .set(bearer(masterToken))
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'SECTION_NOT_ENABLED',
      section: 'core.agenda.tasks',
    });
  });

  it('opens tasks after the ADMIN enables the section', async () => {
    await http()
      .put(api(`/platform/tenants/${tenantId}/sections`))
      .set(bearer(adminToken))
      .send({ sections: [...SECTION_KEYS] })
      .expect(200);

    await http()
      .get(api(`/tenants/${tenantId}/tasks`))
      .set(bearer(masterToken))
      .expect(200);
  });

  it('applies owner-assigned permissions to the clinic role immediately', async () => {
    const roleUrl = api(`/platform/tenants/${tenantId}/roles/MASTER/permissions`);
    const initial = await http().get(roleUrl).set(bearer(adminToken)).expect(200);
    const originalAllowed = initial.body.effective as string[];
    expect(originalAllowed).toContain('patients.create');

    await http()
      .put(roleUrl)
      .set(bearer(masterToken))
      .send({ allowed: originalAllowed })
      .expect(403);
    await http()
      .put(api(`/tenants/${tenantId}/users/me/permissions`))
      .set(bearer(masterToken))
      .send({ revoked: ['patients.create'] })
      .expect(404);

    try {
      await http()
        .put(roleUrl)
        .set(bearer(adminToken))
        .send({ allowed: originalAllowed.filter((permission) => permission !== 'patients.create') })
        .expect(200);

      const permissions = await http()
        .get(api(`/tenants/${tenantId}/users/me/permissions`))
        .set(bearer(masterToken))
        .expect(200);
      expect(permissions.body.effective).not.toContain('patients.create');

      const denied = await http()
        .post(api(`/tenants/${tenantId}/patients`))
        .set(bearer(masterToken))
        .send({})
        .expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
    } finally {
      await http()
        .put(roleUrl)
        .set(bearer(adminToken))
        .send({ allowed: originalAllowed })
        .expect(200);
    }
  });

  it('grants a new permission to every assistant in the clinic role', async () => {
    const roleUrl = api(`/platform/tenants/${tenantId}/roles/ASISTENTE/permissions`);
    const invoicesUrl = api(`/tenants/${tenantId}/billing/invoices`);
    const password = await app.get<AuthService>(AuthService).hashPassword(TEST_PASSWORD);
    const emails = ['assistant-one@consultorio-e2e.test', 'assistant-two@consultorio-e2e.test'];
    for (const email of emails) {
      await prisma.user.create({
        data: {
          tenantId,
          email,
          password,
          firstName: 'Assistant',
          lastName: 'E2E',
          role: 'ASISTENTE',
          isActive: true,
        },
      });
    }
    const tokens = await Promise.all(emails.map((email) => login(email, TEST_PASSWORD)));
    const initial = await http().get(roleUrl).set(bearer(adminToken)).expect(200);
    const originalAllowed = initial.body.effective as string[];
    expect(originalAllowed).not.toContain('billing.view');

    for (const token of tokens) {
      const denied = await http().get(invoicesUrl).set(bearer(token)).expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
    }

    try {
      await http()
        .put(roleUrl)
        .set(bearer(adminToken))
        .send({ allowed: [...originalAllowed, 'billing.view'] })
        .expect(200);
      for (const token of tokens) {
        await http().get(invoicesUrl).set(bearer(token)).expect(200);
      }
    } finally {
      await http()
        .put(roleUrl)
        .set(bearer(adminToken))
        .send({ allowed: originalAllowed })
        .expect(200);
    }
    for (const token of tokens) {
      const denied = await http().get(invoicesUrl).set(bearer(token)).expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
    }
  });

  it('lets only the owner assign specialties and toggle their clinical modules', async () => {
    const specialtiesUrl = api(`/platform/tenants/${tenantId}/specialties`);
    const moduleUrl = api(`/platform/tenants/${tenantId}/modules/psychology.assessments`);
    const auditWhere = { tenantId, action: 'UPDATE' as const, entity: 'TENANT' as const };
    const auditBefore = await prisma.auditLog.count({ where: auditWhere });

    await http()
      .put(specialtiesUrl)
      .set(bearer(masterToken))
      .send({ specialtyCodes: ['PSYCHOLOGY', 'NUTRITION'] })
      .expect(403);
    await http()
      .put(api(`/tenants/${tenantId}/specialties`))
      .set(bearer(masterToken))
      .send({ specialtyCodes: ['PSYCHOLOGY', 'NUTRITION'] })
      .expect(404);

    const selection = await http()
      .put(specialtiesUrl)
      .set(bearer(adminToken))
      .send({ specialtyCodes: ['PSYCHOLOGY', 'NUTRITION'] })
      .expect(200);
    expect(selection.body.specialties.map((specialty: { code: string }) => specialty.code)).toEqual(
      ['PSYCHOLOGY', 'NUTRITION'],
    );
    expect(selection.body.pricing.specialtyAddonsPrice).toBe(15);

    await http().patch(moduleUrl).set(bearer(masterToken)).send({ enabled: false }).expect(403);
    await http()
      .patch(api(`/tenants/${tenantId}/modules/psychology.assessments`))
      .set(bearer(masterToken))
      .send({ enabled: false })
      .expect(404);
    await http().patch(moduleUrl).set(bearer(adminToken)).send({ enabled: false }).expect(200);

    const detail = await http()
      .get(api(`/platform/tenants/${tenantId}`))
      .set(bearer(adminToken))
      .expect(200);
    expect(detail.body.specialties).toHaveLength(2);
    expect(detail.body.modules).toContainEqual({ key: 'psychology.assessments', enabled: false });
    expect(detail.body.subscription.basePrice).toBe(selection.body.pricing.totalMonthly);
    expect(await prisma.auditLog.count({ where: auditWhere })).toBe(auditBefore + 2);
  });

  it.each(['patients', 'appointments', 'clinical-notes'])(
    'answers PLATFORM_ONLY when the ADMIN asks for %s of the clinic',
    async (resource) => {
      const response = await http()
        .get(api(`/tenants/${tenantId}/${resource}`))
        .set(bearer(adminToken))
        .expect(403);
      expect(response.body.code).toBe('PLATFORM_ONLY');
    },
  );

  it('rejects the master on /platform/tenants with 403', async () => {
    await http().get(api('/platform/tenants')).set(bearer(masterToken)).expect(403);
  });

  it('blocks the master with PASSWORD_CHANGE_REQUIRED right after the ADMIN resets the password', async () => {
    await http()
      .post(api(`/platform/tenants/${tenantId}/master/reset-password`))
      .set(bearer(adminToken))
      .send({ temporaryPassword: resetPassword })
      .expect(200);

    // The access token issued before the reset is still valid; the flag is read on every request.
    const response = await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(masterToken))
      .expect(403);
    expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('cuts the master off when the clinic is suspended and restores access on reactivation', async () => {
    await http()
      .post(api(`/platform/tenants/${tenantId}/master/reset-password`))
      .set(bearer(adminToken))
      .send({ temporaryPassword: resetPassword })
      .expect(200);
    const token = await login(masterEmail, resetPassword);
    await http()
      .post(api('/auth/change-password'))
      .set(bearer(token))
      .send({ currentPassword: resetPassword, newPassword: ownPassword })
      .expect(200);
    await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(token))
      .expect(200);

    await http()
      .post(api(`/platform/tenants/${tenantId}/suspend`))
      .set(bearer(adminToken))
      .send({ reason: 'Falta de pago' })
      .expect(200);
    await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(token))
      .expect(401);

    await http()
      .post(api(`/platform/tenants/${tenantId}/reactivate`))
      .set(bearer(adminToken))
      .expect(200);
    await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(bearer(token))
      .expect(200);
  });

  it.each([
    ['POST', '/onboarding/tenants'],
    ['POST', '/tenants'],
  ])('%s %s no longer exists', async (method, path) => {
    expect(method).toBe('POST');
    await http().post(api(path)).set(bearer(adminToken)).send({}).expect(404);
  });
});
