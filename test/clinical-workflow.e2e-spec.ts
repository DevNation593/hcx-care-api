import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-storage-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { PlatformRolePermissionsService } from './../src/platform/platform-role-permissions.service';
import { createPlatformAdmin } from './../prisma/create-platform-admin';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

const PDF = Buffer.from('%PDF-1.4\n% hemograma de prueba, texto reconocible\n%%EOF\n');

/** Every file under a directory, however deep. */
function storedFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const target = join(directory, name);
    return statSync(target).isDirectory() ? storedFiles(target) : [target];
  });
}

describe('Clinical workflow: branch, appointment, encounter, records and files (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let platformAdminId: string;
  let tenantId: string;
  let otherTenantId: string;
  let specialtyId: string;
  let professionalId: string;
  let colleagueId: string;
  let patientId: string;
  let mainBranchId: string;
  let northBranchId: string;
  let appointmentId: string;
  let encounterId: string;
  let fileId: string;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const patientUrl = (suffix: string) => `${base()}/patients/${patientId}/${suffix}`;

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

  const nextWeekday = (hour: number) => {
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    date.setUTCHours(hour, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7));
    return date.toISOString();
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
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    platformAdminId = (
      await createPlatformAdmin(prisma, {
        email: 'platform-clinical-e2e@example.test',
        password: TEST_PASSWORD,
        firstName: 'Platform',
        lastName: 'Admin',
      })
    ).userId;
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: {
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;

    professionalId = (await member(tenantId, 'pro@tenant.test', 'PROFESIONAL')).id;
    colleagueId = (await member(tenantId, 'colleague@tenant.test', 'PROFESIONAL')).id;
    await member(tenantId, 'assistant@tenant.test', 'ASISTENTE');
    await member(otherTenantId, 'outsider@tenant.test', 'PROFESIONAL');

    tokens.master = await login('admin+1@tenant.test');
    tokens.pro = await login('pro@tenant.test');
    tokens.colleague = await login('colleague@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');
    tokens.outsider = await login('outsider@tenant.test');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('patient identification', () => {
    it('registers a patient with an identification and finds them by it', async () => {
      const created = await request(server())
        .post(`${base()}/patients`)
        .set(as('assistant'))
        .send({
          firstName: 'Ana',
          lastName: 'Paciente',
          dateOfBirth: '1990-05-10',
          identificationType: 'PASSPORT',
          identificationNumber: 'AB123456',
        })
        .expect(201);
      patientId = created.body.id;
      expect(created.body).toMatchObject({
        identificationType: 'PASSPORT',
        identificationNumber: 'AB123456',
      });

      const found = await request(server())
        .get(`${base()}/patients?search=AB1234`)
        .set(as('assistant'))
        .expect(200);
      const rows = Array.isArray(found.body) ? found.body : found.body.data;
      expect(rows.map((row: { id: string }) => row.id)).toEqual([patientId]);
    });

    it('refuses a second patient with the same identification, and a minor without a guardian', async () => {
      const duplicate = await request(server())
        .post(`${base()}/patients`)
        .set(as('assistant'))
        .send({
          firstName: 'Otra',
          lastName: 'Persona',
          identificationType: 'PASSPORT',
          identificationNumber: 'ab123456',
        })
        .expect(409);
      expect(duplicate.body.code).toBe('PATIENT_IDENTIFICATION_TAKEN');

      const minor = await request(server())
        .post(`${base()}/patients`)
        .set(as('assistant'))
        .send({ firstName: 'Niño', lastName: 'Menor', dateOfBirth: '2020-01-01' })
        .expect(422);
      expect(minor.body.code).toBe('PATIENT_GUARDIAN_REQUIRED');

      // The same identification is free in another clinic.
      await request(server())
        .post(`${base(otherTenantId)}/patients`)
        .set(as('outsider'))
        .send({
          firstName: 'Ana',
          lastName: 'Otra clínica',
          identificationType: 'PASSPORT',
          identificationNumber: 'AB123456',
        })
        .expect(201);
    });
  });

  describe('branches', () => {
    it('starts with a main branch and lets the account holder add another with its professionals', async () => {
      const initial = await request(server()).get(`${base()}/branches`).set(as('pro')).expect(200);
      expect(initial.body).toHaveLength(1);
      expect(initial.body[0]).toMatchObject({ isMain: true, isActive: true, professionalIds: [] });
      mainBranchId = initial.body[0].id;

      await request(server())
        .post(`${base()}/branches`)
        .set(as('pro'))
        .send({ name: 'Sede Norte' })
        .expect(403);
      const north = await request(server())
        .post(`${base()}/branches`)
        .set(as('master'))
        .send({ name: 'Sede Norte', city: 'Quito', rooms: ['Consultorio 1'] })
        .expect(201);
      northBranchId = north.body.id;

      const assigned = await request(server())
        .put(`${base()}/branches/${northBranchId}/professionals`)
        .set(as('master'))
        .send({ userIds: [professionalId] })
        .expect(200);
      expect(assigned.body.professionalIds).toEqual([professionalId]);

      const repeated = await request(server())
        .post(`${base()}/branches`)
        .set(as('master'))
        .send({ name: 'sede norte' })
        .expect(409);
      expect(repeated.body.code).toBe('BRANCH_NAME_TAKEN');
    });

    it('books a professional only in their branches and filters the agenda by branch', async () => {
      await request(server())
        .put(`${base()}/patients/${patientId}/team/${professionalId}`)
        .set(as('master'))
        .expect(200);
      const input = {
        patientId,
        professionalId,
        specialtyId,
        startTime: nextWeekday(15),
        duration: 60,
        title: 'Primera consulta',
      };

      const wrongBranch = await request(server())
        .post(`${base()}/appointments`)
        .set(as('assistant'))
        .send({ ...input, branchId: mainBranchId })
        .expect(409);
      expect(wrongBranch.body.code).toBe('PROFESSIONAL_NOT_IN_BRANCH');

      const booked = await request(server())
        .post(`${base()}/appointments`)
        .set(as('assistant'))
        .send({ ...input, branchId: northBranchId })
        .expect(201);
      appointmentId = booked.body.id;
      expect(booked.body.branchId).toBe(northBranchId);

      const ids = async (branchId: string) => {
        const response = await request(server())
          .get(`${base()}/appointments?branchId=${branchId}&professionalId=${professionalId}`)
          .set(as('assistant'))
          .expect(200);
        const rows = Array.isArray(response.body) ? response.body : response.body.data;
        return rows.map((row: { id: string }) => row.id);
      };
      expect(await ids(northBranchId)).toEqual([appointmentId]);
      expect(await ids(mainBranchId)).toEqual([]);

      // An assistant sees one professional at a time; the calendar of everyone is the master's.
      const everyone = await request(server())
        .get(`${base()}/appointments?branchId=${northBranchId}`)
        .set(as('assistant'))
        .expect(400);
      expect(everyone.body.code).toBe('APPOINTMENT_PROFESSIONAL_REQUIRED');
      const global = await request(server())
        .get(`${base()}/appointments?branchId=${northBranchId}`)
        .set(as('master'))
        .expect(200);
      expect(global.body.map((row: { id: string }) => row.id)).toEqual([appointmentId]);
    });
  });

  describe('encounter', () => {
    it('starts from the appointment, which becomes in progress', async () => {
      const started = await request(server())
        .post(patientUrl('encounters'))
        .set(as('pro'))
        .send({ encounterType: 'FIRST_VISIT', reason: 'Ansiedad de dos semanas', appointmentId })
        .expect(201);
      encounterId = started.body.id;
      expect(started.body).toMatchObject({
        status: 'OPEN',
        reason: 'Ansiedad de dos semanas',
        appointmentId,
        branchId: northBranchId,
      });

      const appointment = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.status).toBe('IN_PROGRESS');
      // The reason is stored encrypted.
      const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(row.reason).not.toContain('Ansiedad');
    });

    it('validates a record against its module and raises its alerts', async () => {
      const invalid = await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({ moduleKey: 'general.vital-signs', data: { oxygenSaturation: 300 }, encounterId })
        .expect(422);
      expect(invalid.body.code).toBe('CLINICAL_RECORD_INVALID');
      expect(invalid.body.details).toEqual([
        expect.objectContaining({ field: 'oxygenSaturation' }),
      ]);

      const created = await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({
          moduleKey: 'general.vital-signs',
          data: { weightKg: 72, heightCm: 170, oxygenSaturation: 85 },
          encounterId,
        })
        .expect(201);
      expect(created.body).toMatchObject({ encounterId, data: { bmi: 24.9 } });

      const listed = await request(server())
        .get(patientUrl('specialty-records'))
        .set(as('colleague'))
        .expect(200);
      const record = listed.body.find((row: { id: string }) => row.id === created.body.id);
      expect(record.alerts).toEqual([
        expect.objectContaining({ level: 'critical', message: expect.stringContaining('90') }),
      ]);
    });

    it('takes a note and a file written during the encounter', async () => {
      const note = await request(server())
        .post(`${base()}/clinical-notes`)
        .set(as('pro'))
        .send({ patientId, content: 'Nota de la primera consulta', encounterId })
        .expect(201);
      expect(note.body.encounterId).toBe(encounterId);

      const uploaded = await request(server())
        .post(patientUrl('files'))
        .set(as('pro'))
        .field('category', 'EXAMEN')
        .field('description', 'Hemograma')
        .field('encounterId', encounterId)
        .attach('file', PDF, { filename: 'hemograma.pdf', contentType: 'application/pdf' })
        .expect(201);
      fileId = uploaded.body.id;
      expect(uploaded.body).toMatchObject({
        fileName: 'hemograma.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        encounterId,
      });
    });

    it('closes with a summary, completes the appointment and takes no more records', async () => {
      const closed = await request(server())
        .post(patientUrl(`encounters/${encounterId}/close`))
        .set(as('pro'))
        .send({ summary: 'Control en 7 días' })
        .expect(201);
      expect(closed.body).toMatchObject({ status: 'CLOSED', summary: 'Control en 7 días' });
      const appointment = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.status).toBe('COMPLETED');

      await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({ moduleKey: 'general.vital-signs', data: { weightKg: 70 }, encounterId })
        .expect(409);
    });

    it('appears in the clinical timeline with its records', async () => {
      const timeline = await request(server())
        .get(patientUrl('clinical-timeline'))
        .set(as('colleague'))
        .expect(200);
      const entries = Array.isArray(timeline.body) ? timeline.body : timeline.body.items;
      const types = entries.map((entry: { type: string }) => entry.type);
      expect(types).toEqual(expect.arrayContaining(['ENCOUNTER', 'CLINICAL_NOTE']));
    });
  });

  describe('patient files', () => {
    it('stores the bytes encrypted and returns them intact to a professional', async () => {
      const onDisk = storedFiles(storageRoot);
      expect(onDisk).toHaveLength(1);
      const stored = readFileSync(onDisk[0]);
      expect(stored.subarray(0, 4).toString()).toBe('ENC1');
      expect(stored.includes(Buffer.from('hemograma'))).toBe(false);
      const row = await prisma.patientFile.findUniqueOrThrow({ where: { id: fileId } });
      expect(row.fileName).not.toContain('hemograma');

      const download = await request(server())
        .get(patientUrl(`files/${fileId}/download`))
        .set(as('colleague'))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(Buffer.compare(download.body, PDF)).toBe(0);
    });

    it('refuses a file whose content is not what it claims', async () => {
      const response = await request(server())
        .post(patientUrl('files'))
        .set(as('pro'))
        .field('category', 'IMAGEN')
        .attach('file', Buffer.from('esto no es una imagen'), {
          filename: 'radiografia.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(response.body.code).toBe('PATIENT_FILE_INVALID');
    });

    it('is closed to the assistant, the account holder without a profile and another clinic', async () => {
      await request(server()).get(patientUrl('files')).set(as('assistant')).expect(403);
      await request(server()).get(patientUrl('files')).set(as('master')).expect(403);
      await request(server())
        .get(patientUrl(`files/${fileId}/download`))
        .set(as('outsider'))
        .expect(403);
    });

    it('shows the account holder the usage with the file name masked', async () => {
      const usage = await request(server())
        .get(`${base()}/storage/breakdown`)
        .set(as('master'))
        .expect(200);
      expect(JSON.stringify(usage.body)).toContain(String(PDF.length));

      const files = await request(server())
        .get(`${base()}/storage/files`)
        .set(as('master'))
        .expect(200);
      expect(files.body).toHaveLength(1);
      expect(JSON.stringify(files.body)).not.toContain('hemograma');
    });

    it('lets only the uploader remove it, with a reason', async () => {
      await request(server())
        .delete(patientUrl(`files/${fileId}`))
        .set(as('colleague'))
        .send({ reason: 'No es mío' })
        .expect(403);
      await request(server())
        .delete(patientUrl(`files/${fileId}`))
        .set(as('pro'))
        .send({})
        .expect(400);
      await request(server())
        .delete(patientUrl(`files/${fileId}`))
        .set(as('pro'))
        .send({ reason: 'Paciente equivocado' })
        .expect(200);

      const listed = await request(server()).get(patientUrl('files')).set(as('pro')).expect(200);
      expect(listed.body).toEqual([]);
      const audit = await prisma.auditLog.findMany({
        where: { tenantId, entity: 'PATIENT_FILE', entityId: fileId },
      });
      expect(audit.map((entry) => entry.action).sort()).toEqual(
        expect.arrayContaining(['CREATE', 'DELETE', 'READ']),
      );
    });
  });

  describe('permissions', () => {
    it('restricts an action for the entire professional role, then restores it', async () => {
      const roles = app.get(PlatformRolePermissionsService);
      const original = await roles.describe(tenantId, 'PROFESIONAL');
      const originalAllowed = original.effective;
      await request(server())
        .put(`${base()}/users/${professionalId}/permissions`)
        .set(as('master'))
        .send({ revoked: ['clinical_records.create'] })
        .expect(404);
      await request(server())
        .put(`/api/v1/platform/tenants/${tenantId}/roles/PROFESIONAL/permissions`)
        .set(as('master'))
        .send({ allowed: originalAllowed })
        .expect(403);
      const restricted = await roles.replace(
        tenantId,
        'PROFESIONAL',
        platformAdminId,
        originalAllowed.filter((key: string) => key !== 'clinical_records.create'),
      );
      expect(restricted.effective).not.toContain('clinical_records.create');
      expect(restricted.effective).toContain('clinical_records.view');

      const denied = await request(server())
        .post(patientUrl('encounters'))
        .set(as('pro'))
        .send({ encounterType: 'CONTROL', reason: 'Control' })
        .expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
      // Reading is a different permission and still works.
      await request(server()).get(patientUrl('encounters')).set(as('pro')).expect(200);
      // The colleague has the same restriction.
      const colleagueDenied = await request(server())
        .post(patientUrl('encounters'))
        .set(as('colleague'))
        .send({ encounterType: 'CONTROL', reason: 'Control del colega' })
        .expect(403);
      expect(colleagueDenied.body.code).toBe('PERMISSION_DENIED');

      await roles.replace(tenantId, 'PROFESIONAL', platformAdminId, originalAllowed);
      const other = await request(server())
        .post(patientUrl('encounters'))
        .set(as('colleague'))
        .send({ encounterType: 'CONTROL', reason: 'Control del colega' })
        .expect(201);
      await request(server())
        .delete(patientUrl(`encounters/${other.body.id}`))
        .set(as('colleague'))
        .send({ reason: 'Solo era una prueba' })
        .expect(200);

      const mine = await request(server())
        .get(`${base()}/users/me/permissions`)
        .set(as('pro'))
        .expect(200);
      expect(mine.body.effective).toContain('clinical_records.create');
    });

    it('gives invoices to the assistant role only through platform configuration', async () => {
      const roles = app.get(PlatformRolePermissionsService);
      const originalAllowed = (await roles.describe(tenantId, 'ASISTENTE')).effective;
      const invoices = `${base()}/billing/invoices`;
      const assistant = await prisma.user.findFirstOrThrow({
        where: { tenantId, email: 'assistant@tenant.test' },
      });
      await request(server()).get(invoices).set(as('assistant')).expect(403);

      await request(server())
        .put(`${base()}/users/${assistant.id}/permissions`)
        .set(as('master'))
        .send({ revoked: [], granted: ['billing.view'] })
        .expect(404);
      await expect(
        roles.replace(tenantId, 'ASISTENTE', platformAdminId, [
          ...originalAllowed,
          'clinical_records.view',
        ]),
      ).rejects.toThrow();
      const granted = await roles.replace(tenantId, 'ASISTENTE', platformAdminId, [
        ...originalAllowed,
        'billing.view',
      ]);
      expect(granted.effective).toContain('billing.view');

      await request(server()).get(invoices).set(as('assistant')).expect(200);

      await roles.replace(tenantId, 'ASISTENTE', platformAdminId, originalAllowed);
      await request(server()).get(invoices).set(as('assistant')).expect(403);
    });
  });

  describe('forms designed by the clinic', () => {
    it('validates the records of a custom form against the version they were written under', async () => {
      const schema = {
        sections: [
          {
            key: 'injury',
            title: 'Lesión',
            fields: [
              {
                key: 'injuryType',
                label: 'Tipo de lesión',
                type: 'select',
                required: true,
                options: [
                  { value: 'TRAUMATICA', label: 'Traumática' },
                  { value: 'DEPORTIVA', label: 'Deportiva' },
                ],
              },
            ],
          },
        ],
      };
      await request(server())
        .post(`${base()}/form-definitions`)
        .set(as('pro'))
        .send({ name: 'Ficha de lesión', schema })
        .expect(403);
      const form = await request(server())
        .post(`${base()}/form-definitions`)
        .set(as('master'))
        .send({ name: 'Ficha de lesión', schema })
        .expect(201);

      const modules = await request(server())
        .get(`${base()}/clinical-modules`)
        .set(as('pro'))
        .expect(200);
      const moduleKey = `custom.${form.body.id}`;
      expect(modules.body.map((entry: { moduleKey: string }) => entry.moduleKey)).toEqual(
        expect.arrayContaining(['general.vital-signs', moduleKey]),
      );

      await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({ moduleKey, data: { injuryType: 'OTRA' } })
        .expect(422);
      const record = await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({ moduleKey, data: { injuryType: 'DEPORTIVA' } })
        .expect(201);
      expect(record.body).toMatchObject({ moduleKey, schemaVersion: 1 });
    });
  });

  describe('catalogs', () => {
    it('searches diagnoses and keeps a medication catalog per clinic', async () => {
      // The classification is shared by every clinic and survives the cleanup between suites.
      await prisma.diagnosisCode.deleteMany();
      await prisma.diagnosisCode.create({
        data: { system: 'CIE10', code: 'F41.1', description: 'Trastorno de ansiedad generalizada' },
      });
      const byCode = await request(server())
        .get(`${base()}/diagnosis-codes?search=F41`)
        .set(as('pro'))
        .expect(200);
      expect(byCode.body).toEqual([expect.objectContaining({ code: 'F41.1' })]);
      const byText = await request(server())
        .get(`${base()}/diagnosis-codes?search=ansiedad`)
        .set(as('pro'))
        .expect(200);
      expect(byText.body).toHaveLength(1);

      await request(server())
        .post(`${base()}/medications`)
        .set(as('pro'))
        .send({ commercialName: 'Sertralina', presentation: 'Tableta 50 mg' })
        .expect(201);
      const mine = await request(server())
        .get(`${base()}/medications?search=sertra`)
        .set(as('pro'))
        .expect(200);
      expect(mine.body).toHaveLength(1);
      const theirs = await request(server())
        .get(`${base(otherTenantId)}/medications?search=sertra`)
        .set(as('outsider'))
        .expect(200);
      expect(theirs.body).toEqual([]);
    });
  });

  describe('activity report', () => {
    it('counts appointments and encounters by branch for the account holder only', async () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const url = `${base()}/reports/activity?from=${from}&to=${to}`;
      await request(server()).get(url).set(as('pro')).expect(403);

      const report = await request(server()).get(url).set(as('master')).expect(200);
      // The encounter removed by the colleague is not counted.
      expect(report.body.totals).toEqual({
        appointments: 1,
        completed: 1,
        cancelled: 0,
        noShow: 0,
        encounters: 1,
      });
      expect(report.body.encountersByType).toEqual({ FIRST_VISIT: 1 });
      expect(report.body.branches).toEqual([
        expect.objectContaining({ branchId: mainBranchId, appointments: 0, encounters: 0 }),
        expect.objectContaining({ branchId: northBranchId, appointments: 1, encounters: 1 }),
      ]);
      expect(report.body.professionals).toEqual([
        expect.objectContaining({ professionalId, appointments: 1, completed: 1, encounters: 1 }),
      ]);

      const onlyMain = await request(server())
        .get(`${url}&branchId=${mainBranchId}`)
        .set(as('master'))
        .expect(200);
      expect(onlyMain.body.totals.appointments).toBe(0);
      await request(server())
        .get(`${base()}/reports/activity?from=${to}&to=${from}`)
        .set(as('master'))
        .expect(400);
    });
  });

  describe('documents', () => {
    // 1x1 PNG, as a signature pad would send it.
    const signature =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    let consentId: string;
    let code: string;

    it('keeps the templates of the clinic, written by the account holder', async () => {
      const template = {
        moduleKey: 'general.consents',
        name: 'Tratamiento psicológico',
        title: 'Consentimiento para tratamiento psicológico',
        body: 'Yo, {{paciente}}, con identificación {{identificacion}}, acepto el tratamiento.',
      };
      await request(server())
        .post(`${base()}/document-templates`)
        .set(as('pro'))
        .send(template)
        .expect(403);
      const unknown = await request(server())
        .post(`${base()}/document-templates`)
        .set(as('master'))
        .send({ ...template, body: 'Vive en {{direccion}}.' })
        .expect(400);
      expect(unknown.body.code).toBe('TEMPLATE_VARIABLE_UNKNOWN');
      const created = await request(server())
        .post(`${base()}/document-templates`)
        .set(as('master'))
        .send(template)
        .expect(201);
      await request(server())
        .post(`${base()}/document-templates`)
        .set(as('master'))
        .send(template)
        .expect(409);

      const forProfessional = () =>
        request(server())
          .get(`${base()}/document-templates?moduleKey=general.consents`)
          .set(as('pro'))
          .expect(200);
      expect((await forProfessional()).body).toEqual([
        expect.objectContaining({ id: created.body.id, name: 'Tratamiento psicológico' }),
      ]);
      // Another clinic has its own.
      const theirs = await request(server())
        .get(`${base(otherTenantId)}/document-templates`)
        .set(as('outsider'))
        .expect(200);
      expect(theirs.body).toEqual([]);

      await request(server())
        .patch(`${base()}/document-templates/${created.body.id}`)
        .set(as('master'))
        .send({ isActive: false })
        .expect(200);
      expect((await forProfessional()).body).toEqual([]);
    });

    it('stores a consent with the signature drawn by whoever accepts it', async () => {
      const consent = {
        title: 'Consentimiento para tratamiento psicológico',
        body: 'Acepto el tratamiento.',
        acceptedBy: 'PACIENTE',
        signerName: 'Ana Paciente',
        accepted: true,
      };
      const forged = await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({
          moduleKey: 'general.consents',
          data: { ...consent, signerSignature: 'data:image/png;base64,PHN2Zz4=' },
        })
        .expect(422);
      expect(forged.body.details).toEqual([expect.objectContaining({ field: 'signerSignature' })]);

      const created = await request(server())
        .post(patientUrl('specialty-records'))
        .set(as('pro'))
        .send({ moduleKey: 'general.consents', data: { ...consent, signerSignature: signature } })
        .expect(201);
      consentId = created.body.id;
      expect(created.body.data.signerSignature).toBe(signature);
      expect(created.body.verificationCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      code = created.body.verificationCode;

      // The signature is clinical content: encrypted at rest like the rest of the record.
      const row = await prisma.specialtyRecord.findUniqueOrThrow({ where: { id: consentId } });
      expect(JSON.stringify(row.data)).not.toContain('iVBORw0KGgo');
    });

    it('saves the document as a PDF among the files of the patient', async () => {
      await request(server())
        .post(patientUrl(`specialty-records/${consentId}/document`))
        .set(as('assistant'))
        .expect(403);
      const issued = await request(server())
        .post(patientUrl(`specialty-records/${consentId}/document`))
        .set(as('colleague'))
        .expect(201);
      expect(issued.body).toMatchObject({
        category: 'CONSENTIMIENTO',
        mimeType: 'application/pdf',
        uploadedById: colleagueId,
      });
      expect(issued.body.fileName).toMatch(/^consentimiento-informado-\d{4}-\d{2}-\d{2}\.pdf$/);
      expect(issued.body.description).toContain('Código de verificación');

      const download = await request(server())
        .get(patientUrl(`files/${issued.body.id}/download`))
        .set(as('pro'))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(download.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(download.body.length).toBe(issued.body.sizeBytes);
    });

    it('lets anyone holding the code check the document without reading it', async () => {
      const formatted = code.match(/.{4}/g)!.join('-').toLowerCase();
      const valid = await request(server())
        .get(`/api/v1/public/documents/${formatted}`)
        .expect(200);
      expect(valid.body).toMatchObject({
        status: 'VALID',
        documentType: 'Consentimiento informado',
        clinic: 'Tenant 1 Clinic',
        professional: { name: 'PROFESIONAL Member' },
        patientInitials: 'A. P.',
        correctedAt: null,
      });
      // Nothing of the patient beyond the initials, nothing of the content.
      const text = JSON.stringify(valid.body);
      expect(text).not.toContain('Paciente');
      expect(text).not.toContain('Acepto el tratamiento');
      expect(text).not.toContain('iVBORw0KGgo');

      await request(server()).get('/api/v1/public/documents/0000-0000-0000-0000').expect(404);
      await request(server()).get('/api/v1/public/documents/not-a-code').expect(404);

      await request(server())
        .delete(patientUrl(`specialty-records/${consentId}`))
        .set(as('pro'))
        .send({ reason: 'Consentimiento retirado por la paciente' })
        .expect(200);
      const withdrawn = await request(server()).get(`/api/v1/public/documents/${code}`).expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
    });
  });
});
