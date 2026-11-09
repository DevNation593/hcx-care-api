import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalFollowUpsService } from './clinical-follow-ups.service';
import { ClinicalOrdersService } from './clinical-orders.service';

type Row = Record<string, any>;

/** Just enough of Prisma for these services, kept in memory. */
function memoryDb() {
  const tables: Record<string, Row[]> = {
    clinicalOrder: [],
    clinicalResult: [],
    clinicalFollowUp: [],
    auditLog: [],
  };
  let sequence = 0;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('in' in expected) return expected.in.includes(row[key]);
        // A relation filter (`order: { orderedById }`).
        const related = tables.clinicalOrder.find(({ id }) => id === row.orderId) ?? {};
        return matches(related, expected);
      }
      return row[key] === expected;
    });
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? row[key] + value.increment
          : value;
    }
    row.updatedAt = new Date();
    return row;
  };
  const withOrderRelations = (order: Row) => ({
    ...order,
    orderedBy: { id: order.orderedById, firstName: 'Ana', lastName: 'Gómez' },
    encounter: null,
    results: tables.clinicalResult
      .filter(({ orderId }) => orderId === order.id)
      .sort((a, b) => a.version - b.version)
      .map((result) => ({
        ...result,
        enteredBy: null,
        reviewedBy: null,
        file: null,
        record: null,
      })),
    followUps: tables.clinicalFollowUp
      .filter(({ orderId }) => orderId === order.id)
      .map((followUp) => ({ ...followUp, assignedTo: null, createdBy: null, patient: null })),
  });
  const model = (name: string, view: (row: Row) => Row = (row) => ({ ...row })) => ({
    create: jest.fn(async ({ data }: Row) => {
      const row = {
        id: data.id ?? `${name}-${++sequence}`,
        version: 1,
        status:
          name === 'clinicalFollowUp'
            ? 'OPEN'
            : name === 'clinicalOrder'
              ? 'ORDERED'
              : 'PENDING_REVIEW',
        createdAt: new Date(),
        updatedAt: new Date(),
        signedAt: null,
        contentHash: null,
        communicatedAt: null,
        reviewedAt: null,
        ...data,
      };
      tables[name].push(row);
      return view(row);
    }),
    update: jest.fn(async ({ where, data }: Row) =>
      view(apply(tables[name].find(({ id }) => id === where.id)!, data)),
    ),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const rows = tables[name].filter((row) => matches(row, where));
      rows.forEach((row) => apply(row, data));
      return { count: rows.length };
    }),
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => {
      const rows = tables[name].filter((row) => matches(row, where));
      if (orderBy?.version === 'desc') rows.sort((a, b) => b.version - a.version);
      return rows[0] ? view(rows[0]) : null;
    }),
    findMany: jest.fn(async ({ where }: Row = {}) =>
      tables[name].filter((row) => matches(row, where)).map(view),
    ),
    count: jest.fn(
      async ({ where }: Row = {}) => tables[name].filter((row) => matches(row, where)).length,
    ),
    createMany: jest.fn(async ({ data }: Row) => {
      tables[name].push(...data);
      return { count: data.length };
    }),
  });

  const db = {
    tables,
    clinicalOrder: model('clinicalOrder', withOrderRelations),
    clinicalResult: model('clinicalResult', (row) => ({
      ...row,
      order: { ...tables.clinicalOrder.find(({ id }) => id === row.orderId) },
    })),
    clinicalFollowUp: model('clinicalFollowUp', (row) => ({
      ...row,
      assignedTo: null,
      createdBy: null,
      patient: { id: row.patientId, firstName: 'Lucía', lastName: 'Mora' },
    })),
    auditLog: model('auditLog'),
    patient: {
      findFirst: jest.fn(async ({ where }: Row) =>
        where.id === 'patient-1' ? { id: 'patient-1' } : null,
      ),
    },
    patientFile: { findFirst: jest.fn() },
    specialtyRecord: { findFirst: jest.fn() },
    encounter: { findFirst: jest.fn() },
    tenantSettings: {
      findUnique: jest.fn(async () => ({ resultReviewAlertDays: 3, orderResultAlertDays: 10 })),
    },
    professionalProfile: {
      findFirst: jest.fn(async ({ where }: Row) =>
        ['gyn', 'gyn-2'].includes(where.userId) ? { userId: where.userId } : null,
      ),
    },
    $queryRaw: jest.fn(async () => [{ id: 'locked' }]),
  };
  return db;
}

