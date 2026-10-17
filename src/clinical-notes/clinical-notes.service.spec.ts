import { ValidationPipe } from '@nestjs/common';
import { ClinicalNotesService } from './clinical-notes.service';
import { UpdateClinicalNoteDto } from './dto/clinical-note.dto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';

describe('ClinicalNotesService', () => {
  const plain = new ClinicalCipher();
  const now = new Date('2026-10-02T12:00:00Z');
  const sessionDate = new Date('2026-09-30T15:00:00Z');
  const author: ClinicalActor = {
    userId: 'author',
    role: 'PROFESIONAL',
    specialtyId: 'psychology',
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
  };
  const colleague: ClinicalActor = { ...author, userId: 'colleague', specialtyId: 'nutrition' };
  const note = (overrides = {}) => ({
    id: 'note-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    appointmentId: null,
    psychologistId: 'author',
    specialtyId: 'psychology',
    content: 'Contenido original',
    diagnosis: 'F41.1',
    treatment: null,
    observations: null,
    sessionDate,
    sessionDuration: 50,
    version: 1,
    deletedAt: null,
    deletedById: null,
    deletionReason: null,
    createdAt: sessionDate,
    updatedAt: sessionDate,
    ...overrides,
  });
  const db = {
    patient: { findFirst: jest.fn() },
    appointment: { findFirst: jest.fn() },
    encounter: { findFirst: jest.fn() },
    clinicalNote: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new ClinicalNotesService(
    prisma as unknown as PrismaService,
    new ClinicalAuditService(prisma as unknown as PrismaService, plain),
    plain,
  );
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.clinicalNote.findFirst.mockResolvedValue(note());
  });

  afterEach(() => jest.useRealTimers());

  describe('create', () => {
    it('writes the note into an open encounter of the author and into no other', async () => {
      db.clinicalNote.create.mockResolvedValue(note());
      const inEncounter = {
        patientId: 'patient-1',
        content: 'Contenido',
        encounterId: 'encounter-1',
      };

      db.encounter.findFirst.mockResolvedValueOnce({ professionalId: 'author', status: 'OPEN' });
      await service.create('tenant-1', author, inEncounter);
      expect(db.encounter.findFirst.mock.calls[0][0].where).toEqual({
        id: 'encounter-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(db.clinicalNote.create.mock.calls[0][0].data).toMatchObject({
        encounterId: 'encounter-1',
      });

      db.encounter.findFirst.mockResolvedValueOnce({ professionalId: 'author', status: 'CLOSED' });
      await expect(service.create('tenant-1', author, inEncounter)).rejects.toMatchObject({
        status: 409,
        response: { code: 'ENCOUNTER_CLOSED' },
      });
      expect(db.clinicalNote.create).toHaveBeenCalledTimes(1);
    });

    it('writes the note under the author and their specialty, and audits the creation', async () => {
      db.clinicalNote.create.mockResolvedValue(note());

      await service.create('tenant-1', author, {
        patientId: 'patient-1',
        content: 'Contenido original',
      });

      expect(db.clinicalNote.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        psychologistId: 'author',
        specialtyId: 'psychology',
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          entity: 'CLINICAL_NOTE',
          entityId: 'note-1',
          patientId: 'patient-1',
          tenantId: 'tenant-1',
          userId: 'author',
          ipAddress: '10.0.0.1',
          userAgent: 'jest',
          changes: { before: null, after: expect.objectContaining({ version: 1 }) },
        }),
      ]);
    });

    it('rejects a patient of another tenant', async () => {
      db.patient.findFirst.mockResolvedValue(null);

      await expect(
        service.create('tenant-1', author, { patientId: 'foreign', content: 'x' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(db.patient.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1' });
      expect(db.clinicalNote.create).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it('lists only live notes of the tenant and audits who read each one', async () => {
      db.clinicalNote.findMany.mockResolvedValue([note(), note({ id: 'note-2' })]);

      const result = await service.findAll('tenant-1', colleague, { patientId: 'patient-1' });

      expect(result).toHaveLength(2);
      expect(db.clinicalNote.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        deletedAt: null,
        patientId: 'patient-1',
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'READ', entityId: 'note-1', userId: 'colleague' }),
        expect.objectContaining({ action: 'READ', entityId: 'note-2', userId: 'colleague' }),
      ]);
    });

    it('writes no audit row for an empty listing', async () => {
      db.clinicalNote.findMany.mockResolvedValue([]);

      await service.findAll('tenant-1', colleague);

      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('leaves the legacy billing columns of the patient out of the note', async () => {
      await service.findOne('tenant-1', 'note-1', colleague);
      expect(db.clinicalNote.findFirst.mock.calls[0][0].include.patient).toEqual({
        omit: LEGACY_BILLING_OMIT,
      });
    });

    it('lets a colleague of another specialty read a note and audits it', async () => {
      await expect(service.findOne('tenant-1', 'note-1', colleague)).resolves.toMatchObject({
        id: 'note-1',
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entityId: 'note-1',
          patientId: 'patient-1',
          userId: 'colleague',
        }),
      ]);
    });

    it('hides removed notes and notes of another tenant', async () => {
      db.clinicalNote.findFirst.mockResolvedValue(null);

      await expect(service.findOne('tenant-2', 'note-1', author)).rejects.toMatchObject({
        status: 404,
        response: { code: 'CLINICAL_RECORD_NOT_FOUND' },
      });
      expect(db.clinicalNote.findFirst.mock.calls[0][0].where).toEqual({
        id: 'note-1',
        tenantId: 'tenant-2',
        deletedAt: null,
      });
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('bumps the version and keeps the previous and new state with the reason', async () => {
      db.clinicalNote.update.mockResolvedValue(note({ content: 'Corregido', version: 2 }));

      await service.update('tenant-1', 'note-1', author, {
        content: 'Corregido',
        changeReason: 'Error de transcripción',
      });

      expect(db.clinicalNote.update.mock.calls[0][0].data).toEqual({
        content: 'Corregido',
        version: { increment: 1 },
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          entityId: 'note-1',
          userId: 'author',
          reason: 'Error de transcripción',
          changes: {
            before: expect.objectContaining({ content: 'Contenido original', version: 1 }),
            after: expect.objectContaining({ content: 'Corregido', version: 2 }),
          },
        }),
      ]);
    });

    it('refuses to correct a note written by someone else', async () => {
      await expect(
        service.update('tenant-1', 'note-1', colleague, { content: 'x', changeReason: 'y' }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      expect(db.clinicalNote.update).not.toHaveBeenCalled();
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('rejects moving the note to another patient or appointment, and a missing reason', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
      const validate = (body: unknown) =>
        pipe.transform(body, { type: 'body', metatype: UpdateClinicalNoteDto });

      await expect(validate({ content: 'x', changeReason: 'motivo' })).resolves.toBeDefined();
      await expect(validate({ patientId: 'other', changeReason: 'motivo' })).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        validate({ appointmentId: 'other', changeReason: 'motivo' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(validate({ content: 'x' })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('delete', () => {
    it('marks the note as removed instead of deleting the row, and audits it', async () => {
      await service.delete('tenant-1', 'note-1', author, { reason: 'Paciente equivocado' });

      expect(db.clinicalNote.delete).not.toHaveBeenCalled();
      expect(db.clinicalNote.update).toHaveBeenCalledWith({
        where: { id: 'note-1' },
        data: { deletedAt: now, deletedById: 'author', deletionReason: 'Paciente equivocado' },
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          entityId: 'note-1',
          userId: 'author',
          reason: 'Paciente equivocado',
          changes: {
            before: expect.objectContaining({ content: 'Contenido original' }),
            after: null,
          },
        }),
      ]);
    });

    it('refuses to remove a note written by someone else, even for the MASTER', async () => {
      const master: ClinicalActor = { ...colleague, userId: 'master', role: 'MASTER' };

      await expect(
        service.delete('tenant-1', 'note-1', master, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      expect(db.clinicalNote.update).not.toHaveBeenCalled();
    });
  });
});
