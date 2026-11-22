import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

/**
 * Who may write a clinical note: any account with an active professional profile in the clinic,
 * whatever its role (the owner too), and nobody else. The note belongs to the open encounter it
 * is written in, which is where the web asks for it.
 */
describe('Clinical notes authoring (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let tenantId: string;
  let patientId: string;
  let masterId: string;
  let professionalId: string;
  let psychologyId: string;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = () => `/api/v1/tenants/${tenantId}`;
  const login = async (email: string) =>
    (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
  const postNote = (who: string, body: object = {}) =>
    request(server())
      .post(`${base()}/clinical-notes`)
      .set(as(who))
      .send({ patientId, content: 'Contenido de la nota', ...body });
  const startEncounter = (who: string) =>
    request(server())
      .post(`${base()}/patients/${patientId}/encounters`)
      .set(as(who))
      .send({ encounterType: 'FOLLOW_UP', reason: 'Seguimiento' });

  const member = (email: string, role: 'PROFESIONAL' | 'ASISTENTE', specialtyId?: string) =>
    users.create(
      {
        tenantId,
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
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    const created = await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1);
    tenantId = created.id;
    masterId = created.master!.id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId },
      data: { planId: 'plan_clinic_basic', status: 'ACTIVE', seatsPsychologistsMax: 5 },
    });

    const [psychology, aesthetics] = await Promise.all(
      [`E2E-NOTES-PSY-${randomUUID()}`, 'AESTHETICS'].map((code) =>
        prisma.specialty.upsert({
          where: { code },
          update: { isActive: true },
          create: { code, name: code },
        }),
      ),
    );
    psychologyId = psychology.id;
    await prisma.tenantSpecialty.createMany({
      data: [
        { tenantId, specialtyId: psychology.id },
        { tenantId, specialtyId: aesthetics.id },
      ],
    });

    professionalId = (await member('pro@tenant.test', 'PROFESIONAL', psychology.id)).id;
    await member('aesthetic@tenant.test', 'PROFESIONAL', aesthetics.id);
    await member('inactive@tenant.test', 'PROFESIONAL', psychology.id).then((user) =>
      prisma.professionalProfile.update({ where: { userId: user.id }, data: { isActive: false } }),
    );
    await member('assistant@tenant.test', 'ASISTENTE');

    tokens.master = await login('admin+1@tenant.test');
    tokens.pro = await login('pro@tenant.test');
    tokens.aesthetic = await login('aesthetic@tenant.test');
    tokens.inactive = await login('inactive@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');

    patientId = (
      await prisma.patient.create({ data: { tenantId, firstName: 'Ana', lastName: 'Paciente' } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('an owner without a professional profile', () => {
    it('cannot write a note: the role is not what opens clinical content', async () => {
      const response = await postNote('master').expect(403);
      expect(response.body.code).toBe('PROFESSIONAL_NOT_AUTHORIZED');
      expect(await prisma.clinicalNote.count({ where: { tenantId } })).toBe(0);
    });
  });

  describe('an owner who is also an active professional', () => {
    beforeAll(async () => {
      await prisma.professionalProfile.create({
        data: { userId: masterId, specialtyId: psychologyId },
      });
    });

    it('writes a note under their own profile, linked to the open encounter', async () => {
      const encounter = await startEncounter('master').expect(201);
      const response = await postNote('master', {
        diagnosis: 'F41.1',
        encounterId: encounter.body.id,
      }).expect(201);

      expect(response.body).toMatchObject({
        psychologistId: masterId,
        specialtyId: psychologyId,
        encounterId: encounter.body.id,
        patientId,
        version: 1,
      });
      const stored = await prisma.clinicalNote.findUniqueOrThrow({
        where: { id: response.body.id },
      });
      expect(stored).toMatchObject({ tenantId, encounterId: encounter.body.id });
      // The row holds ciphertext only.
      expect(stored.content).toMatch(/^enc:v1:e2e:/);
    });

    it('corrects and removes their own note while the encounter is open', async () => {
      const open = await prisma.encounter.findFirstOrThrow({
        where: { tenantId, patientId, professionalId: masterId, status: 'OPEN' },
      });
      const note = await postNote('master', { encounterId: open.id }).expect(201);

      const corrected = await request(server())
        .patch(`${base()}/clinical-notes/${note.body.id}`)
        .set(as('master'))
        .send({ content: 'Corregida', changeReason: 'Error de transcripción' })
        .expect(200);
      expect(corrected.body).toMatchObject({ content: 'Corregida', version: 2 });

      await request(server())
        .delete(`${base()}/clinical-notes/${note.body.id}`)
        .set(as('master'))
        .send({ reason: 'Paciente equivocado' })
        .expect(200);
    });

    it('does not write in the encounter of a colleague', async () => {
      const colleagueEncounter = await startEncounter('pro').expect(201);
      await postNote('master', { encounterId: colleagueEncounter.body.id }).expect(403);
      const mine = await postNote('pro', { encounterId: colleagueEncounter.body.id }).expect(201);
      expect(mine.body.psychologistId).toBe(professionalId);
    });
  });

  describe('accounts that are not an active professional', () => {
    it.each([
      ['an assistant', 'assistant', 403, undefined],
      ['a professional with an inactive profile', 'inactive', 403, 'PROFESSIONAL_NOT_AUTHORIZED'],
      ['a professional of a non clinical specialty', 'aesthetic', 403, 'HEALTH_SPECIALTY_REQUIRED'],
    ])('refuses %s', async (_label, who, status, code) => {
      const before = await prisma.clinicalNote.count({ where: { tenantId } });
      const response = await postNote(who).expect(status);
      if (code) expect(response.body.code).toBe(code);
      expect(await prisma.clinicalNote.count({ where: { tenantId } })).toBe(before);
    });

    it('refuses a note for a patient that is not in the clinic', async () => {
      const response = await postNote('pro', { patientId: 'unknown-patient' }).expect(404);
      expect(response.body.message).toMatch(/Paciente no encontrado/);
    });
  });
});
