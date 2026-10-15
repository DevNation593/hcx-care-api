import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-sessions-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

// 1x1 PNG, as a signature pad would send it.
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_PHOTO = Buffer.from(SIGNATURE.split(',')[1], 'base64');

/** A marker segment: FF xx, big-endian length (counting its own 2 bytes), payload. */
const segment = (marker: number, payload: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

/**
 * Big-endian EXIF with a camera Make, the orientation 6 and a GPS IFD. Only the orientation may
 * reach the storage.
 */
const EXIF_MAKE = 'SecretCam';
const EXIF_GPS_REF = 'GPSREF';
const EXIF_PAYLOAD = Buffer.concat([
  Buffer.from('Exif\0\0', 'binary'),
  // TIFF header: big-endian, IFD0 at offset 8.
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
  // IFD0, three entries: Make (ASCII, 10 bytes at 50), Orientation 6, GPS IFD at 60.
  Buffer.from([0x00, 0x03]),
  Buffer.from([0x01, 0x0f, 0x00, 0x02, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x32]),
  Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00]),
  Buffer.from([0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c]),
  Buffer.alloc(4),
  Buffer.from(`${EXIF_MAKE}\0`, 'binary'),
  // GPS IFD: one ASCII entry whose 7 bytes sit at 78.
  Buffer.from([0x00, 0x01]),
  Buffer.from([0x00, 0x1d, 0x00, 0x02, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x4e]),
  Buffer.alloc(4),
  Buffer.from(`${EXIF_GPS_REF}\0`, 'binary'),
]);

/** What the stored photo keeps of that EXIF: the orientation alone. */
const ORIENTATION_ONLY_APP1 = segment(
  0xe1,
  Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01]),
    Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00]),
    Buffer.alloc(4),
  ]),
);

/** A JPEG whose APP1 segment carries an EXIF block that must not reach the storage whole. */
const JPEG_WITH_EXIF = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
  segment(0xe1, EXIF_PAYLOAD),
  segment(0xdb, Buffer.alloc(65, 0x10)),
  segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
  Buffer.from([0x12, 0x34, 0x56]),
  Buffer.from([0xff, 0xd9]),
]);

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const CONSENT_TITLE = 'Consentimiento para toxina botulínica';
const CONSENT_BODY =
  'Yo, {{paciente}}, con identificación {{identificacion}}, autorizo {{tratamiento}} con {{profesional}} el {{fecha}}.';

const FORM_SCHEMA = {
  sections: [
    {
      key: 'history',
      title: 'Antecedentes',
      fields: [
        {
          key: 'pregnant',
          label: 'Embarazo',
          type: 'select',
          required: true,
          options: [
            { value: 'NO', label: 'No' },
            { value: 'SI', label: 'Sí' },
          ],
        },
      ],
    },
  ],
};

const FULL_REQUIREMENTS = {
  medicalForm: { required: true },
  informedConsent: { required: true, validityDays: 365 },
  photos: { minimumBefore: 1, minimumAfter: 1 },
  clinicalNotes: { requiredForCompletion: true },
};

