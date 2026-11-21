import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-close-race-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { createPlatformAdmin } from './../prisma/create-platform-admin';
import { UsersService } from './../src/users/users.service';
import { ClinicalAuditService } from './../src/clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from './../src/clinical-access/clinical-crypto.service';
import { ENCRYPTED_NOTE_FIELDS } from './../src/clinical-notes/encrypted-note-fields';
import {
  encounterContentHash,
  fileContentHash,
  noteContentHash,
  orderContentHash,
} from './../src/clinical-access/clinical-signature';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(60000);

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Writer = 'note' | 'order' | 'file';

/**
 * A write into an open encounter that is still uncommitted while the encounter is closed, and
 * the closer that is a Serializable transaction (complete-and-close, the encounter no-show).
 * The writer is a Read Committed transaction: it has taken its hold on the encounter and written
 * its row, and waits right before committing. The closer takes its snapshot, then blocks on the
 * encounter row. Releasing the writer commits a row that the closer's snapshot cannot see.
 */
describe('Closing an encounter while a write into it is committing (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: ClinicalAuditService;
  let crypto: ClinicalCryptoService;
  let tenantId: string;
  let specialtyId: string;
  let professionalId: string;
  let counter = 0;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = () => `/api/v1/tenants/${tenantId}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const login = async (email: string) =>
    (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;

  /** A patient of the professional, with a session opened and (optionally) started. */
  const openSession = async (options: { started: boolean }) => {
    const created = await request(server())
      .post(`${base()}/patients`)
      .set(as('master'))
      .send({
        firstName: 'Paciente',
        lastName: `Carrera ${++counter}`,
        dateOfBirth: '1990-05-05',
        identificationType: 'PASSPORT',
        identificationNumber: `ID${Date.now()}${counter}`,
      })
      .expect(201);
    const patientId = created.body.id as string;
    await request(server())
      .put(`${base()}/patients/${patientId}/team/${professionalId}`)
      .set(as('master'))
      .expect(200);

    const treatment = await request(server())
      .post(`${base()}/treatments`)
      .set(as('master'))
      .send({
        name: `Tratamiento ${counter}`,
        code: `RACE-${counter}`,
        specialtyId,
        version: {
          price: 50,
          taxRatePercent: 15,
          durationMinutes: 30,
          requirements: { photos: { minimumBefore: 0, minimumAfter: 0 } },
        },
      })
      .expect(201);
    const session = await request(server())
      .post(`${base()}/patients/${patientId}/treatment-sessions`)
      .set(as('pro'))
      .send({ treatmentId: treatment.body.id })
      .expect(201);
    if (options.started) {
      await request(server())
        .post(`${base()}/treatment-sessions/${session.body.id}/start`)
        .set(as('pro'))
        .expect(201);
    }
    return {
      patientId,
      sessionId: session.body.id as string,
      encounterId: session.body.encounterId as string,
    };
  };

  const write = (kind: Writer, patientId: string, encounterId: string) => {
    if (kind === 'note') {
      return request(server())
        .post(`${base()}/clinical-notes`)
        .set(as('pro'))
        .send({ patientId, encounterId, content: 'Nota escrita mientras se cierra.' });
    }
    if (kind === 'order') {
      return request(server())
        .post(`${base()}/patients/${patientId}/clinical-orders`)
        .set(as('pro'))
        .send({ orderType: 'LABORATORY', studyName: 'Hemograma', encounterId });
    }
    return request(server())
      .post(`${base()}/patients/${patientId}/files`)
      .set(as('pro'))
      .field('category', 'EXAMEN')
      .field('encounterId', encounterId)
      .attach('file', PNG, { filename: 'examen.png', contentType: 'image/png' });
  };

  const AUDIT_ENTITY: Record<Writer, string> = {
    note: 'CLINICAL_NOTE',
    order: 'CLINICAL_ORDER',
    file: 'PATIENT_FILE',
  };

  /** Holds the write of the given kind just before its transaction commits. */
  const holdBeforeCommit = (kind: Writer) => {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      if (args[2].some((entry) => entry.entity === AUDIT_ENTITY[kind])) {
        arrived();
        await gate;
      }
      return original(...args);
    });
    return { reached, release, restore: () => spy.mockRestore() };
  };

  /** Resolves once some backend is waiting for a lock: the closer, behind the writer. */
  const waitForLockWait = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (rows[0].waiting > 0) return;
      await sleep(100);
    }
    throw new Error('Nothing is waiting for a lock: the close did not reach the encounter row');
  };

  /**
   * Runs `closer` while the `kind` write is held before committing, then lets the write commit.
   * Returns both responses.
   */
  const race = async (
    kind: Writer,
    setup: { patientId: string; encounterId: string },
    closer: () => request.Test,
  ) => {
    const hold = holdBeforeCommit(kind);
    try {
      const writer = write(kind, setup.patientId, setup.encounterId).then((response) => response);
      await hold.reached;
      const closing = closer().then((response) => response);
      await waitForLockWait();
      hold.release();
      return { writer: await writer, closing: await closing };
    } finally {
      hold.restore();
    }
  };

  /** The hash the encounter must carry: over everything it holds once it is closed. */
  const expectedSignature = async (encounterId: string) => {
    const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
    const records = await prisma.specialtyRecord.count({
      where: { tenantId, encounterId, deletedAt: null },
    });
    expect(records).toBe(0);

    const notes = (
      await prisma.clinicalNote.findMany({ where: { tenantId, encounterId, deletedAt: null } })
    ).map((stored) => {
      const note = crypto.decryptFields(tenantId, stored, ENCRYPTED_NOTE_FIELDS);
      return { id: note.id, contentHash: noteContentHash(note) };
    });
    const files = (
      await prisma.patientFile.findMany({ where: { tenantId, encounterId, deletedAt: null } })
    ).map((file) => ({
      id: file.id,
      contentHash: fileContentHash({
        ...file,
        fileName: crypto.decrypt(tenantId, file.fileName),
        description: file.description === null ? null : crypto.decrypt(tenantId, file.description),
        contentHash: file.contentHash!,
      }),
    }));
    const orders = (await prisma.clinicalOrder.findMany({ where: { tenantId, encounterId } })).map(
      (stored) => {
        const order = crypto.decryptFields(tenantId, stored, ['studyName', 'indication']);
        return { id: order.id, contentHash: orderContentHash(order) };
      },
    );
    const hash = encounterContentHash(
      {
        ...encounter,
        reason: crypto.decrypt(tenantId, encounter.reason),
        summary: encounter.summary === null ? null : crypto.decrypt(tenantId, encounter.summary),
        closedAt: encounter.closedAt!,
      },
      [],
      notes,
      files,
      orders,
    );
    return { hash, notes, files, orders };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
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
    audit = app.get(ClinicalAuditService);
    crypto = app.get(ClinicalCryptoService);

    await prisma.cleanDatabase();
    await createPlatformAdmin(prisma, {
      email: 'platform-close-race@example.test',
      password: TEST_PASSWORD,
      firstName: 'Platform',
      lastName: 'Admin',
    });
    tenantId = (await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId },
      data: {
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        storageGB: 1,
      },
    });
    specialtyId = (await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })).id;
    professionalId = (
      await app.get(UsersService).create(
        {
          tenantId,
          email: 'pro@tenant.test',
          password: TEST_PASSWORD,
          firstName: 'Pro',
          lastName: 'Member',
          role: 'PROFESIONAL',
          professionalProfile: { specialtyId },
        },
        'fixture-actor',
      )
    ).id;
    tokens.master = await login('admin+1@tenant.test');
    tokens.pro = await login('pro@tenant.test');
  });

  afterAll(async () => {
    await app.close();
  });

  describe.each<Writer>(['note', 'order', 'file'])(
    'complete-and-close racing a %s being written',
    (kind) => {
      it('signs what the write committed, or the close is retried to include it', async () => {
        const setup = await openSession({ started: true });

        const { writer, closing } = await race(kind, setup, () =>
          request(server())
            .post(`${base()}/treatment-sessions/${setup.sessionId}/complete`)
            .set(as('pro'))
            .send({ procedureNotes: 'Listo.', closeEncounter: true, password: TEST_PASSWORD }),
        );

        expect(writer.status).toBe(201);
        expect(closing.status).toBe(201);
        const encounter = await prisma.encounter.findUniqueOrThrow({
          where: { id: setup.encounterId },
        });
        expect(encounter.status).toBe('CLOSED');

        const { hash, notes, files, orders } = await expectedSignature(setup.encounterId);
        expect(notes.length + files.length + orders.length).toBe(1);
        // The write is in the signature the encounter carries.
        expect(encounter.contentHash).toBe(hash);
        // And a row that is signed individually carries its signature.
        if (kind === 'order') {
          const order = await prisma.clinicalOrder.findFirstOrThrow({
            where: { tenantId, encounterId: setup.encounterId },
          });
          expect(order.signedAt).not.toBeNull();
          expect(order.contentHash).toBe(orders[0].contentHash);
        }
      });
    },
  );

  describe('the encounter no-show racing a note being written', () => {
    it('does not record a no-show over a note that committed meanwhile', async () => {
      const setup = await openSession({ started: false });

      const { writer, closing } = await race('note', setup, () =>
        request(server())
          .post(`${base()}/patients/${setup.patientId}/encounters/${setup.encounterId}/no-show`)
          .set(as('pro')),
      );

      expect(writer.status).toBe(201);
      expect(closing.status).toBe(409);
      expect(closing.body.code).toBe('ENCOUNTER_HAS_ACTIVITY');
      const encounter = await prisma.encounter.findUniqueOrThrow({
        where: { id: setup.encounterId },
      });
      expect(encounter.status).toBe('OPEN');
      const session = await prisma.treatmentSession.findUniqueOrThrow({
        where: { id: setup.sessionId },
      });
      expect(session.status).not.toBe('NO_SHOW');
    });
  });
});
