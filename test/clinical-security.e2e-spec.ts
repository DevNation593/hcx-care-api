import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AddressInfo, createServer, Server } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A clamd stand-in on a free port: FOUND for the EICAR test string, OK for anything else, and
// silence while `clamdDown` is set. Its address is read by the scanner when the app starts.
let clamdDown = false;
const clamd: Server = createServer((socket) => {
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
    if (clamdDown) return;
    if (data.toString() === 'zVERSION\0') return void socket.end('ClamAV 1.4.1/27450/x\0');
    // The stream ends with a zero-length chunk.
    if (data.length < 14 || data.readUInt32BE(data.length - 4) !== 0) return;
    const infected = data.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'));
    socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
  });
});

process.env.STORAGE_LOCAL_PATH = mkdtempSync(join(tmpdir(), 'psic-e2e-security-'));
process.env.FILE_SCAN_DRIVER = 'clamav';
process.env.CLAMAV_HOST = '127.0.0.1';
process.env.FILE_SCAN_TIMEOUT_MS = '1000';

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { totpCode, totpStep } from './../src/auth/totp';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n% informe de prueba\n%%EOF\n');
const EICAR_PDF = Buffer.from(
  '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF\n',
);

/**
 * Phase 4 against PostgreSQL: consents for clinical procedures, the antivirus on patient files
 * (CA-015: a rejected file is never stored nor readable) and two-factor sign-in (SEG-01).
 */
