import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-seed-storage-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { ClinicalCipher, parseClinicalKeys } from './../src/clinical-access/clinical-cipher';
import { FILE_STORAGE, FileStorage } from './../src/patient-files/file-storage';
import { PrismaService } from './../src/prisma/prisma.service';
import { clearDatabase, DEMO_PASSWORD, seedDatabase } from './../prisma/seed';
import { DEMO_DOCUMENT_CODES } from './../prisma/seed-clinical-workflow';

jest.setTimeout(180000);

const storedFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const target = join(directory, name);
    return statSync(target).isDirectory() ? storedFiles(target) : [target];
  });

/**
 * The demo seed is written straight into the database. This runs it against PostgreSQL and
 * then uses the seeded accounts through the API, so that what the seed stores is what the API
 * can read, decrypt, download and enforce.
 */
describe('Demo seed of the clinical workflow, used through the API (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: FileStorage;
  let tenantId: string;
  const tokens: Record<string, string> = {};
  const patients: Record<string, string> = {};
  const users: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = () => `/api/v1/tenants/${tenantId}`;
  const patientUrl = (patient: string, suffix: string) =>
    `${base()}/patients/${patients[patient]}/${suffix}`;
  const binary = (test: request.Test) =>
    test.buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  const seed = () =>
    seedDatabase(prisma, {
      cipher: new ClinicalCipher(parseClinicalKeys(process.env.CLINICAL_ENCRYPTION_KEYS)),
      storage,
    });

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
    storage = app.get<FileStorage>(FILE_STORAGE);

    await prisma.cleanDatabase();
    const result = await seed();
    expect(result.encrypted).toBe(true);

    tenantId = (
      await prisma.tenant.findFirstOrThrow({ where: { name: 'Centro Médico Los Arrayanes' } })
    ).id;
    for (const patient of await prisma.patient.findMany({ where: { tenantId } })) {
      patients[patient.firstName] = patient.id;
    }
    for (const account of [
      'titular',
      'psic',
      'odonto',
      'nutri',
      'fisio',
      'medicina',
      'recepcion',
      'asistente',
    ]) {
      const email = `${account}.arrayanes@psic.com`;
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: DEMO_PASSWORD })
        .expect(200);
      tokens[account] = response.body.accessToken;
      users[account] = response.body.user.id;
    }
  });

  afterAll(async () => {
    // The seed also fills catalogs shared by every clinic; nothing of it is left for other suites.
    await clearDatabase(prisma, storage);
    await prisma.planSpecialty.deleteMany();
    await prisma.specialtyModule.deleteMany();
    await app.close();
  });

  it('stores clinical content encrypted and the API reads it back', async () => {
    const row = await prisma.specialtyRecord.findUniqueOrThrow({
      where: { verificationCode: DEMO_DOCUMENT_CODES.consent },
    });
    expect(JSON.stringify(row.data)).not.toContain('Renata');

    const record = await request(server())
      .get(patientUrl('Renata', `specialty-records/${row.id}`))
      .set(as('odonto'))
      .expect(200);
    expect(record.body.data).toMatchObject({
      signerName: 'Renata Aguirre',
      accepted: true,
      signerSignature: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it('shows the branches with the professionals who attend in each', async () => {
    const response = await request(server()).get(`${base()}/branches`).set(as('psic')).expect(200);
    const branch = (name: string) =>
      response.body.find((candidate: { name: string }) => candidate.name === name);

    expect(response.body).toHaveLength(3);
    expect(branch('Sede principal').professionalIds.sort()).toEqual(
      [users.psic, users.fisio, users.medicina].sort(),
    );
    expect(branch('Sede Norte').professionalIds.sort()).toEqual([users.odonto, users.fisio].sort());
    expect(branch('Sede Valle')).toMatchObject({ isActive: false, professionalIds: [] });
  });

  it('keeps the dentist to the branch they attend in when booking', async () => {
    const specialtyId = (
      await prisma.professionalProfile.findUniqueOrThrow({ where: { userId: users.odonto } })
    ).specialtyId;
    const branches = await prisma.branch.findMany({ where: { tenantId } });
    const idOf = (name: string) => branches.find((branch) => branch.name === name).id;
    const start = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    start.setUTCHours(15, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7));
    const input = {
      patientId: patients.Jorge,
      professionalId: users.odonto,
      specialtyId,
      startTime: start.toISOString(),
      duration: 30,
      title: 'Revisión',
    };

    const refused = await request(server())
      .post(`${base()}/appointments`)
      .set(as('recepcion'))
      .send({ ...input, branchId: idOf('Sede principal') })
      .expect(409);
    expect(refused.body.code).toBe('PROFESSIONAL_NOT_IN_BRANCH');
    const closed = await request(server())
      .post(`${base()}/appointments`)
      .set(as('recepcion'))
      .send({ ...input, branchId: idOf('Sede Valle') });
    expect(closed.body.code).toBe('BRANCH_NOT_AVAILABLE');
    const booked = await request(server())
      .post(`${base()}/appointments`)
      .set(as('recepcion'))
      .send({ ...input, branchId: idOf('Sede Norte') })
      .expect(201);

    // Both assistants have the same permissions because the platform assigns them by role.
    await request(server())
      .post(`${base()}/appointments/${booked.body.id}/cancel`)
      .set(as('recepcion'))
      .send({ reason: 'El paciente avisó' })
      .expect(201);
  });

  it('applies the same permissions to every user of a clinic role', async () => {
    const invoices = `${base()}/billing/invoices`;
    await request(server()).get(invoices).set(as('recepcion')).expect(200);
    await request(server()).get(invoices).set(as('asistente')).expect(200);
    await request(server()).get(invoices).set(as('fisio')).expect(200);

    const described = await request(server())
      .get(`${base()}/users/me/permissions`)
      .set(as('recepcion'))
      .expect(200);
    expect(described.body.effective).toEqual(
      expect.arrayContaining(['billing.view', 'billing.create', 'appointments.cancel']),
    );
  });

  it('has an attention in course with the alerts its records raise', async () => {
    const encounters = await request(server())
      .get(patientUrl('Mateo', 'encounters'))
      .set(as('odonto'))
      .expect(200);
    expect(encounters.body).toEqual([
      expect.objectContaining({
        status: 'OPEN',
        encounterType: 'EMERGENCY',
        professionalId: users.odonto,
        reason: expect.stringContaining('Dolor intenso'),
      }),
    ]);
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: encounters.body[0].appointmentId },
    });
    expect(appointment.status).toBe('IN_PROGRESS');

    const alerts = await request(server())
      .get(patientUrl('Mateo', 'specialty-records/alerts'))
      .set(as('odonto'))
      .expect(200);
    expect(alerts.body.map((alert: { level: string }) => alert.level).sort()).toEqual([
      'critical',
      'warning',
    ]);

    // The open attention takes a new record of its professional and none of anyone else.
    await request(server())
      .post(patientUrl('Mateo', 'specialty-records'))
      .set(as('odonto'))
      .send({
        moduleKey: 'general.soap-note',
        data: { subjective: 'Dolor 8/10.', assessment: 'Pulpitis.', plan: 'Pulpotomía.' },
        encounterId: encounters.body[0].id,
      })
      .expect(201);
    const foreign = await request(server())
      .post(patientUrl('Mateo', 'specialty-records'))
      .set(as('nutri'))
      .send({
        moduleKey: 'general.vital-signs',
        data: { weightKg: 30 },
        encounterId: encounters.body[0].id,
      });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const closed = await request(server())
      .post(patientUrl('Mateo', `encounters/${encounters.body[0].id}/close`))
      .set(as('odonto'))
      .send({ summary: 'Pulpotomía realizada.' })
      .expect(201);
    expect(closed.body.status).toBe('CLOSED');
  });

  it('raises the critical alerts of a blood pressure in crisis range and of a red triage', async () => {
    const alerts = await request(server())
      .get(patientUrl('Carmen', 'specialty-records/alerts'))
      .set(as('nutri'))
      .expect(200);

    const messages = alerts.body.map((alert: { message: string }) => alert.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('crisis hipertensiva'),
        'Triaje de urgencia máxima (5 de 5).',
      ]),
    );
  });

  it('reads a form of the clinic under the version each record was written with', async () => {
    const modules = await request(server())
      .get(`${base()}/clinical-modules`)
      .set(as('fisio'))
      .expect(200);
    const form = modules.body.filter(
      (definition: { name: string }) => definition.name === 'Ficha de ingreso deportivo',
    );
    // Both versions are served: the old one to read its records, the current one to write.
    expect(
      form.map((definition: { schemaVersion: number }) => definition.schemaVersion).sort(),
    ).toEqual([1, 2]);

    const records = await request(server())
      .get(patientUrl('Thomas', 'specialty-records'))
      .set(as('fisio'))
      .expect(200);
    const answers = records.body.filter(
      (record: { moduleKey: string }) => record.moduleKey === form[0].moduleKey,
    );
    expect(answers.map((record: { schemaVersion: number }) => record.schemaVersion).sort()).toEqual(
      [1, 2],
    );
    const latest = answers.find((record: { schemaVersion: number }) => record.schemaVersion === 2);
    expect(latest.alerts).toEqual([{ level: 'warning', message: expect.stringContaining('8') }]);
    // The nutritionist cannot answer a form reserved to physiotherapy.
    await request(server())
      .post(patientUrl('Thomas', 'specialty-records'))
      .set(as('nutri'))
      .send({ moduleKey: form[0].moduleKey, data: { sport: 'Natación', level: 'RECREATIVO' } })
      .expect(403);
  });

  it('serves the seeded files decrypted, and hides the removed one', async () => {
    const files = await request(server())
      .get(patientUrl('Renata', 'files'))
      .set(as('psic'))
      .expect(200);
    expect(files.body.map((file: { fileName: string }) => file.fileName).sort()).toEqual([
      'consentimiento-informado.pdf',
      'radiografia-periapical-36.png',
      'receta.pdf',
    ]);

    for (const file of files.body as { id: string; mimeType: string; sizeBytes: number }[]) {
      const download = await binary(
        request(server())
          .get(patientUrl('Renata', `files/${file.id}/download`))
          .set(as('psic')),
      ).expect(200);
      expect(download.body.length).toBe(file.sizeBytes);
      expect(download.body.subarray(0, 4).toString('latin1')).toBe(
        file.mimeType === 'image/png' ? '\x89PNG' : '%PDF',
      );
    }

    const carmen = await request(server())
      .get(patientUrl('Carmen', 'files'))
      .set(as('nutri'))
      .expect(200);
    expect(carmen.body.map((file: { fileName: string }) => file.fileName)).toEqual([
      'perfil-lipidico.pdf',
    ]);
  });

  it('gives the account holder the storage figures with the file names masked', async () => {
    const files = await request(server())
      .get(`${base()}/storage/files`)
      .set(as('titular'))
      .expect(200);
    expect(files.body).toHaveLength(4);
    expect(new Set(files.body.map((file: { fileName: string }) => file.fileName))).toEqual(
      new Set(['Archivo clínico']),
    );

    const usage = await request(server())
      .get(`${base()}/storage/breakdown`)
      .set(as('titular'))
      .expect(200);
    const subscription = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    // The removed file keeps counting.
    expect(BigInt(usage.body.attachments)).toBe(subscription.storageUsedBytes);
    await request(server()).get(patientUrl('Renata', 'files')).set(as('titular')).expect(403);
  });

  it('reports the activity by branch and by professional', async () => {
    const from = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const report = await request(server())
      .get(`${base()}/reports/activity?from=${from}&to=${to}`)
      .set(as('titular'))
      .expect(200);

    expect(report.body.totals).toMatchObject({ cancelled: 1, noShow: 1, encounters: 6 });
    const branch = (name: string) =>
      report.body.branches.find((candidate: { name: string }) => candidate.name === name);
    expect(branch('Sede Norte').encounters).toBe(3);
    expect(branch('Sede principal').encounters).toBe(2);
    // The teleconsultation was attended from no branch.
    expect(branch('Sin sede')).toMatchObject({ appointments: 0, encounters: 1 });
    expect(Object.keys(report.body.encountersByType).sort()).toEqual([
      'ASSESSMENT',
      'EMERGENCY',
      'FIRST_VISIT',
      'FOLLOW_UP',
      'PROCEDURE',
      'TELECONSULTATION',
    ]);
  });

  it('offers the templates of the clinic, the inactive one only to the account holder', async () => {
    const forProfessional = await request(server())
      .get(`${base()}/document-templates`)
      .set(as('odonto'))
      .expect(200);
    const forHolder = await request(server())
      .get(`${base()}/document-templates`)
      .set(as('titular'))
      .expect(200);

    expect(forProfessional.body).toHaveLength(4);
    expect(forHolder.body).toHaveLength(5);
  });

  it('answers the public verification of each seeded document', async () => {
    const verify = (code: string) => request(server()).get(`/api/v1/public/documents/${code}`);

    const certificate = await verify(DEMO_DOCUMENT_CODES.certificate).expect(200);
    expect(certificate.body).toMatchObject({
      status: 'VALID',
      documentType: 'Certificado',
      clinic: 'Centro Médico Los Arrayanes',
      professional: { name: 'Valeria Montalvo', licenseNumber: 'PSI-EC-310' },
      patientInitials: 'R. A.',
      correctedAt: null,
    });
    const corrected = await verify(DEMO_DOCUMENT_CODES.corrected).expect(200);
    expect(corrected.body).toMatchObject({ status: 'VALID', patientInitials: 'T. B.' });
    expect(corrected.body.correctedAt).toEqual(expect.any(String));
    const withdrawn = await verify(DEMO_DOCUMENT_CODES.withdrawn).expect(200);
    expect(withdrawn.body.status).toBe('WITHDRAWN');
    await verify(DEMO_DOCUMENT_CODES.prescription).expect(200);
    await verify(DEMO_DOCUMENT_CODES.consent).expect(200);
  });

  it('includes the attentions in the clinical timeline of the patient', async () => {
    const timeline = await request(server())
      .get(patientUrl('Renata', 'clinical-timeline'))
      .set(as('psic'))
      .expect(200);
    const entries = Array.isArray(timeline.body) ? timeline.body : timeline.body.items;

    expect(entries.filter((entry: { type: string }) => entry.type === 'ENCOUNTER')).toHaveLength(2);
  });

  it('can be run again: it replaces the rows and leaves no file behind', async () => {
    const before = storedFiles(storageRoot).length;
    expect(before).toBe(await prisma.patientFile.count());

    await seed();

    expect(storedFiles(storageRoot)).toHaveLength(before);
    expect(await prisma.tenant.count({ where: { name: 'Centro Médico Los Arrayanes' } })).toBe(1);
  });
});
