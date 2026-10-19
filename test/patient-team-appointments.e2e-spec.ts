import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { reconcilePatientTeamAppointments } from '../prisma/reconcile-patient-team-appointments';
import { AppModule } from '../src/app.module';
import { createPlatformAdmin } from '../prisma/create-platform-admin';
import { PlatformTenantsService } from '../src/platform/platform-tenants.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertSpecialtyStageDatabaseSafety } from './helpers/assert-e2e-database';
import { createTestTenant } from './helpers/create-test-tenant';

jest.setTimeout(120000);

describe('Patient team and appointments (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let psychologyId: string;
  let nutritionId: string;
  let adminId: string;
  let psychologyProfessionalId: string;
  let nutritionProfessionalId: string;
  let otherProfessionalId: string;
  let adminToken: string;
  let platformToken: string;
  let otherAdminToken: string;
  let assistantToken: string;
  let psychologyToken: string;
  let nutritionToken: string;
  const suffix = randomUUID();
  const password = 'Password123!';
  const bearer = (token: string) => `Bearer ${token}`;
  const teamUrl = (patientId: string, routeTenantId = tenantId) =>
    `/api/v1/tenants/${routeTenantId}/patients/${patientId}/team`;
  const appointmentsUrl = (routeTenantId = tenantId) =>
    `/api/v1/tenants/${routeTenantId}/appointments`;
  const futureBase = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  futureBase.setUTCHours(14, 0, 0, 0);
  futureBase.setUTCDate(futureBase.getUTCDate() + ((8 - futureBase.getUTCDay()) % 7));
  const futureAt = (weekdays: number) => {
    const date = new Date(futureBase);
    date.setUTCDate(date.getUTCDate() + Math.floor(weekdays / 5) * 7 + (weekdays % 5));
    return date.toISOString();
  };
  const appointmentInput = (
    patientId: string,
    professionalId: string,
    specialtyId: string,
    days: number,
  ) => ({
    patientId,
    professionalId,
    specialtyId,
    startTime: futureAt(days),
    duration: 60,
    title: `Consultation ${days}`,
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    return response.body.accessToken;
  }

  async function createPatient(label: string, routeTenantId = tenantId, token = adminToken) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${routeTenantId}/patients`)
      .set('Authorization', bearer(token))
      .send({
        firstName: label,
        lastName: 'Patient',
        email: `${label.toLowerCase()}-${suffix}@example.test`,
      })
      .expect(201);
    expect(response.body).toMatchObject({ tenantId: routeTenantId, firstName: label });
    return response.body.id as string;
  }

  async function createUser(
    routeTenantId: string,
    token: string,
    label: string,
    role: 'ASISTENTE' | 'PROFESIONAL',
    specialtyId?: string,
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${routeTenantId}/users`)
      .set('Authorization', bearer(token))
      .send({
        email: `${label}-${suffix}@example.test`,
        password,
        firstName: label,
        lastName: 'Team',
        role,
        ...(specialtyId && { professionalProfile: { specialtyId } }),
      })
      .expect(201);
    expect(response.body).toMatchObject({ tenantId: routeTenantId, role });
    return response.body as { id: string; email: string };
  }

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
    await prisma.cleanDatabase();
    await createPlatformAdmin(prisma, {
      email: 'platform-team-e2e@example.test',
      password,
      firstName: 'Platform',
      lastName: 'Admin',
    });
    platformToken = await login('platform-team-e2e@example.test');

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

    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    const primary = await createTestTenant(deps, 1);
    const other = await createTestTenant(deps, 2);
    tenantId = primary.id;
    otherTenantId = other.id;
    adminId = primary.master!.id;
    adminToken = await login(primary.master!.email);
    otherAdminToken = await login(other.master!.email);

    await request(app.getHttpServer())
      .put(`/api/v1/platform/tenants/${tenantId}/specialties`)
      .set('Authorization', bearer(platformToken))
      .send({ specialtyCodes: ['PSYCHOLOGY', 'NUTRITION'] })
      .expect(200);
    await prisma.tenantSubscription.update({
      where: { tenantId },
      data: { seatsPsychologistsMax: 5, maxActivePatients: 100 },
    });
    await prisma.tenantSubscription.update({
      where: { tenantId: otherTenantId },
      data: { seatsPsychologistsMax: 5, maxActivePatients: 100 },
    });
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenantSettings.update({
        where: { tenantId: id },
        data: {
          workingDays: [
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
            'SUNDAY',
          ],
          workingHoursStart: '00:00',
          workingHoursEnd: '23:59',
        },
      });
    }

    const assistant = await createUser(tenantId, adminToken, 'assistant', 'ASISTENTE');
    const psychologyProfessional = await createUser(
      tenantId,
      adminToken,
      'psychology',
      'PROFESIONAL',
      psychologyId,
    );
    const nutritionProfessional = await createUser(
      tenantId,
      adminToken,
      'nutrition',
      'PROFESIONAL',
      nutritionId,
    );
    const otherProfessional = await createUser(
      otherTenantId,
      otherAdminToken,
      'other-professional',
      'PROFESIONAL',
      psychologyId,
    );
    psychologyProfessionalId = psychologyProfessional.id;
    nutritionProfessionalId = nutritionProfessional.id;
    otherProfessionalId = otherProfessional.id;
    assistantToken = await login(assistant.email);
    psychologyToken = await login(psychologyProfessional.email);
    nutritionToken = await login(nutritionProfessional.email);
  });

  afterAll(async () => app?.close());

  it('enforces team permissions, idempotency and hidden cross-tenant IDs', async () => {
    const server = app.getHttpServer();
    const patientId = await createPatient('Team');
    const otherPatientId = await createPatient('Foreign', otherTenantId, otherAdminToken);
    const patientCountBeforeTeamWrites = await prisma.patient.count({ where: { tenantId } });
    const url = teamUrl(patientId);
    const first = await request(server)
      .put(`${url}/${psychologyProfessionalId}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const repeated = await request(server)
      .put(`${url}/${psychologyProfessionalId}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(first.body).toMatchObject({ professionalId: psychologyProfessionalId, isActive: true });
    expect(first.body.assignedBy).toMatchObject({ id: adminId });
    expect(repeated.body).toMatchObject({ id: first.body.id, assignedAt: first.body.assignedAt });
    expect(
      await prisma.patientProfessional.count({
        where: { patientId, professionalId: psychologyProfessionalId },
      }),
    ).toBe(1);

    const referred = await request(server)
      .put(`${url}/${nutritionProfessionalId}`)
      .set('Authorization', bearer(psychologyToken))
      .expect(200);
    expect(referred.body).toMatchObject({
      patientId,
      professionalId: nutritionProfessionalId,
      isActive: true,
      assignedBy: { id: psychologyProfessionalId },
    });
    const team = await request(server)
      .get(url)
      .set('Authorization', bearer(psychologyToken))
      .expect(200);
    expect(team.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          professionalId: psychologyProfessionalId,
          isActive: true,
          professional: expect.objectContaining({
            id: psychologyProfessionalId,
            specialty: expect.objectContaining({ code: 'PSYCHOLOGY' }),
          }),
        }),
        expect.objectContaining({
          professionalId: nutritionProfessionalId,
          isActive: true,
          professional: expect.objectContaining({
            id: nutritionProfessionalId,
            specialty: expect.objectContaining({ code: 'NUTRITION' }),
          }),
        }),
      ]),
    );
    expect(await prisma.patient.count({ where: { tenantId, id: patientId } })).toBe(1);
    expect(await prisma.patient.count({ where: { tenantId } })).toBe(patientCountBeforeTeamWrites);

    const forbiddenRemove = await request(server)
      .delete(`${url}/${nutritionProfessionalId}`)
      .set('Authorization', bearer(psychologyToken))
      .expect(403);
    expect(forbiddenRemove.body.code).toBe('TEAM_ASSIGNMENT_FORBIDDEN');
    const unassignedPatientId = await createPatient('Unassigned');
    const unassignedUrl = teamUrl(unassignedPatientId);
    // Any clinic professional may read a patient's team; only changes need membership.
    const unassignedList = await request(server)
      .get(unassignedUrl)
      .set('Authorization', bearer(nutritionToken))
      .expect(200);
    expect(unassignedList.body).toEqual([]);
    const unassignedCandidates = await request(server)
      .get(`${unassignedUrl}/eligible`)
      .set('Authorization', bearer(nutritionToken))
      .expect(403);
    expect(unassignedCandidates.body.code).toBe('TEAM_ASSIGNMENT_FORBIDDEN');
    const unassignedRefer = await request(server)
      .put(`${unassignedUrl}/${psychologyProfessionalId}`)
      .set('Authorization', bearer(nutritionToken))
      .expect(403);
    expect(unassignedRefer.body.code).toBe('TEAM_ASSIGNMENT_FORBIDDEN');
    expect(
      await prisma.patientProfessional.count({ where: { patientId: unassignedPatientId } }),
    ).toBe(0);

    const assistantList = await request(server)
      .get(url)
      .set('Authorization', bearer(assistantToken))
      .expect(200);
    expect(assistantList.body).toHaveLength(2);
    const removed = await request(server)
      .delete(`${url}/${nutritionProfessionalId}`)
      .set('Authorization', bearer(assistantToken))
      .expect(200);
    expect(removed.body).toMatchObject({
      professionalId: nutritionProfessionalId,
      isActive: false,
    });
    expect(
      await prisma.patientProfessional.findUniqueOrThrow({
        where: { patientId_professionalId: { patientId, professionalId: nutritionProfessionalId } },
      }),
    ).toMatchObject({
      tenantId,
      patientId,
      professionalId: nutritionProfessionalId,
      isActive: false,
    });

    const foreignRoute = await request(server)
      .get(teamUrl(patientId, otherTenantId))
      .set('Authorization', bearer(adminToken))
      .expect(403);
    expect(foreignRoute.body.code).toBe('TENANT_SCOPE_VIOLATION');
    const unknownPatient = await request(server)
      .get(teamUrl(randomUUID()))
      .set('Authorization', bearer(adminToken))
      .expect(404);
    const foreignPatient = await request(server)
      .get(teamUrl(otherPatientId))
      .set('Authorization', bearer(adminToken))
      .expect(404);
    expect(foreignPatient.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(foreignPatient.body).toEqual(unknownPatient.body);
    const unknownProfessional = await request(server)
      .put(`${url}/${randomUUID()}`)
      .set('Authorization', bearer(adminToken))
      .expect(404);
    const foreignProfessional = await request(server)
      .put(`${url}/${otherProfessionalId}`)
      .set('Authorization', bearer(adminToken))
      .expect(404);
    expect(foreignProfessional.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(foreignProfessional.body).toEqual(unknownProfessional.body);
    for (const body of [foreignPatient.body, foreignProfessional.body]) {
      const safeBody = JSON.stringify(body);
      for (const foreignIdentity of [
        otherTenantId,
        otherPatientId,
        otherProfessionalId,
        `foreign-${suffix}@example.test`,
        `other-professional-${suffix}@example.test`,
        'Foreign',
      ]) {
        expect(safeBody).not.toContain(foreignIdentity);
      }
    }
    expect(await prisma.patientProfessional.count({ where: { patientId: otherPatientId } })).toBe(
      0,
    );
    expect(
      await prisma.patientProfessional.count({
        where: { patientId, professionalId: otherProfessionalId },
      }),
    ).toBe(0);
  });

  it('creates canonical appointments, blocks removal and preserves prior team members on reassignment', async () => {
    const server = app.getHttpServer();
    const patientId = await createPatient('Canonical');
    const url = teamUrl(patientId);
    const created = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(assistantToken))
      .send(appointmentInput(patientId, nutritionProfessionalId, nutritionId, 31))
      .expect(201);
    const appointmentId = created.body.id as string;
    expect(created.body).toMatchObject({
      patientId,
      professionalId: nutritionProfessionalId,
      psychologistId: nutritionProfessionalId,
      specialtyId: nutritionId,
      professional: { id: nutritionProfessionalId },
      psychologist: { id: nutritionProfessionalId },
      specialty: { id: nutritionId, code: 'NUTRITION' },
    });
    expect(
      await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    ).toMatchObject({
      tenantId,
      patientId,
      professionalId: nutritionProfessionalId,
      psychologistId: nutritionProfessionalId,
      specialtyId: nutritionId,
      status: 'SCHEDULED',
    });
    expect(
      await prisma.patientProfessional.findUnique({
        where: { patientId_professionalId: { patientId, professionalId: nutritionProfessionalId } },
      }),
    ).toMatchObject({
      isActive: true,
      tenantId,
      assignedById: (
        await prisma.user.findFirstOrThrow({
          where: { tenantId, email: `assistant-${suffix}@example.test` },
          select: { id: true },
        })
      ).id,
    });

    const conflict = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(assistantToken))
      .send(appointmentInput(patientId, nutritionProfessionalId, nutritionId, 31))
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'APPOINTMENT_CONFLICT',
      error: 'APPOINTMENT_CONFLICT',
    });
    const mismatch = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(assistantToken))
      .send(appointmentInput(patientId, nutritionProfessionalId, psychologyId, 32))
      .expect(422);
    expect(mismatch.body.code).toBe('PROFESSIONAL_SPECIALTY_MISMATCH');
    expect(await prisma.appointment.count({ where: { patientId } })).toBe(1);

    const blocked = await request(server)
      .delete(`${url}/${nutritionProfessionalId}`)
      .set('Authorization', bearer(assistantToken))
      .expect(409);
    expect(blocked.body.code).toBe('PROFESSIONAL_HAS_FUTURE_APPOINTMENTS');
    expect(blocked.body.details.appointments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: appointmentId,
          title: `Consultation 31`,
          status: 'SCHEDULED',
        }),
      ]),
    );
    expect(blocked.body.details.appointments[0]).not.toHaveProperty('description');

    const reassigned = await request(server)
      .patch(`${appointmentsUrl()}/${appointmentId}`)
      .set('Authorization', bearer(assistantToken))
      .send({ professionalId: psychologyProfessionalId, specialtyId: psychologyId })
      .expect(200);
    expect(reassigned.body).toMatchObject({
      id: appointmentId,
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
    });
    expect(
      await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    ).toMatchObject({
      tenantId,
      patientId,
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
      status: 'SCHEDULED',
    });
    const memberships = await prisma.patientProfessional.findMany({ where: { patientId } });
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ professionalId: nutritionProfessionalId, isActive: true }),
        expect.objectContaining({ professionalId: psychologyProfessionalId, isActive: true }),
      ]),
    );
    const removedNutrition = await request(server)
      .delete(`${url}/${nutritionProfessionalId}`)
      .set('Authorization', bearer(assistantToken))
      .expect(200);
    expect(removedNutrition.body.isActive).toBe(false);
    expect(
      await prisma.patientProfessional.findUniqueOrThrow({
        where: { patientId_professionalId: { patientId, professionalId: nutritionProfessionalId } },
      }),
    ).toMatchObject({
      tenantId,
      patientId,
      professionalId: nutritionProfessionalId,
      isActive: false,
    });
    const cancelled = await request(server)
      .post(`${appointmentsUrl()}/${appointmentId}/cancel`)
      .set('Authorization', bearer(assistantToken))
      .send({ reason: 'Reassigned consultation cancelled' })
      .expect(201);
    expect(cancelled.body).toMatchObject({ id: appointmentId, status: 'CANCELLED' });
    const removedPsychology = await request(server)
      .delete(`${url}/${psychologyProfessionalId}`)
      .set('Authorization', bearer(assistantToken))
      .expect(200);
    expect(removedPsychology.body.isActive).toBe(false);
    expect(
      await prisma.patientProfessional.findUniqueOrThrow({
        where: {
          patientId_professionalId: { patientId, professionalId: psychologyProfessionalId },
        },
      }),
    ).toMatchObject({
      tenantId,
      patientId,
      professionalId: psychologyProfessionalId,
      isActive: false,
    });
    expect(await prisma.patientProfessional.count({ where: { patientId, isActive: true } })).toBe(
      0,
    );
  });

  it('limits professional appointments while admin and assistant manage the full tenant agenda', async () => {
    const server = app.getHttpServer();
    const patientId = await createPatient('Scope');
    const outsiderPatientId = await createPatient('ScopeOutsider');
    await request(server)
      .put(`${teamUrl(patientId)}/${psychologyProfessionalId}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const own = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(psychologyToken))
      .send(appointmentInput(patientId, psychologyProfessionalId, psychologyId, 33))
      .expect(201);
    expect(own.body).toMatchObject({ patientId, professionalId: psychologyProfessionalId });
    const noMembership = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(nutritionToken))
      .send(appointmentInput(outsiderPatientId, nutritionProfessionalId, nutritionId, 34))
      .expect(403);
    expect(noMembership.body.code).toBe('TEAM_ASSIGNMENT_FORBIDDEN');
    const noColleague = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(psychologyToken))
      .send(appointmentInput(patientId, nutritionProfessionalId, nutritionId, 34))
      .expect(403);
    expect(noColleague.body.code).toBe('APPOINTMENT_FORBIDDEN');

    const colleague = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(adminToken))
      .send(appointmentInput(patientId, nutritionProfessionalId, nutritionId, 34))
      .expect(201);
    expect(colleague.body.professionalId).toBe(nutritionProfessionalId);
    const visible = await request(server)
      .get(`${appointmentsUrl()}/${colleague.body.id}`)
      .set('Authorization', bearer(psychologyToken))
      .expect(200);
    expect(visible.body.id).toBe(colleague.body.id);
    const list = await request(server)
      .get(`${appointmentsUrl()}?patientId=${patientId}`)
      .set('Authorization', bearer(psychologyToken))
      .expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([own.body.id, colleague.body.id]),
    );

    const ownUpdate = await request(server)
      .patch(`${appointmentsUrl()}/${own.body.id}`)
      .set('Authorization', bearer(psychologyToken))
      .send({ title: 'Own updated consultation' })
      .expect(200);
    expect(ownUpdate.body.title).toBe('Own updated consultation');
    const noReassignment = await request(server)
      .patch(`${appointmentsUrl()}/${own.body.id}`)
      .set('Authorization', bearer(psychologyToken))
      .send({ professionalId: nutritionProfessionalId, specialtyId: nutritionId })
      .expect(403);
    expect(noReassignment.body.code).toBe('APPOINTMENT_FORBIDDEN');
    const noColleagueUpdate = await request(server)
      .patch(`${appointmentsUrl()}/${colleague.body.id}`)
      .set('Authorization', bearer(psychologyToken))
      .send({ title: 'Forbidden edit' })
      .expect(403);
    expect(noColleagueUpdate.body.code).toBe('APPOINTMENT_FORBIDDEN');
    const noColleagueCancel = await request(server)
      .post(`${appointmentsUrl()}/${colleague.body.id}/cancel`)
      .set('Authorization', bearer(psychologyToken))
      .send({ reason: 'Forbidden cancellation' })
      .expect(403);
    expect(noColleagueCancel.body.code).toBe('APPOINTMENT_FORBIDDEN');
    const assistantUpdate = await request(server)
      .patch(`${appointmentsUrl()}/${colleague.body.id}`)
      .set('Authorization', bearer(assistantToken))
      .send({ title: 'Assistant updated consultation' })
      .expect(200);
    expect(assistantUpdate.body.title).toBe('Assistant updated consultation');
    const adminUpdate = await request(server)
      .patch(`${appointmentsUrl()}/${colleague.body.id}`)
      .set('Authorization', bearer(adminToken))
      .send({ title: 'Admin updated consultation' })
      .expect(200);
    expect(adminUpdate.body.title).toBe('Admin updated consultation');
    const ownCancelled = await request(server)
      .post(`${appointmentsUrl()}/${own.body.id}/cancel`)
      .set('Authorization', bearer(psychologyToken))
      .send({ reason: 'Professional cancellation' })
      .expect(201);
    expect(ownCancelled.body.status).toBe('CANCELLED');
    const colleagueCancelled = await request(server)
      .post(`${appointmentsUrl()}/${colleague.body.id}/cancel`)
      .set('Authorization', bearer(adminToken))
      .send({ reason: 'Admin cancellation' })
      .expect(201);
    expect(colleagueCancelled.body.status).toBe('CANCELLED');
    expect(await prisma.appointment.count({ where: { patientId, status: 'CANCELLED' } })).toBe(2);
  });

  it('accepts legacy appointment references and keeps multiple active patient assignments', async () => {
    const server = app.getHttpServer();
    const patientId = await createPatient('Legacy');
    const created = await request(server)
      .post(appointmentsUrl())
      .set('Authorization', bearer(adminToken))
      .send({
        patientId,
        psychologistId: psychologyProfessionalId,
        startTime: futureAt(35),
        duration: 60,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
      professional: { id: psychologyProfessionalId },
      psychologist: { id: psychologyProfessionalId },
    });
    expect(
      await prisma.appointment.findUniqueOrThrow({ where: { id: created.body.id } }),
    ).toMatchObject({
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
    });
    const changed = await request(server)
      .patch(`/api/v1/tenants/${tenantId}/patients/${patientId}`)
      .set('Authorization', bearer(adminToken))
      .send({ assignedPsychologistId: nutritionProfessionalId })
      .expect(200);
    expect(changed.body.assignedPsychologistId).toBe(nutritionProfessionalId);
    const changedBack = await request(server)
      .patch(`/api/v1/tenants/${tenantId}/patients/${patientId}`)
      .set('Authorization', bearer(adminToken))
      .send({ assignedPsychologistId: psychologyProfessionalId })
      .expect(200);
    expect(changedBack.body.assignedPsychologistId).toBe(psychologyProfessionalId);
    const active = await prisma.patientProfessional.findMany({
      where: { patientId, isActive: true },
    });
    expect(active.map((row) => row.professionalId).sort()).toEqual(
      [psychologyProfessionalId, nutritionProfessionalId].sort(),
    );
    const cleared = await request(server)
      .patch(`/api/v1/tenants/${tenantId}/patients/${patientId}`)
      .set('Authorization', bearer(adminToken))
      .send({ assignedPsychologistId: null })
      .expect(200);
    expect(cleared.body.assignedPsychologistId).toBeNull();
    expect(await prisma.patientProfessional.count({ where: { patientId, isActive: true } })).toBe(
      2,
    );
  });

  it('serializes duplicate assignments and appointments with appointment-versus-removal safety', async () => {
    const server = app.getHttpServer();
    const patientId = await createPatient('Concurrent');
    const url = `${teamUrl(patientId)}/${psychologyProfessionalId}`;
    const assignmentResponses = await Promise.all([
      request(server).put(url).set('Authorization', bearer(adminToken)),
      request(server).put(url).set('Authorization', bearer(adminToken)),
    ]);
    expect(assignmentResponses.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(assignmentResponses[0].body.id).toBe(assignmentResponses[1].body.id);
    expect(
      await prisma.patientProfessional.count({
        where: { patientId, professionalId: psychologyProfessionalId },
      }),
    ).toBe(1);

    const input = appointmentInput(patientId, psychologyProfessionalId, psychologyId, 36);
    const appointmentResponses = await Promise.all([
      request(server).post(appointmentsUrl()).set('Authorization', bearer(adminToken)).send(input),
      request(server).post(appointmentsUrl()).set('Authorization', bearer(adminToken)).send(input),
    ]);
    expect(appointmentResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(appointmentResponses.find((response) => response.status === 409)?.body.code).toBe(
      'APPOINTMENT_CONFLICT',
    );
    const duplicateRows = await prisma.appointment.findMany({ where: { patientId } });
    expect(duplicateRows).toHaveLength(1);
    expect(duplicateRows[0]).toMatchObject({
      tenantId,
      patientId,
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
      startTime: new Date(input.startTime),
      endTime: new Date(new Date(input.startTime).getTime() + input.duration * 60 * 1000),
      status: 'SCHEDULED',
    });

    const racingPatientId = await createPatient('RacingRemoval');
    const racingUrl = `${teamUrl(racingPatientId)}/${nutritionProfessionalId}`;
    await request(server).put(racingUrl).set('Authorization', bearer(adminToken)).expect(200);
    const [appointment, removal] = await Promise.all([
      request(server)
        .post(appointmentsUrl())
        .set('Authorization', bearer(adminToken))
        .send(appointmentInput(racingPatientId, nutritionProfessionalId, nutritionId, 37)),
      request(server).delete(racingUrl).set('Authorization', bearer(adminToken)),
    ]);
    expect(appointment.status).toBe(201);
    expect([200, 409]).toContain(removal.status);
    if (removal.status === 409) {
      expect(removal.body.code).toBe('PROFESSIONAL_HAS_FUTURE_APPOINTMENTS');
    } else {
      expect(removal.body.isActive).toBe(false);
    }
    expect(
      await prisma.patientProfessional.findUniqueOrThrow({
        where: {
          patientId_professionalId: {
            patientId: racingPatientId,
            professionalId: nutritionProfessionalId,
          },
        },
      }),
    ).toMatchObject({ tenantId, isActive: true });
    expect(
      await prisma.appointment.count({
        where: { id: appointment.body.id, patientId: racingPatientId },
      }),
    ).toBe(1);
  });

  it('reconciles legacy pointers and appointments, preserving historical specialty and rejecting cross-tenant pointers', async () => {
    const patientId = await createPatient('Catchup');
    await prisma.patient.update({
      where: { id: patientId },
      data: { assignedPsychologistId: psychologyProfessionalId },
    });
    const legacyStart = new Date(futureAt(38));
    const mismatchedStart = new Date(futureAt(39));
    const legacy = await prisma.appointment.create({
      data: {
        tenantId,
        patientId,
        psychologistId: psychologyProfessionalId,
        professionalId: null,
        specialtyId: null,
        startTime: legacyStart,
        endTime: new Date(legacyStart.getTime() + 60 * 60 * 1000),
        duration: 60,
      },
    });
    const mismatched = await prisma.appointment.create({
      data: {
        tenantId,
        patientId,
        psychologistId: psychologyProfessionalId,
        professionalId: nutritionProfessionalId,
        specialtyId: nutritionId,
        startTime: mismatchedStart,
        endTime: new Date(mismatchedStart.getTime() + 60 * 60 * 1000),
        duration: 60,
      },
    });
    const summary = await reconcilePatientTeamAppointments(prisma);
    expect(summary.unresolvedAppointments).toBe(0);
    expect(summary.appointmentsRepaired).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.patientProfessional.findUnique({
        where: {
          patientId_professionalId: { patientId, professionalId: psychologyProfessionalId },
        },
      }),
    ).toMatchObject({ tenantId, isActive: true, assignedById: null });
    expect(await prisma.appointment.findUnique({ where: { id: legacy.id } })).toMatchObject({
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: psychologyId,
    });
    expect(await prisma.appointment.findUnique({ where: { id: mismatched.id } })).toMatchObject({
      professionalId: psychologyProfessionalId,
      psychologistId: psychologyProfessionalId,
      specialtyId: nutritionId,
    });
    const repeated = await reconcilePatientTeamAppointments(prisma);
    expect(repeated).toMatchObject({ appointmentsRepaired: 0, unresolvedAppointments: 0 });
    expect(repeated.assignmentsAfter).toBe(repeated.assignmentsBefore);

    const foreignPatientId = await createPatient(
      'CrossTenantCatchup',
      otherTenantId,
      otherAdminToken,
    );
    const readTeamSnapshot = () =>
      prisma.patientProfessional.findMany({
        select: {
          id: true,
          tenantId: true,
          patientId: true,
          professionalId: true,
          assignedAt: true,
          assignedById: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
      });
    const readAppointmentSnapshot = () =>
      prisma.appointment.findMany({
        select: {
          id: true,
          tenantId: true,
          patientId: true,
          psychologistId: true,
          professionalId: true,
          specialtyId: true,
          startTime: true,
          endTime: true,
          duration: true,
          status: true,
          title: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
      });
    let guardAppointmentId: string | undefined;
    let assertionFailed = false;
    try {
      await prisma.patient.update({
        where: { id: foreignPatientId },
        data: { assignedPsychologistId: psychologyProfessionalId },
      });
      const guardStart = new Date(futureAt(40));
      const guardAppointment = await prisma.appointment.create({
        data: {
          tenantId,
          patientId,
          psychologistId: psychologyProfessionalId,
          professionalId: null,
          specialtyId: null,
          startTime: guardStart,
          endTime: new Date(guardStart.getTime() + 60 * 60 * 1000),
          duration: 60,
        },
      });
      guardAppointmentId = guardAppointment.id;
      const teamBefore = await readTeamSnapshot();
      const appointmentsBefore = await readAppointmentSnapshot();
      expect(appointmentsBefore.map((row) => row.id)).toEqual(
        expect.arrayContaining([legacy.id, mismatched.id, guardAppointmentId]),
      );
      expect(guardAppointment).toMatchObject({
        tenantId,
        patientId,
        psychologistId: psychologyProfessionalId,
        professionalId: null,
        specialtyId: null,
      });
      await expect(reconcilePatientTeamAppointments(prisma)).rejects.toThrow(
        'PATIENT_TEAM_CROSS_TENANT',
      );
      expect(await readTeamSnapshot()).toEqual(teamBefore);
      expect(await readAppointmentSnapshot()).toEqual(appointmentsBefore);
      expect(
        await prisma.appointment.findUniqueOrThrow({ where: { id: guardAppointmentId } }),
      ).toMatchObject({
        tenantId,
        patientId,
        psychologistId: psychologyProfessionalId,
        professionalId: null,
        specialtyId: null,
      });
    } catch (error) {
      assertionFailed = true;
      throw error;
    } finally {
      let cleanupError: unknown;
      for (const cleanup of [
        ...(guardAppointmentId
          ? [() => prisma.appointment.delete({ where: { id: guardAppointmentId } })]
          : []),
        () =>
          prisma.patient.update({
            where: { id: foreignPatientId },
            data: { assignedPsychologistId: null },
          }),
        () => prisma.patient.delete({ where: { id: foreignPatientId } }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError && !assertionFailed) throw cleanupError;
    }
  });
});
