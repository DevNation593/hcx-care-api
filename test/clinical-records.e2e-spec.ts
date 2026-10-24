import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from './../src/app.module';
import { ClinicalCryptoService } from './../src/clinical-access/clinical-crypto.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

describe('Clinical records authorization and audit (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: ClinicalCryptoService;
  let users: UsersService;
  let tenantId: string;
  let otherTenantId: string;
  let patientId: string;
  let noteId: string;
  let recordId: string;
  let authorId: string;
  let colleagueId: string;
  const tokens: Record<string, string> = {};

  const login = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const notesUrl = (tenant = tenantId) => `/api/v1/tenants/${tenant}/clinical-notes`;
  const recordsUrl = () => `/api/v1/tenants/${tenantId}/patients/${patientId}/specialty-records`;
  const timelineUrl = () => `/api/v1/tenants/${tenantId}/patients/${patientId}/clinical-timeline`;

  const member = async (
    tenant: string,
    email: string,
    role: 'PROFESIONAL' | 'ASISTENTE',
    specialtyId?: string,
  ) =>
    users.create(
      {
        tenantId: tenant,
        email,
        password: TEST_PASSWORD,
        firstName: role,
        lastName: 'Member',
        role,
        ...(specialtyId ? { professionalProfile: { specialtyId } } : {}),
      },
      'fixture-actor',
    );

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
    crypto = app.get<ClinicalCryptoService>(ClinicalCryptoService);
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: {
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
      },
    });

    const [psychology, nutrition] = await Promise.all(
      ['PSY', 'NUT'].map((code) =>
        prisma.specialty.create({
          data: { code: `E2E-CLINICAL-${code}-${randomUUID()}`, name: code },
        }),
      ),
    );
    await prisma.tenantSpecialty.createMany({
      data: [
        { tenantId, specialtyId: psychology.id },
        { tenantId, specialtyId: nutrition.id },
        { tenantId: otherTenantId, specialtyId: psychology.id },
      ],
    });

    authorId = (await member(tenantId, 'author@tenant.test', 'PROFESIONAL', psychology.id)).id;
    colleagueId = (await member(tenantId, 'colleague@tenant.test', 'PROFESIONAL', nutrition.id)).id;
    await member(tenantId, 'inactive@tenant.test', 'PROFESIONAL', psychology.id).then((user) =>
      prisma.professionalProfile.update({ where: { userId: user.id }, data: { isActive: false } }),
    );
    await member(tenantId, 'assistant@tenant.test', 'ASISTENTE');
    await member(otherTenantId, 'outsider@tenant.test', 'PROFESIONAL', psychology.id);

    tokens.master = await login('admin+1@tenant.test');
    tokens.author = await login('author@tenant.test');
    tokens.colleague = await login('colleague@tenant.test');
    tokens.inactive = await login('inactive@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');
    tokens.outsider = await login('outsider@tenant.test');

    patientId = (
      await prisma.patient.create({ data: { tenantId, firstName: 'Ana', lastName: 'Paciente' } })
    ).id;
    recordId = (
      await prisma.specialtyRecord.create({
        data: {
          tenantId,
          patientId,
          professionalId: colleagueId,
          specialtyId: nutrition.id,
          moduleKey: 'nutrition.assessments',
          data: { weightKg: 70, heightCm: 170, bmi: 24.2 },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the author create a note under their own specialty', async () => {
    const response = await request(app.getHttpServer())
      .post(notesUrl())
      .set(as('author'))
      .send({ patientId, content: 'Contenido original', diagnosis: 'F41.1' })
      .expect(201);
    noteId = response.body.id;
    expect(response.body).toMatchObject({ psychologistId: authorId, version: 1 });
  });

  it.each([
    ['master', 'PROFESSIONAL_NOT_AUTHORIZED'],
    ['inactive', 'PROFESSIONAL_NOT_AUTHORIZED'],
    ['outsider', 'TENANT_SCOPE_VIOLATION'],
  ])('refuses clinical content to %s', async (who, code) => {
    for (const url of [
      `${notesUrl()}?patientId=${patientId}`,
      `${notesUrl()}/${noteId}`,
      recordsUrl(),
      timelineUrl(),
    ]) {
      const response = await request(app.getHttpServer()).get(url).set(as(who)).expect(403);
      expect(response.body.code).toBe(code);
    }
  });

  it('refuses clinical content to an assistant by role', async () => {
    for (const url of [notesUrl(), `${notesUrl()}/${noteId}`, recordsUrl(), timelineUrl()]) {
      await request(app.getHttpServer()).get(url).set(as('assistant')).expect(403);
    }
  });

  it('does not expose the note through another tenant', async () => {
    await request(app.getHttpServer())
      .get(`${notesUrl(otherTenantId)}/${noteId}`)
      .set(as('outsider'))
      .expect(404);
  });

  it('shares the history with a colleague of another specialty', async () => {
    const notes = await request(app.getHttpServer())
      .get(`${notesUrl()}?patientId=${patientId}`)
      .set(as('colleague'))
      .expect(200);
    expect(notes.body.map((note: { id: string }) => note.id)).toEqual([noteId]);

    const records = await request(app.getHttpServer())
      .get(recordsUrl())
      .set(as('author'))
      .expect(200);
    expect(records.body.map((record: { id: string }) => record.id)).toEqual([recordId]);

    const timeline = await request(app.getHttpServer())
      .get(timelineUrl())
      .set(as('colleague'))
      .expect(200);
    expect(timeline.body.map((entry: { type: string }) => entry.type).sort()).toEqual([
      'CLINICAL_NOTE',
      'SPECIALTY_RECORD',
    ]);
  });

  it('lets only the author correct the note, with a reason and without moving it', async () => {
    const patch = (who: string, body: object) =>
      request(app.getHttpServer()).patch(`${notesUrl()}/${noteId}`).set(as(who)).send(body);

    const forbidden = await patch('colleague', { content: 'Ajeno', changeReason: 'x' }).expect(403);
    expect(forbidden.body.code).toBe('CLINICAL_RECORD_FORBIDDEN');
    await patch('author', { content: 'Sin motivo' }).expect(400);
    await patch('author', { patientId: 'other', changeReason: 'Mover' }).expect(400);

    const corrected = await patch('author', {
      content: 'Contenido corregido',
      changeReason: 'Error de transcripción',
    }).expect(200);
    expect(corrected.body).toMatchObject({ content: 'Contenido corregido', version: 2 });
  });

  it('removes the note functionally and keeps it recoverable', async () => {
    const remove = (who: string, body: object) =>
      request(app.getHttpServer()).delete(`${notesUrl()}/${noteId}`).set(as(who)).send(body);

    await remove('colleague', { reason: 'Ajena' }).expect(403);
    await remove('author', {}).expect(400);
    await remove('author', { reason: 'Paciente equivocado' }).expect(200);

    await request(app.getHttpServer()).get(`${notesUrl()}/${noteId}`).set(as('author')).expect(404);
    const listed = await request(app.getHttpServer())
      .get(`${notesUrl()}?patientId=${patientId}`)
      .set(as('author'))
      .expect(200);
    expect(listed.body).toEqual([]);

    const stored = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } });
    expect(stored).toMatchObject({ version: 2, deletedById: authorId });
    // The row holds ciphertext only; it is still readable with the key.
    expect(stored.content).toMatch(/^enc:v1:e2e:/);
    expect(JSON.stringify(stored)).not.toMatch(/Contenido|equivocado|F41/);
    expect(crypto.decrypt(tenantId, stored.content)).toBe('Contenido corregido');
    expect(crypto.decrypt(tenantId, stored.deletionReason!)).toBe('Paciente equivocado');
    expect(stored.deletedAt).toBeInstanceOf(Date);
  });

  it('records who read and changed the note, with the earlier versions', async () => {
    const stored = await prisma.auditLog.findMany({
      where: { tenantId, entity: 'CLINICAL_NOTE', entityId: noteId },
      orderBy: { createdAt: 'asc' },
    });
    expect(JSON.stringify(stored)).not.toMatch(/Contenido|transcripción|equivocado/);
    const trail = stored.map((entry) => ({
      ...entry,
      changes: crypto.decryptJson(tenantId, entry.changes),
      reason: entry.reason && crypto.decrypt(tenantId, entry.reason),
    }));

    expect(trail.map(({ action, userId }) => [action, userId])).toEqual([
      ['CREATE', authorId],
      ['READ', colleagueId],
      ['READ', colleagueId],
      ['UPDATE', authorId],
      ['DELETE', authorId],
    ]);
    expect(trail.every((entry) => entry.patientId === patientId)).toBe(true);
    expect(trail[3]).toMatchObject({
      reason: 'Error de transcripción',
      changes: {
        before: { content: 'Contenido original', version: 1 },
        after: { content: 'Contenido corregido', version: 2 },
      },
    });
    expect(trail[4]).toMatchObject({
      reason: 'Paciente equivocado',
      changes: { before: { content: 'Contenido corregido' }, after: null },
    });

    const recordReads = await prisma.auditLog.findMany({
      where: { tenantId, entity: 'SPECIALTY_RECORD', entityId: recordId, action: 'READ' },
    });
    expect(recordReads.map(({ userId }) => userId).sort()).toEqual([authorId, colleagueId].sort());
  });

  it('shows the trail to a MASTER without a profile but not the clinical content', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/tenants/${tenantId}/audit-logs/CLINICAL_NOTE/${noteId}`)
      .set(as('master'))
      .expect(200);

    expect(response.body).toHaveLength(5);
    for (const entry of response.body) {
      expect(entry).toMatchObject({ changes: null, reason: null, contentRedacted: true });
    }
    expect(JSON.stringify(response.body)).not.toContain('Contenido');
  });
});
