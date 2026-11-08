import { randomBytes } from 'crypto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { ClinicalTimelineService } from '../clinical-timeline/clinical-timeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import { ClinicalActor } from './clinical-actor';
import { ClinicalAuditService } from './clinical-audit.service';
import { ClinicalCipher, parseClinicalKeys } from './clinical-cipher';

/** What reaches the database is ciphertext; what the services return is the clinical text. */
describe('clinical data at rest', () => {
  const cipher = new ClinicalCipher(parseClinicalKeys(`k1:${randomBytes(32).toString('base64')}`));
  const actor: ClinicalActor = { userId: 'author', role: 'PROFESIONAL', specialtyId: 'nutrition' };
  const db = {
    patient: { findFirst: jest.fn() },
    appointment: { findFirst: jest.fn(), findMany: jest.fn() },
    specialty: { findFirst: jest.fn() },
    tenantModule: { findFirst: jest.fn() },
    specialtyModule: { findFirst: jest.fn() },
    professionalProfile: { findFirst: jest.fn() },
    clinicalNote: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    specialtyRecord: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    encounter: { findMany: jest.fn() },
    auditLog: { createMany: jest.fn(), findMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const prismaService = prisma as unknown as PrismaService;
  const audit = new ClinicalAuditService(prismaService, cipher);
  const notes = new ClinicalNotesService(prismaService, audit, cipher);
  const records = new SpecialtyRecordsService(prismaService, audit, cipher);
  const timeline = new ClinicalTimelineService(prismaService, audit, cipher);
  const auditLog = new AuditLogService(prismaService, cipher);

  const baseNote = {
    id: 'note-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    psychologistId: 'author',
    appointmentId: null,
    specialtyId: 'nutrition',
    treatment: null,
    observations: null,
    sessionDate: new Date('2026-09-30T15:00:00Z'),
    sessionDuration: null,
    version: 1,
    deletedAt: null,
    deletionReason: null,
  };
  const storedNote = (content: string, diagnosis: string | null = 'F41.1') => ({
    ...baseNote,
    content: cipher.encrypt('tenant-1', content),
    diagnosis: diagnosis === null ? null : cipher.encrypt('tenant-1', diagnosis),
  });
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);
  const written = () =>
    JSON.stringify([
      db.clinicalNote.create.mock.calls,
      db.clinicalNote.update.mock.calls,
      db.specialtyRecord.create.mock.calls,
      db.auditLog.createMany.mock.calls,
    ]);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.encounter.findMany.mockResolvedValue([]);
    db.clinicalNote.create.mockImplementation(({ data }) => ({ ...baseNote, ...data }));
    db.clinicalNote.update.mockImplementation(({ data }) => ({
      ...storedNote('Contenido original'),
      ...data,
      version: 2,
    }));
  });

  it('encrypts a new note and its audit snapshot, and returns it readable', async () => {
    const note = await notes.create('tenant-1', actor, {
      patientId: 'patient-1',
      content: 'Contenido original',
      diagnosis: 'F41.1',
      sessionDuration: 50,
    });

    const data = db.clinicalNote.create.mock.calls[0][0].data;
    expect(data.content).toMatch(/^enc:v1:k1:/);
    expect(data.diagnosis).toMatch(/^enc:v1:k1:/);
    expect(data).toMatchObject({ sessionDuration: 50, patientId: 'patient-1' });
    expect(written()).not.toContain('Contenido original');
    expect(written()).not.toContain('F41.1');

    expect(note).toMatchObject({ content: 'Contenido original', diagnosis: 'F41.1' });
    expect(cipher.decryptJson('tenant-1', auditRows()[0].changes)).toMatchObject({
      after: { content: 'Contenido original', diagnosis: 'F41.1' },
    });
  });

  it('decrypts stored notes and still reads rows written before encryption', async () => {
    db.clinicalNote.findMany.mockResolvedValue([
      storedNote('Nota cifrada'),
      { ...baseNote, id: 'legacy', content: 'Nota anterior al cifrado', diagnosis: null },
    ]);

    const result = await notes.findAll('tenant-1', actor);

    expect(result.map(({ content, diagnosis }) => [content, diagnosis])).toEqual([
      ['Nota cifrada', 'F41.1'],
      ['Nota anterior al cifrado', null],
    ]);
  });

  it('encrypts a correction, its reason and both versions in the audit log', async () => {
    db.clinicalNote.findFirst.mockResolvedValue(storedNote('Contenido original'));

    const updated = await notes.update('tenant-1', 'note-1', actor, {
      content: 'Contenido corregido',
      changeReason: 'Error de transcripción',
    });

    expect(db.clinicalNote.update.mock.calls[0][0].data.content).toMatch(/^enc:v1:k1:/);
    expect(written()).not.toContain('Contenido');
    expect(written()).not.toContain('transcripción');
    expect(updated.content).toBe('Contenido corregido');

    const [row] = auditRows();
    expect(cipher.decrypt('tenant-1', row.reason)).toBe('Error de transcripción');
    expect(cipher.decryptJson('tenant-1', row.changes)).toMatchObject({
      before: { content: 'Contenido original', version: 1 },
      after: { content: 'Contenido corregido', version: 2 },
    });
  });

  it('encrypts the reason of a removal', async () => {
    db.clinicalNote.findFirst.mockResolvedValue(storedNote('Contenido original'));

    await notes.delete('tenant-1', 'note-1', actor, { reason: 'Paciente equivocado' });

    const { deletionReason } = db.clinicalNote.update.mock.calls[0][0].data;
    expect(cipher.decrypt('tenant-1', deletionReason)).toBe('Paciente equivocado');
    expect(written()).not.toContain('equivocado');
  });

  it('encrypts the data and notes of a specialty record and returns them readable', async () => {
    db.specialty.findFirst.mockResolvedValue({ id: 'nutrition' });
    db.tenantModule.findFirst.mockResolvedValue({ id: 'module' });
    db.specialtyModule.findFirst.mockResolvedValue({ id: 'specialty-module' });
    db.specialtyRecord.create.mockImplementation(({ data }) => ({
      id: 'record-1',
      version: 1,
      appointmentId: null,
      recordDate: new Date('2026-10-01T10:00:00Z'),
      ...data,
    }));
    const data = { weightKg: 70, heightCm: 170, bmi: 24.2 };

    const record = await records.create('tenant-1', 'patient-1', actor, {
      specialtyCode: 'nutrition',
      moduleKey: 'nutrition.assessments',
      data,
      notes: 'Revisar en 30 días',
    });

    const sent = db.specialtyRecord.create.mock.calls[0][0].data;
    expect(Object.keys(sent.data)).toEqual(['$enc']);
    expect(sent.notes).toMatch(/^enc:v1:k1:/);
    expect(sent.moduleKey).toBe('nutrition.assessments');
    expect(written()).not.toContain('weightKg');
    expect(written()).not.toContain('Revisar');
    expect(record).toMatchObject({ data, notes: 'Revisar en 30 días' });
  });

  it('decrypts notes and records in the timeline', async () => {
    db.appointment.findMany.mockResolvedValue([]);
    db.clinicalNote.findMany.mockResolvedValue([
      { ...storedNote('Nota cifrada'), psychologist: null, specialty: null },
    ]);
    db.specialtyRecord.findMany.mockResolvedValue([
      {
        id: 'record-1',
        tenantId: 'tenant-1',
        recordDate: new Date('2026-09-15T10:00:00Z'),
        data: cipher.encryptJson('tenant-1', { bmi: 24 }),
        notes: null,
        professional: null,
        specialty: null,
      },
    ]);

    const entries = await timeline.getTimeline('tenant-1', 'patient-1', actor, {});

    expect(entries.map(({ record }) => record)).toEqual([
      expect.objectContaining({ content: 'Nota cifrada', diagnosis: 'F41.1' }),
      expect.objectContaining({ data: { bmi: 24 }, notes: null }),
    ]);
  });

  it('decrypts the audit trail for a clinical viewer, including entries written in plain text', async () => {
    const changes = { before: { content: 'Original' }, after: { content: 'Corregido' } };
    db.professionalProfile.findFirst.mockResolvedValue({ userId: 'author' });
    db.auditLog.findMany.mockResolvedValue([
      {
        id: 'encrypted',
        entity: 'CLINICAL_NOTE',
        changes: cipher.encryptJson('tenant-1', changes),
        reason: cipher.encrypt('tenant-1', 'Errata'),
      },
      { id: 'legacy', entity: 'CLINICAL_NOTE', changes, reason: null },
      { id: 'read', entity: 'SPECIALTY_RECORD', changes: null, reason: null },
    ]);

    const trail = await auditLog.findAll('tenant-1', 'author');

    expect(trail).toEqual([
      expect.objectContaining({ id: 'encrypted', changes, reason: 'Errata' }),
      expect.objectContaining({ id: 'legacy', changes, reason: null }),
      expect.objectContaining({ id: 'read', changes: null, reason: null }),
    ]);
  });
});