describe('ClinicalOrdersService', () => {
  // A real key: the tests check that nothing clinical is stored in the clear.
  const crypto = new ClinicalCipher([
    { id: 'k1', key: Buffer.alloc(32, 7) },
  ]) as unknown as ClinicalCryptoService;
  const gyn: ClinicalActor = { userId: 'gyn', role: 'PROFESIONAL', specialtyId: 'gynecology' };
  const colleague: ClinicalActor = { ...gyn, userId: 'gyn-2' };
  let db: ReturnType<typeof memoryDb>;
  let orders: ClinicalOrdersService;
  let followUps: ClinicalFollowUpsService;

  const audits = () => db.tables.auditLog;
  const order = (input: Row = {}, actor = gyn) =>
    orders.create('tenant-1', 'patient-1', actor, {
      orderType: 'PATHOLOGY',
      studyName: ' Citología cervicovaginal ',
      indication: 'Tamizaje',
      ...input,
    } as never);
  const addResult = (orderId: string, version: number, input: Row = {}) =>
    orders.addResult('tenant-1', orderId, gyn, {
      version,
      content: 'Negativo para lesión intraepitelial.',
      ...input,
    } as never);

  beforeEach(() => {
    db = memoryDb();
    const prisma = {
      ...db,
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(db)),
      applyRlsContext: jest.fn(),
    } as unknown as PrismaService;
    const audit = new ClinicalAuditService(prisma, crypto);
    orders = new ClinicalOrdersService(prisma, audit, crypto);
    followUps = new ClinicalFollowUpsService(prisma, audit, crypto);
  });

  describe('create', () => {
    it('signs an order saved outside any encounter and stores its text encrypted', async () => {
      const created = await order();

      const [stored] = db.tables.clinicalOrder;
      expect(stored.studyName).not.toContain('Citología');
      expect(stored.indication).not.toContain('Tamizaje');
      expect(created).toMatchObject({
        studyName: 'Citología cervicovaginal',
        status: 'ORDERED',
        priority: 'ROUTINE',
        orderedById: 'gyn',
        currentResult: null,
      });
      expect(created.signedAt).toBeInstanceOf(Date);
      expect(created.contentHash).toMatch(/^v1:[0-9a-f]{64}$/);
      // Without a date of its own, a result is expected within the clinic's threshold.
      expect(created.resultDueAt!.getTime() - created.orderedAt.getTime()).toBe(10 * 86_400_000);
      expect(audits()).toEqual([
        expect.objectContaining({ action: 'CREATE', entity: 'CLINICAL_ORDER', userId: 'gyn' }),
      ]);
    });

    it('leaves an order of an open encounter to be signed when the encounter closes', async () => {
      db.encounter.findFirst.mockResolvedValue({ professionalId: 'gyn', status: 'OPEN' });

      const created = await order({ encounterId: 'encounter-1' });

      expect(created).toMatchObject({ encounterId: 'encounter-1', signedAt: null });
    });

    it('rejects the encounter of another professional', async () => {
      db.encounter.findFirst.mockResolvedValue({ professionalId: 'gyn-2', status: 'OPEN' });

      await expect(order({ encounterId: 'encounter-1' })).rejects.toMatchObject({ status: 403 });
      expect(db.tables.clinicalOrder).toHaveLength(0);
    });

    it('rejects a patient of another clinic', async () => {
      await expect(
        orders.create('tenant-1', 'foreign', gyn, {
          orderType: 'LABORATORY',
          studyName: 'X',
        } as never),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the study steps', () => {
    it('records the sample and the shipment, each bumping the version', async () => {
      const { id } = await order();

      const sampled = await orders.collectSample('tenant-1', id, gyn, {
        version: 1,
        notes: 'Endocérvix',
      });
      const sent = await orders.sendToLab('tenant-1', id, gyn, {
        version: 2,
        provider: 'Laboratorio Central',
        externalReference: 'LC-1',
      });

      expect(sampled).toMatchObject({
        status: 'SAMPLE_COLLECTED',
        sampleNotes: 'Endocérvix',
        version: 2,
      });
      expect(sent).toMatchObject({
        status: 'SENT_TO_LAB',
        provider: 'Laboratorio Central',
        externalReference: 'LC-1',
        version: 3,
      });
      expect(db.tables.clinicalOrder[0].provider).not.toContain('Laboratorio');
    });

    it('answers 409 to a client that read an older version, without changing the order', async () => {
      const { id } = await order();
      await orders.collectSample('tenant-1', id, gyn, { version: 1 });

      await expect(
        orders.sendToLab('tenant-1', id, colleague, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'CLINICAL_ORDER_VERSION_CONFLICT', currentVersion: 2 },
      });
      expect(db.tables.clinicalOrder[0].status).toBe('SAMPLE_COLLECTED');
    });

    it('does not find an order of another clinic', async () => {
      const { id } = await order();

      await expect(orders.collectSample('tenant-2', id, gyn, { version: 1 })).rejects.toMatchObject(
        {
          status: 404,
        },
      );
    });
  });

  describe('results', () => {
    it('puts a received result in pending review and never marks the patient informed', async () => {
      const { id } = await order();

      const withResult = await addResult(id, 1);

      expect(withResult.status).toBe('PENDING_REVIEW');
      expect(withResult.currentResult).toMatchObject({
        version: 1,
        status: 'PENDING_REVIEW',
        content: 'Negativo para lesión intraepitelial.',
        communicatedAt: null,
        reviewedAt: null,
      });
      expect(withResult.currentResult!.contentHash).toMatch(/^v1:/);
      expect(db.tables.clinicalResult[0].content).not.toContain('Negativo');
    });

    it('requires a report or a file', async () => {
      const { id } = await order();

      await expect(addResult(id, 1, { content: '  ' })).rejects.toMatchObject({
        response: { code: 'CLINICAL_RESULT_EMPTY' },
      });
    });

    it('accepts only a file of the same patient', async () => {
      const { id } = await order();
      db.patientFile.findFirst.mockResolvedValue(null);

      await expect(addResult(id, 1, { fileId: 'file-of-another-patient' })).rejects.toMatchObject({
        status: 400,
      });
      expect(db.patientFile.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
    });

    it('keeps an earlier version as superseded when a corrected report arrives', async () => {
      const { id } = await order();
      await addResult(id, 1);

      const corrected = await addResult(id, 2, { content: 'Informe corregido' });

      expect(corrected.results.map(({ version, status }) => [version, status])).toEqual([
        [1, 'SUPERSEDED'],
        [2, 'PENDING_REVIEW'],
      ]);
      expect(corrected.currentResult!.content).toBe('Informe corregido');
    });

    it('takes a new version after the review, and the order waits for review again', async () => {
      const { id } = await order();
      const { currentResult } = await addResult(id, 1);
      await orders.review('tenant-1', currentResult!.id, gyn, {
        decision: 'NO_FURTHER_ACTION',
        note: 'Sin hallazgos',
      });

      const again = await addResult(id, 3);

      expect(again.status).toBe('PENDING_REVIEW');
      expect(again.results.map(({ status }) => status)).toEqual(['REVIEWED', 'PENDING_REVIEW']);
    });
  });

  describe('review', () => {
    const received = async () => {
      const { id } = await order();
      const { currentResult } = await addResult(id, 1);
      return { orderId: id, resultId: currentResult!.id };
    };

    it('records the decision, the conduct and who reviewed', async () => {
      const { resultId } = await received();

      const reviewed = await orders.review('tenant-1', resultId, colleague, {
        decision: 'NO_FURTHER_ACTION',
        note: 'Resultado sin hallazgos.',
        appointmentNeeded: true,
      });

      expect(reviewed.status).toBe('REVIEWED');
      expect(reviewed.currentResult).toMatchObject({
        status: 'REVIEWED',
        reviewedById: 'gyn-2',
        reviewDecision: 'NO_FURTHER_ACTION',
        reviewNote: 'Resultado sin hallazgos.',
        appointmentNeeded: true,
        communicatedAt: null,
      });
      expect(db.tables.clinicalResult[0].reviewNote).not.toContain('hallazgos');
    });

    it('asks for the follow-up when the decision needs one, and opens it', async () => {
      const { resultId } = await received();

      await expect(
        orders.review('tenant-1', resultId, gyn, {
          decision: 'REPEAT_REQUIRED',
          note: 'Muestra inadecuada',
        }),
      ).rejects.toMatchObject({ response: { code: 'FOLLOW_UP_REQUIRED' } });

      const reviewed = await orders.review('tenant-1', resultId, gyn, {
        decision: 'REPEAT_REQUIRED',
        note: 'Muestra inadecuada',
        followUp: {
          title: 'Repetir citología',
          dueDate: '2026-12-08T00:00:00.000Z',
          assignedToId: 'gyn-2',
        },
      });

      expect(reviewed.followUps).toEqual([
        expect.objectContaining({
          title: 'Repetir citología',
          assignedToId: 'gyn-2',
          status: 'OPEN',
          resultId,
        }),
      ]);
      expect(audits().map(({ entity, action }) => `${entity}:${action}`)).toContain(
        'CLINICAL_FOLLOW_UP:CREATE',
      );
    });

    it('assigns a follow-up only to an active professional of the clinic', async () => {
      const { resultId } = await received();

      await expect(
        orders.review('tenant-1', resultId, gyn, {
          decision: 'FOLLOW_UP_REQUIRED',
          note: 'Control',
          followUp: {
            title: 'Control',
            dueDate: '2026-12-08T00:00:00.000Z',
            assignedToId: 'assistant',
          },
        }),
      ).rejects.toMatchObject({ response: { code: 'FOLLOW_UP_ASSIGNEE_INVALID' } });
    });

    it('reviews a result only once, and only its last version', async () => {
      const { orderId, resultId } = await received();
      await orders.review('tenant-1', resultId, gyn, { decision: 'NO_FURTHER_ACTION', note: 'Ok' });

      await expect(
        orders.review('tenant-1', resultId, colleague, {
          decision: 'NO_FURTHER_ACTION',
          note: 'Ok',
        }),
      ).rejects.toMatchObject({ status: 409 });

      await addResult(orderId, 3);
      await expect(
        orders.review('tenant-1', resultId, gyn, { decision: 'NO_FURTHER_ACTION', note: 'Ok' }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_RESULT_SUPERSEDED' } });
    });
  });

  describe('communication and closing', () => {
    const reviewed = async (decision = 'NO_FURTHER_ACTION', followUp?: Row) => {
      const { id } = await order();
      const { currentResult } = await addResult(id, 1);
      const done = await orders.review('tenant-1', currentResult!.id, gyn, {
        decision,
        note: 'Revisado',
        followUp,
      } as never);
      return { orderId: id, resultId: currentResult!.id, version: done.version };
    };

    it('does not let an order go from a received result to closed without a review', async () => {
      const { id } = await order();
      await addResult(id, 1);

      await expect(
        orders.complete('tenant-1', id, gyn, { version: 2, note: 'Cerrar' }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_ORDER_INVALID_STATE' } });
    });

    it('records the contact with the patient after the review, once', async () => {
      const { resultId } = await reviewed();

      const contacted = await orders.communicate('tenant-1', resultId, gyn, {
        channel: 'PHONE',
        note: 'Se explicó por teléfono',
      });

      expect(contacted.status).toBe('PATIENT_CONTACTED');
      expect(contacted.currentResult).toMatchObject({
        communicationChannel: 'PHONE',
        communicatedById: 'gyn',
        communicationNote: 'Se explicó por teléfono',
      });
      await expect(
        orders.communicate('tenant-1', resultId, gyn, { channel: 'PHONE' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('does not record a contact before the review', async () => {
      const { id } = await order();
      const { currentResult } = await addResult(id, 1);

      await expect(
        orders.communicate('tenant-1', currentResult!.id, gyn, { channel: 'IN_PERSON' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('closes a reviewed order without contact only with a note explaining why', async () => {
      const { orderId, version } = await reviewed();

      await expect(orders.complete('tenant-1', orderId, gyn, { version })).rejects.toMatchObject({
        response: { code: 'CLINICAL_ORDER_COMPLETION_NOTE_REQUIRED' },
      });
      const completed = await orders.complete('tenant-1', orderId, gyn, {
        version,
        note: 'Paciente informada en la consulta de control.',
      });
      expect(completed).toMatchObject({ status: 'COMPLETED', completedById: 'gyn' });
    });

    it('keeps the order open while its follow-ups are open', async () => {
      const { orderId, resultId, version } = await reviewed('FOLLOW_UP_REQUIRED', {
        title: 'Control en 6 meses',
        dueDate: '2027-05-08T00:00:00.000Z',
      });
      const contacted = await orders.communicate('tenant-1', resultId, gyn, {
        channel: 'IN_PERSON',
      });
      expect(contacted.version).toBe(version + 1);

      await expect(
        orders.complete('tenant-1', orderId, gyn, { version: contacted.version }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_ORDER_FOLLOW_UPS_OPEN' } });

      const [followUp] = contacted.followUps;
      await followUps.close('tenant-1', followUp.id, gyn, {
        version: 1,
        status: 'DONE',
        note: 'Se agendó y realizó el control.',
      });
      await expect(
        orders.complete('tenant-1', orderId, gyn, { version: contacted.version }),
      ).resolves.toMatchObject({ status: 'COMPLETED' });
    });

    it('cancels only an order that got no result', async () => {
      const { id } = await order();
      const cancelled = await orders.cancel('tenant-1', id, gyn, {
        version: 1,
        status: 'NOT_PERFORMED',
        reason: 'La paciente no acudió a la toma.',
      });
      expect(cancelled).toMatchObject({ status: 'NOT_PERFORMED', cancelledById: 'gyn' });

      const other = await order();
      await addResult(other.id, 1);
      await expect(
        orders.cancel('tenant-1', other.id, gyn, { version: 2, status: 'CANCELLED', reason: 'x' }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_ORDER_INVALID_STATE' } });
    });
  });

  describe('follow-ups and the inbox', () => {
    it('closes a follow-up once, with a note, and checks the version', async () => {
      const created = await followUps.create('tenant-1', 'patient-1', gyn, {
        title: 'Control preventivo',
        dueDate: '2027-01-10T00:00:00.000Z',
      });

      await expect(
        followUps.close('tenant-1', created.id, gyn, { version: 2, status: 'DONE', note: 'x' }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_FOLLOW_UP_VERSION_CONFLICT' } });
      const closed = await followUps.close('tenant-1', created.id, gyn, {
        version: 1,
        status: 'CANCELLED',
        note: 'La paciente se atiende en otro centro.',
      });
      expect(closed).toMatchObject({ status: 'CANCELLED', closedById: 'gyn' });
      await expect(
        followUps.close('tenant-1', created.id, gyn, { version: 2, status: 'DONE', note: 'x' }),
      ).rejects.toMatchObject({ response: { code: 'CLINICAL_FOLLOW_UP_CLOSED' } });
    });

    it('lists what waits for the caller, flags what is past the threshold and audits it', async () => {
      const { id } = await order();
      await order({}, colleague);
      const old = await order();
      db.tables.clinicalOrder.find((row) => row.id === old.id)!.resultDueAt = new Date(
        '2020-01-01',
      );
      await addResult(id, 1);
      db.tables.clinicalResult[0].receivedAt = new Date('2020-01-01');
      await followUps.create('tenant-1', 'patient-1', gyn, {
        title: 'Llamar a la paciente',
        dueDate: '2020-01-01T00:00:00.000Z',
      });
      db.tables.auditLog.length = 0;

      const inbox = await followUps.inbox('tenant-1', gyn, 'mine');

      expect(inbox.pendingReview).toEqual([
        expect.objectContaining({
          overdue: true,
          order: expect.objectContaining({ studyName: 'Citología cervicovaginal' }),
        }),
      ]);
      // The colleague's order is not the caller's.
      expect(inbox.awaitingResult.map(({ id: orderId, overdue }) => [orderId, overdue])).toEqual([
        [old.id, true],
      ]);
      expect(inbox.followUps).toEqual([
        expect.objectContaining({ title: 'Llamar a la paciente', overdue: true }),
      ]);
      expect(audits().every(({ action }) => action === 'READ')).toBe(true);
      expect(audits()).toHaveLength(3);

      const all = await followUps.inbox('tenant-1', gyn, 'all');
      expect(all.awaitingResult).toHaveLength(2);
    });
  });
});