describe('Procedure consents, antivirus and two-factor sign-in (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let specialtyId: string;
  let patientId: string;
  let encounterId: string;
  let templateId: string;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const login = (email: string) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

  beforeAll(async () => {
    await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', () => resolve()));
    process.env.CLAMAV_PORT = String((clamd.address() as AddressInfo).port);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    const users = app.get(UsersService);

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
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;
    for (const [tenant, email] of [
      [tenantId, 'pro@tenant.test'],
      [tenantId, 'colleague@tenant.test'],
      [otherTenantId, 'outsider@tenant.test'],
    ]) {
      await users.create(
        {
          tenantId: tenant,
          email,
          password: TEST_PASSWORD,
          firstName: 'Pro',
          lastName: 'Fesional',
          role: 'PROFESIONAL',
          professionalProfile: { specialtyId },
        },
        'fixture-actor',
      );
    }
    patientId = (
      await prisma.patient.create({ data: { tenantId, firstName: 'Lucía', lastName: 'Paciente' } })
    ).id;

    tokens.master = (await login('admin+1@tenant.test')).body.accessToken;
    tokens.pro = (await login('pro@tenant.test')).body.accessToken;
    tokens.colleague = (await login('colleague@tenant.test')).body.accessToken;
    tokens.outsider = (await login('outsider@tenant.test')).body.accessToken;

    const template = await request(server())
      .post(`${base()}/consent-templates`)
      .set(as('master'))
      .send({
        name: 'Inserción de DIU',
        title: 'Consentimiento para {{tratamiento}}',
        body: 'Yo, {{paciente}}, autorizo a {{profesional}} a realizar {{procedimiento}}.',
      })
      .expect(201);
    templateId = template.body.id;
    await request(server())
      .post(`${base()}/consent-templates/${templateId}/publish`)
      .set(as('master'))
      .expect(200);

    encounterId = (
      await request(server())
        .post(`${base()}/patients/${patientId}/encounters`)
        .set(as('pro'))
        .send({ encounterType: 'PROCEDURE', reason: 'Inserción de DIU' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => clamd.close(() => resolve()));
  });

  describe('procedure consents', () => {
    let documentId: string;

    it('presents the published template filled with the procedure, in the open encounter', async () => {
      const presented = await request(server())
        .post(`${base()}/patients/${patientId}/encounters/${encounterId}/procedure-consents`)
        .set(as('pro'))
        .send({ templateId, procedureName: 'Inserción de dispositivo intrauterino' })
        .expect(201);
      documentId = presented.body.id;
      expect(presented.body).toMatchObject({
        status: 'PRESENTED',
        encounterId,
        treatmentSessionId: null,
        procedureName: 'Inserción de dispositivo intrauterino',
        title: 'Consentimiento para Inserción de dispositivo intrauterino',
      });
      expect(presented.body.body).toContain('Lucía Paciente');
      expect(presented.body.body).toContain('a realizar Inserción de dispositivo intrauterino.');
      expect(presented.body.checksum).toMatch(/^[0-9a-f]{64}$/);

      // A presented document can be taken up again with its text, by any professional who reads it.
      const reopened = await request(server())
        .get(`${base()}/procedure-consents/${documentId}`)
        .set(as('colleague'))
        .expect(200);
      expect(reopened.body).toMatchObject({ id: documentId, status: 'PRESENTED' });
      expect(reopened.body.body).toBe(presented.body.body);
      // The templates route is not taken for a document id.
      await request(server())
        .get(`${base()}/procedure-consents/templates`)
        .set(as('pro'))
        .expect(200);

      const stored = await prisma.consentDocument.findUniqueOrThrow({ where: { id: documentId } });
      expect(stored.body).not.toContain('Lucía');
      expect(stored.procedureName).not.toContain('intrauterino');
    });

    it('lets only the professional of the encounter sign it, and nobody from another clinic', async () => {
      const sign = {
        signerRole: 'PATIENT',
        signerName: 'Lucía Paciente',
        understood: true,
        questionsAnswered: true,
        signature: SIGNATURE,
      };
      await request(server())
        .post(`${base()}/procedure-consents/${documentId}/sign`)
        .set(as('colleague'))
        .send(sign)
        .expect(403);
      await request(server())
        .post(`${base(otherTenantId)}/procedure-consents/${documentId}/sign`)
        .set(as('outsider'))
        .send(sign)
        .expect(404);
      // The routes of treatment sessions do not reach a procedure consent.
      await request(server())
        .post(`${base()}/consent-documents/${documentId}/sign`)
        .set(as('pro'))
        .send(sign)
        .expect((response) => expect([403, 404]).toContain(response.status));

      const signed = await request(server())
        .post(`${base()}/procedure-consents/${documentId}/sign`)
        .set(as('pro'))
        .send({ ...sign, witnessName: 'Enfermera de turno' })
        .expect(201);
      expect(signed.body).toMatchObject({
        status: 'SIGNED',
        hasPdf: true,
        signature: { signerName: 'Lucía Paciente', witnessName: 'Enfermera de turno' },
      });

      const pdf = await request(server())
        .get(`${base()}/procedure-consents/${documentId}/pdf`)
        .set(as('colleague'))
        .buffer(true)
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
    });

    it('records a refusal with its reason without blocking the encounter', async () => {
      const presented = await request(server())
        .post(`${base()}/patients/${patientId}/encounters/${encounterId}/procedure-consents`)
        .set(as('pro'))
        .send({ templateId, procedureName: 'Biopsia de cérvix' })
        .expect(201);
      const refused = await request(server())
        .post(`${base()}/procedure-consents/${presented.body.id}/refuse`)
        .set(as('pro'))
        .send({ reason: 'La paciente prefiere pensarlo.' })
        .expect(201);
      expect(refused.body.status).toBe('REFUSED');
      expect(refused.body.events.at(-1)).toMatchObject({
        type: 'REFUSED',
        reason: 'La paciente prefiere pensarlo.',
      });

      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(encounter.status).toBe('OPEN');
      const listed = await request(server())
        .get(`${base()}/patients/${patientId}/procedure-consents`)
        .set(as('colleague'))
        .expect(200);
      expect(listed.body.map((document: { status: string }) => document.status).sort()).toEqual([
        'REFUSED',
        'SIGNED',
      ]);
    });
  });

  describe('antivirus', () => {
    const upload = (bytes: Buffer) =>
      request(server())
        .post(`${base()}/patients/${patientId}/files`)
        .set(as('pro'))
        .field('category', 'EXAMEN')
        .attach('file', bytes, { filename: 'informe.pdf', contentType: 'application/pdf' });

    it('stores a clean file with the engine that scanned it', async () => {
      const response = await upload(PDF).expect(201);
      expect(response.body).toMatchObject({
        scanStatus: 'CLEAN',
        scanEngine: 'ClamAV 1.4.1/27450',
      });
    });

    it('never stores an infected file', async () => {
      const before = await prisma.patientFile.count();
      const response = await upload(EICAR_PDF).expect(422);
      expect(response.body.code).toBe('PATIENT_FILE_INFECTED');
      expect(await prisma.patientFile.count()).toBe(before);
    });

    it('stores nothing while the antivirus does not answer', async () => {
      clamdDown = true;
      try {
        const response = await upload(PDF).expect(503);
        expect(response.body.code).toBe('FILE_SCAN_UNAVAILABLE');
      } finally {
        clamdDown = false;
      }
    });
  });

  describe('two-factor sign-in', () => {
    it('makes the professionals enrol when the clinic requires it', async () => {
      await request(server())
        .patch(`${base()}/settings`)
        .set(as('master'))
        .send({ requireMfa: true })
        .expect(200);

      const signedIn = await login('colleague@tenant.test');
      expect(signedIn.body.user).toMatchObject({ mfaEnabled: false, mfaEnrollmentRequired: true });
      tokens.colleague = signedIn.body.accessToken;
      const blocked = await request(server())
        .get(`${base()}/patients/${patientId}/procedure-consents`)
        .set(as('colleague'))
        .expect(403);
      expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

      const setup = await request(server())
        .post('/api/v1/auth/mfa/setup')
        .set(as('colleague'))
        .send({ password: TEST_PASSWORD })
        .expect(200);
      const secret = setup.body.secret as string;
      const step = totpStep(new Date());
      const enabled = await request(server())
        .post('/api/v1/auth/mfa/enable')
        .set(as('colleague'))
        .send({ code: totpCode(secret, step) })
        .expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);

      // The password alone no longer opens a session.
      const challenge = await login('colleague@tenant.test');
      expect(challenge.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
      expect(challenge.body.accessToken).toBeUndefined();

      // The code used to enrol is not accepted again; the next one is.
      await request(server())
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: challenge.body.mfaToken, code: totpCode(secret, step) })
        .expect(401);
      const verified = await request(server())
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: challenge.body.mfaToken, code: totpCode(secret, step + 1) })
        .expect(200);
      expect(verified.body.user).toMatchObject({ mfaEnabled: true, mfaEnrollmentRequired: false });
      await request(server())
        .get(`${base()}/patients/${patientId}/procedure-consents`)
        .set({ Authorization: `Bearer ${verified.body.accessToken}` })
        .expect(200);

      // A recovery code works once.
      const again = await login('colleague@tenant.test');
      const [recoveryCode] = enabled.body.recoveryCodes;
      await request(server())
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: again.body.mfaToken, recoveryCode })
        .expect(200);
      await request(server())
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: again.body.mfaToken, recoveryCode })
        .expect(401);

      // Required by the clinic: it cannot be turned off.
      const disabled = await request(server())
        .post('/api/v1/auth/mfa/disable')
        .set({ Authorization: `Bearer ${verified.body.accessToken}` })
        .send({ password: TEST_PASSWORD, code: totpCode(secret, step + 1) })
        .expect(409);
      expect(disabled.body.code).toBe('MFA_REQUIRED_BY_POLICY');
    });

    it('lets the account holder reset a lost second factor', async () => {
      const colleague = await prisma.user.findFirstOrThrow({
        where: { email: 'colleague@tenant.test' },
      });
      // The master also has to enrol now: it is required for them too.
      const masterLogin = await login('admin+1@tenant.test');
      expect(masterLogin.body.user.mfaEnrollmentRequired).toBe(true);
      await request(server())
        .post(`${base()}/users/${colleague.id}/mfa/reset`)
        .set({ Authorization: `Bearer ${masterLogin.body.accessToken}` })
        .expect(403);

      await prisma.tenantSettings.update({ where: { tenantId }, data: { requireMfa: false } });
      await request(server())
        .post(`${base()}/users/${colleague.id}/mfa/reset`)
        .set({ Authorization: `Bearer ${masterLogin.body.accessToken}` })
        .expect(200);
      const plain = await login('colleague@tenant.test');
      expect(plain.body.accessToken).toEqual(expect.any(String));
      expect(
        await prisma.auditLog.count({ where: { entity: 'USER', entityId: colleague.id } }),
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