describe('Treatment sessions: template to completed procedure (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let tenantId: string;
  let otherTenantId: string;
  let specialtyId: string;
  let professionalId: string;
  let assistantId: string;
  let formId: string;
  let counter = 0;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const unique = (prefix: string) => `${prefix} ${++counter}`;

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

  /** A patient of the professional; a minor comes with the guardian the clinic requires. */
  const newPatient = async (options: { minor?: boolean } = {}): Promise<string> => {
    const born = new Date();
    born.setUTCFullYear(born.getUTCFullYear() - (options.minor ? 10 : 35));
    const created = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({
        firstName: 'Paciente',
        lastName: unique('Prueba'),
        dateOfBirth: born.toISOString().slice(0, 10),
        identificationType: 'PASSPORT',
        identificationNumber: `ID${Date.now()}${counter}`,
        ...(options.minor
          ? {
              guardianName: 'Marta Tutora',
              guardianRelationship: 'Madre',
              guardianIdentification: '0102030405',
            }
          : {}),
      })
      .expect(201);
    await request(server())
      .put(`${base()}/patients/${created.body.id}/team/${professionalId}`)
      .set(as('master'))
      .expect(200);
    return created.body.id;
  };

  const publishedTemplate = async (name: string) => {
    const template = await request(server())
      .post(`${base()}/consent-templates`)
      .set(as('master'))
      .send({ name, title: CONSENT_TITLE, body: CONSENT_BODY })
      .expect(201);
    const published = await request(server())
      .post(`${base()}/consent-templates/${template.body.id}/publish`)
      .set(as('master'))
      .expect(200);
    const version = published.body.versions.find(
      (candidate: { status: string }) => candidate.status === 'PUBLISHED',
    );
    return { templateId: template.body.id as string, versionId: version.id as string };
  };

  /** A treatment that requires the form, the consent, a photo each way and notes. */
  const newTreatment = async (
    requirements: unknown = FULL_REQUIREMENTS,
    options: { withConsent?: boolean; withForm?: boolean } = {},
  ) => {
    const { withConsent = true, withForm = true } = options;
    const template = withConsent ? await publishedTemplate(unique('Plantilla')) : null;
    const created = await request(server())
      .post(`${base()}/treatments`)
      .set(as('master'))
      .send({
        name: unique('Tratamiento'),
        specialtyId,
        version: {
          price: 120,
          taxRatePercent: 15,
          durationMinutes: 45,
          ...(withForm ? { formDefinitionId: formId, formVersion: 1 } : {}),
          ...(template ? { consentTemplateVersionId: template.versionId } : {}),
          requirements,
        },
      })
      .expect(201);
    return { treatmentId: created.body.id as string, template };
  };

  const openSession = async (patientId: string, treatmentId: string, appointmentId?: string) => {
    const response = await request(server())
      .post(`${base()}/patients/${patientId}/treatment-sessions`)
      .set(as('pro'))
      .send({ treatmentId, ...(appointmentId ? { appointmentId } : {}) })
      .expect(201);
    return response.body as { id: string; encounterId: string; status: string };
  };

  const sessionUrl = (sessionId: string, suffix = '') =>
    `${base()}/treatment-sessions/${sessionId}${suffix}`;

  const fillForm = (sessionId: string) =>
    request(server())
      .put(sessionUrl(sessionId, '/form'))
      .set(as('pro'))
      .send({ data: { pregnant: 'NO' } })
      .expect(200);

  const present = async (sessionId: string) => {
    const response = await request(server())
      .post(sessionUrl(sessionId, '/consents'))
      .set(as('pro'))
      .expect(201);
    return response.body as { id: string; title: string; body: string; status: string };
  };

  const signBody = (overrides: Record<string, unknown> = {}) => ({
    signerRole: 'PATIENT',
    signerName: 'Ana Paciente',
    signerIdentification: '0102030405',
    understood: true,
    questionsAnswered: true,
    signature: SIGNATURE,
    ...overrides,
  });

  const sign = (documentId: string, overrides: Record<string, unknown> = {}) =>
    request(server())
      .post(`${base()}/consent-documents/${documentId}/sign`)
      .set(as('pro'))
      .send(signBody(overrides));

  const upload = (
    sessionId: string,
    phase: 'BEFORE' | 'AFTER',
    photo: { data: Buffer; type: string; name: string } = {
      data: JPEG_WITH_EXIF,
      type: 'image/jpeg',
      name: 'foto.jpg',
    },
  ) =>
    request(server())
      .post(sessionUrl(sessionId, '/media'))
      .set(as('pro'))
      .field('phase', phase)
      .attach('file', photo.data, { filename: photo.name, contentType: photo.type });

  const detail = async (sessionId: string) =>
    (await request(server()).get(sessionUrl(sessionId)).set(as('pro')).expect(200)).body;

  const download = (url: string, who = 'pro') =>
    request(server())
      .get(url)
      .set(as(who))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

  /** A session with its form saved and its consent presented, waiting for the signature. */
  const presentedSession = async (patientId?: string) => {
    const patient = patientId ?? (await newPatient());
    const { treatmentId, template } = await newTreatment();
    const session = await openSession(patient, treatmentId);
    await fillForm(session.id);
    const document = await present(session.id);
    return { patientId: patient, treatmentId, template, session, document };
  };

  /** A session signed and with its before photo, ready to start. */
  const consentedSession = async () => {
    const setup = await presentedSession();
    await sign(setup.document.id).expect(201);
    await upload(setup.session.id, 'BEFORE').expect(201);
    return setup;
  };

  /** A session taken through the whole procedure, whose signed consent a later session can reuse. */
  const completedSession = async () => {
    const setup = await consentedSession();
    await request(server()).post(sessionUrl(setup.session.id, '/start')).set(as('pro')).expect(201);
    await upload(setup.session.id, 'AFTER').expect(201);
    await request(server())
      .post(sessionUrl(setup.session.id, '/complete'))
      .set(as('pro'))
      .send({ procedureNotes: 'Sin incidencias.' })
      .expect(201);
    return setup;
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
    users = app.get<UsersService>(UsersService);

    await prisma.cleanDatabase();
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: {
        planType: 'CLINIC_BASIC',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        featureClinicalNotes: true,
        featureAttachments: true,
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;

    professionalId = (await member(tenantId, 'pro@tenant.test', 'PROFESIONAL')).id;
    assistantId = (await member(tenantId, 'assistant@tenant.test', 'ASISTENTE')).id;
    await member(otherTenantId, 'outsider@tenant.test', 'PROFESIONAL');

    tokens.master = await login('admin+1@tenant.test');
    tokens.pro = await login('pro@tenant.test');
    tokens.assistant = await login('assistant@tenant.test');
    tokens.outsider = await login('outsider@tenant.test');

    const form = await request(server())
      .post(`${base()}/form-definitions`)
      .set(as('master'))
      .send({ name: 'Ficha médica estética', schema: FORM_SCHEMA })
      .expect(201);
    formId = form.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes a patient from the template to a completed procedure with a signed PDF', async () => {
    // Template -> published version -> treatment pinning the form, the consent and the policy.
    const patientId = await newPatient();
    const { treatmentId, template } = await newTreatment();

    const session = await openSession(patientId, treatmentId);
    expect(session.status).toBe('INTAKE_IN_PROGRESS');

    const filled = await fillForm(session.id);
    expect(filled.body.status).toBe('READY_FOR_CONSENT');
    expect(filled.body.form.data).toEqual({ pregnant: 'NO' });

    const document = await present(session.id);
    expect(document.status).toBe('PRESENTED');
    expect(document.title).toBe(CONSENT_TITLE);
    expect(document.body).toContain('Paciente');
    expect(document.body).not.toContain('{{');

    const signed = await sign(document.id).expect(201);
    expect(signed.body.status).toBe('SIGNED');
    expect(signed.body.pdfChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.body.signature).toEqual({
      signerName: 'Ana Paciente',
      signerRole: 'PATIENT',
      relationship: null,
    });
    // After a reload the detail still says who signed, and in which zone to show the time.
    const consented = await detail(session.id);
    expect(consented).toMatchObject({ status: 'CONSENTED', timezone: expect.any(String) });
    expect(consented.consentDocuments[0].signature).toEqual(signed.body.signature);
    expect(JSON.stringify(consented.consentDocuments)).not.toContain('0102030405');

    await upload(session.id, 'BEFORE').expect(201);
    const started = await request(server())
      .post(sessionUrl(session.id, '/start'))
      .set(as('pro'))
      .expect(201);
    expect(started.body.status).toBe('IN_PROGRESS');

    await upload(session.id, 'AFTER').expect(201);
    const completed = await request(server())
      .post(sessionUrl(session.id, '/complete'))
      .set(as('pro'))
      .send({ procedureNotes: 'Toxina 20 U en glabela, sin incidencias.' })
      .expect(201);
    expect(completed.body.status).toBe('CLINICAL_COMPLETE');

    // The detail exposes the document and the hash of its PDF, and nothing else is missing.
    const finished = await detail(session.id);
    expect(finished.requirements).toEqual({ start: [], complete: [] });
    expect(finished.consentDocuments).toHaveLength(1);
    expect(finished.consentDocuments[0]).toMatchObject({
      id: document.id,
      status: 'SIGNED',
      templateVersionId: template!.versionId,
    });
    expect(finished.consentDocuments[0]).not.toHaveProperty('body');

    // The PDF is what was hashed on signing.
    const pdf = await download(`${base()}/consent-documents/${document.id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sha256(pdf.body)).toBe(finished.consentDocuments[0].pdfChecksum);
    expect(sha256(pdf.body)).toBe(signed.body.pdfChecksum);

    // The encounter follows the session, with the notes as its summary.
    const encounter = await prisma.encounter.findUniqueOrThrow({
      where: { id: session.encounterId },
    });
    expect(encounter.status).toBe('CLOSED');

    // Photos are stored encrypted, keeping of the EXIF only the orientation, which the download confirms.
    const photos = await prisma.patientFile.findMany({
      where: { treatmentSessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(photos.map((photo) => photo.phase)).toEqual(['BEFORE', 'AFTER']);
    for (const photo of photos) {
      const stored = readFileSync(join(storageRoot, ...photo.storageKey.split('/')));
      expect(stored.subarray(0, 4).toString()).toBe('ENC1');
      expect(stored.includes(Buffer.from(EXIF_MAKE))).toBe(false);
      const returned = await download(
        `${base()}/patients/${patientId}/files/${photo.id}/download`,
      ).expect(200);
      expect(returned.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(returned.body.includes(ORIENTATION_ONLY_APP1)).toBe(true);
      expect(returned.body.includes(Buffer.from(EXIF_MAKE))).toBe(false);
      expect(returned.body.includes(Buffer.from(EXIF_GPS_REF))).toBe(false);
      expect(returned.body.includes(Buffer.from([0x88, 0x25]))).toBe(false);
    }
  });

  it('accepts a PNG photo and refuses a PDF as a before photo', async () => {
    const { session, document } = await presentedSession();
    await sign(document.id).expect(201);

    await upload(session.id, 'BEFORE', {
      data: PNG_PHOTO,
      type: 'image/png',
      name: 'a.png',
    }).expect(201);
    const pdf = await upload(session.id, 'BEFORE', {
      data: Buffer.from('%PDF-1.4\n%%EOF\n'),
      type: 'application/pdf',
      name: 'a.pdf',
    }).expect(400);
    expect(pdf.body.code).toBe('PATIENT_FILE_INVALID');
  });

  it('E2E-03: a session with its form and without a signature cannot start', async () => {
    const { session } = await presentedSession();

    // The consent is the step before the start: the command is not allowed yet.
    const early = await request(server())
      .post(sessionUrl(session.id, '/start'))
      .set(as('pro'))
      .expect(409);
    expect(early.body).toMatchObject({
      code: 'TREATMENT_SESSION_INVALID_TRANSITION',
      status: 'READY_FOR_CONSENT',
    });
    const { requirements } = await detail(session.id);
    expect(requirements.start).toEqual(
      expect.arrayContaining(['SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS']),
    );
    expect(requirements.start).not.toContain('FINALIZED_MEDICAL_FORM');
  });

  it('E2E-03: a reused consent that lapsed before the start answers 422 with what is missing', async () => {
    const first = await completedSession();
    const second = await openSession(first.patientId, first.treatmentId);
    expect((await fillForm(second.id)).body.status).toBe('CONSENTED');
    await upload(second.id, 'BEFORE').expect(201);

    // The consent was signed 366 days ago, one more than the treatment accepts.
    await prisma.consentDocument.update({
      where: { id: first.document.id },
      data: { signedAt: new Date(Date.now() - 366 * 24 * 60 * 60 * 1000) },
    });

    const response = await request(server())
      .post(sessionUrl(second.id, '/start'))
      .set(as('pro'))
      .expect(422);
    expect(response.body.code).toBe('TREATMENT_REQUIREMENTS_MISSING');
    expect(response.body.missing).toEqual(['SIGNED_APPLICABLE_CONSENT']);
    expect((await detail(second.id)).status).toBe('CONSENTED');
  });

  it('E2E-05: a signed consent keeps its template version and text when a newer one is published', async () => {
    const { session, document, template } = await presentedSession();
    const signed = await sign(document.id).expect(201);
    const before = (await detail(session.id)).consentDocuments[0];

    await request(server())
      .put(`${base()}/consent-templates/${template!.templateId}/draft`)
      .set(as('master'))
      .send({ title: 'Consentimiento revisado', body: 'Texto nuevo para {{paciente}}.' })
      .expect(200);
    const published = await request(server())
      .post(`${base()}/consent-templates/${template!.templateId}/publish`)
      .set(as('master'))
      .expect(200);
    expect(
      published.body.versions.map((version: { version: number }) => version.version).sort(),
    ).toEqual([1, 2]);

    const after = (await detail(session.id)).consentDocuments[0];
    expect(after.templateVersionId).toBe(template!.versionId);
    expect(after.checksum).toBe(before.checksum);
    expect(after.title).toBe(CONSENT_TITLE);

    const pdf = await download(`${base()}/consent-documents/${document.id}/pdf`).expect(200);
    expect(sha256(pdf.body)).toBe(signed.body.pdfChecksum);
    expect(sha256(pdf.body)).toBe(after.pdfChecksum);
  });

  it('E2E-09: another clinic neither reads nor changes the session or its consent', async () => {
    const { session, document } = await presentedSession();
    await sign(document.id).expect(201);

    const forOutsider = (method: 'get' | 'post', path: string) =>
      request(server())[method](path).set(as('outsider'));

    // Under its own tenant the ids simply do not exist.
    const ownSession = await forOutsider(
      'get',
      sessionUrl(session.id).replace(tenantId, otherTenantId),
    ).expect(404);
    expect(ownSession.body.code).toBe('TREATMENT_SESSION_NOT_FOUND');
    const notFoundDocument = [
      await forOutsider(
        'get',
        `${base(otherTenantId)}/consent-documents/${document.id}/pdf`,
      ).expect(404),
      await forOutsider('post', `${base(otherTenantId)}/consent-documents/${document.id}/sign`)
        .send(signBody())
        .expect(404),
      await forOutsider('post', `${base(otherTenantId)}/consent-documents/${document.id}/revoke`)
        .send({ reason: 'No corresponde.' })
        .expect(404),
    ];
    for (const response of notFoundDocument) {
      expect(response.body.code).toBe('CONSENT_DOCUMENT_NOT_FOUND');
    }

    // Under the other tenant's id the tenant guard answers before any lookup.
    await forOutsider('get', sessionUrl(session.id)).expect(403);
    await forOutsider('get', `${base()}/consent-documents/${document.id}/pdf`).expect(403);

    const bodies = JSON.stringify([ownSession.body, ...notFoundDocument.map((r) => r.body)]);
    expect(bodies).not.toContain(CONSENT_TITLE);
    // Nothing was changed by the attempts.
    const stored = await prisma.consentDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored.status).toBe('SIGNED');
  });

  it('E2E-10: a revoked consent ends the session, which can no longer start', async () => {
    const { session, document } = await consentedSession();
    expect((await detail(session.id)).status).toBe('CONSENTED');

    const revoked = await request(server())
      .post(`${base()}/consent-documents/${document.id}/revoke`)
      .set(as('pro'))
      .send({ reason: 'La paciente cambió de opinión.' })
      .expect(201);
    expect(revoked.body.status).toBe('REVOKED');
    expect((await detail(session.id)).status).toBe('CONSENT_REVOKED');

    const start = await request(server())
      .post(sessionUrl(session.id, '/start'))
      .set(as('pro'))
      .expect(409);
    expect(start.body.code).toBe('TREATMENT_SESSION_INVALID_TRANSITION');
    const encounter = await prisma.encounter.findUniqueOrThrow({
      where: { id: session.encounterId },
    });
    expect(encounter.status).toBe('CLOSED');
  });

  it('revoking a consent sends a later session that reused it back to the consent', async () => {
    const first = await completedSession();

    // The same patient and treatment: the signed consent still applies.
    const second = await openSession(first.patientId, first.treatmentId);
    const reused = await fillForm(second.id);
    expect(reused.body.status).toBe('CONSENTED');
    expect(reused.body.consentDocumentId).toBe(first.document.id);

    await request(server())
      .post(`${base()}/consent-documents/${first.document.id}/revoke`)
      .set(as('pro'))
      .send({ reason: 'Retiro del consentimiento.' })
      .expect(201);

    expect((await detail(second.id)).status).toBe('READY_FOR_CONSENT');
    // The session that was signed in stays as it ended.
    expect((await detail(first.session.id)).status).toBe('CLINICAL_COMPLETE');
  });

  it('E2E-12: the times of the signature and the start are the server time', async () => {
    const { session, document } = await presentedSession();
    const before = Date.now();

    // The body of a signature takes no date: a client time is refused, not stored.
    const refused = await sign(document.id, { signedAt: '2001-01-01T00:00:00.000Z' }).expect(400);
    expect(refused.body.statusCode).toBe(400);
    expect(
      (await prisma.consentDocument.findUniqueOrThrow({ where: { id: document.id } })).status,
    ).toBe('PRESENTED');

    await sign(document.id).expect(201);
    await upload(session.id, 'BEFORE').expect(201);
    // The start takes no body at all, so one that carries a date is ignored.
    await request(server())
      .post(sessionUrl(session.id, '/start'))
      .set(as('pro'))
      .send({ startedAt: '2001-01-01T00:00:00.000Z' })
      .expect(201);

    const stored = await prisma.consentDocument.findUniqueOrThrow({ where: { id: document.id } });
    const row = await prisma.treatmentSession.findUniqueOrThrow({ where: { id: session.id } });
    const signature = await prisma.consentSignature.findFirstOrThrow({
      where: { documentId: document.id },
    });
    for (const time of [stored.signedAt, signature.signedAt, row.startedAt]) {
      expect(Math.abs(time!.getTime() - before)).toBeLessThan(60_000);
    }
  });

  it('E2E-16: a minor is represented, with the relationship, when signing', async () => {
    const { session, document } = await presentedSession(await newPatient({ minor: true }));

    const asPatient = await sign(document.id).expect(422);
    expect(asPatient.body.code).toBe('CONSENT_REPRESENTATIVE_REQUIRED');

    const noRelationship = await sign(document.id, {
      signerRole: 'REPRESENTATIVE',
      signerName: 'Marta Tutora',
    }).expect(400);
    expect(noRelationship.body.code).toBe('CONSENT_RELATIONSHIP_REQUIRED');

    const represented = await sign(document.id, {
      signerRole: 'REPRESENTATIVE',
      signerName: 'Marta Tutora',
      relationship: 'Madre',
    }).expect(201);
    expect(represented.body.status).toBe('SIGNED');
    expect((await detail(session.id)).status).toBe('CONSENTED');
  });

  it('leaves the encounter of a session to the session', async () => {
    const { session, patientId } = await presentedSession();

    const response = await request(server())
      .post(`${base()}/patients/${patientId}/encounters/${session.encounterId}/close`)
      .set(as('pro'))
      .send({})
      .expect(409);
    expect(response.body.code).toBe('ENCOUNTER_MANAGED_BY_SESSION');
    expect(response.body.treatmentSessionId).toBe(session.id);
  });

  it('fixes the form once the procedure has started', async () => {
    const { session, patientId } = await consentedSession();
    const { formRecordId } = await detail(session.id);
    await request(server()).post(sessionUrl(session.id, '/start')).set(as('pro')).expect(201);

    const viaRecords = await request(server())
      .patch(`${base()}/patients/${patientId}/specialty-records/${formRecordId}`)
      .set(as('pro'))
      .send({ data: { pregnant: 'SI' }, changeReason: 'Corrección tardía.' })
      .expect(409);
    expect(viaRecords.body.code).toBe('TREATMENT_SESSION_INVALID_TRANSITION');

    const viaSession = await request(server())
      .put(sessionUrl(session.id, '/form'))
      .set(as('pro'))
      .send({ data: { pregnant: 'SI' } })
      .expect(409);
    expect(viaSession.body.code).toBe('TREATMENT_SESSION_INVALID_TRANSITION');
    expect((await detail(session.id)).form.data).toEqual({ pregnant: 'NO' });
  });

  it('does not present a consent for a treatment that requires none', async () => {
    const { treatmentId } = await newTreatment(
      { photos: { minimumBefore: 0, minimumAfter: 0 } },
      { withConsent: false, withForm: false },
    );
    const session = await openSession(await newPatient(), treatmentId);

    const response = await request(server())
      .post(sessionUrl(session.id, '/consents'))
      .set(as('pro'))
      .expect(409);
    expect(response.body.code).toBe('CONSENT_NOT_REQUIRED');
  });

  it('marks the appointment of a no-show session as NO_SHOW', async () => {
    const patientId = await newPatient();
    const appointment = await request(server())
      .post(`${base()}/appointments`)
      .set(as('master'))
      .send({
        patientId,
        professionalId,
        specialtyId,
        startTime: nextWeekday(15),
        duration: 60,
        title: 'Toxina botulínica',
      })
      .expect(201);
    const { treatmentId } = await newTreatment();
    const session = await openSession(patientId, treatmentId, appointment.body.id);
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.body.id } })).status,
    ).toBe('IN_PROGRESS');

    const missed = await request(server())
      .post(sessionUrl(session.id, '/no-show'))
      .set(as('pro'))
      .expect(201);
    expect(missed.body.status).toBe('NO_SHOW');

    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.body.id } })).status,
    ).toBe('NO_SHOW');
    expect(
      (await prisma.encounter.findUniqueOrThrow({ where: { id: session.encounterId } })).status,
    ).toBe('CLOSED');
  });

  it('marks the appointment of a cancelled session as CANCELLED', async () => {
    const patientId = await newPatient();
    const appointment = await request(server())
      .post(`${base()}/appointments`)
      .set(as('master'))
      .send({
        patientId,
        professionalId,
        specialtyId,
        startTime: nextWeekday(17),
        duration: 60,
        title: 'Toxina botulínica',
      })
      .expect(201);
    const { treatmentId } = await newTreatment();
    const session = await openSession(patientId, treatmentId, appointment.body.id);

    await request(server())
      .post(sessionUrl(session.id, '/cancel'))
      .set(as('pro'))
      .send({ reason: 'La paciente presentó una reacción vasovagal.' })
      .expect(201);

    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.body.id } })).status,
    ).toBe('CANCELLED');
    const row = await prisma.treatmentSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('CANCELLED');
    expect(row.cancellationReason).not.toContain('vasovagal');
  });

  it('marks the appointment of a session cancelled after its start as COMPLETED', async () => {
    const patientId = await newPatient();
    const appointment = await request(server())
      .post(`${base()}/appointments`)
      .set(as('master'))
      .send({
        patientId,
        professionalId,
        specialtyId,
        startTime: nextWeekday(18),
        duration: 60,
        title: 'Toxina botulínica',
      })
      .expect(201);
    const { treatmentId } = await newTreatment(
      { photos: { minimumBefore: 0, minimumAfter: 0 } },
      { withConsent: false, withForm: false },
    );
    const session = await openSession(patientId, treatmentId, appointment.body.id);
    await request(server()).post(sessionUrl(session.id, '/start')).set(as('pro')).expect(201);

    await request(server())
      .post(sessionUrl(session.id, '/cancel'))
      .set(as('pro'))
      .send({ reason: 'La paciente pidió suspender el procedimiento.' })
      .expect(201);

    // The patient attended: the appointment is completed, not cancelled.
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.body.id } })).status,
    ).toBe('COMPLETED');
    const row = await prisma.treatmentSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('CANCELLED');
  });

  it('compliance: only status and missing, for an assistant once billing.view is granted', async () => {
    const { session } = await presentedSession();
    const url = sessionUrl(session.id, '/compliance');

    await request(server()).get(url).set(as('assistant')).expect(403);

    await request(server())
      .put(`${base()}/users/${assistantId}/permissions`)
      .set(as('master'))
      .send({ revoked: [], granted: ['billing.view'] })
      .expect(200);

    const response = await request(server()).get(url).set(as('assistant')).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['missing', 'status']);
    expect(response.body.status).toBe('READY_FOR_CONSENT');
    expect(response.body.missing).toEqual(
      expect.arrayContaining(['SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS']),
    );
    const bodyText = JSON.stringify(response.body);
    expect(bodyText).not.toContain(CONSENT_TITLE);
    expect(bodyText).not.toContain('pregnant');

    // The professional reaches it with the permission of the role.
    await request(server()).get(url).set(as('pro')).expect(200);

    await request(server())
      .put(`${base()}/users/${assistantId}/permissions`)
      .set(as('master'))
      .send({ revoked: [] })
      .expect(200);
    await request(server()).get(url).set(as('assistant')).expect(403);
  });
});
