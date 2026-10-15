import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { assertOpenEncounter, EncountersService } from './encounters.service';

describe('EncountersService', () => {
  const plain = new ClinicalCipher();
  const physio: ClinicalActor = {
    userId: 'physio',
    role: 'PROFESIONAL',
    specialtyId: 'physiotherapy',
  };
  const other: ClinicalActor = { ...physio, userId: 'other' };
  const encounter = (overrides = {}) => ({
    id: 'encounter-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    professionalId: 'physio',
    specialtyId: 'physiotherapy',
    appointmentId: null,
    branchId: null,
    encounterType: 'FIRST_VISIT',
    status: 'OPEN',
    reason: 'Dolor lumbar',
    summary: null,
    startedAt: new Date('2026-10-03T15:00:00Z'),
    closedAt: null,
    version: 1,
    deletedAt: null,
    ...overrides,
  });
  const appointment = (overrides = {}) => ({
    id: 'appointment-1',
    status: 'CONFIRMED',
    branchId: 'branch-1',
    professionalId: 'physio',
    psychologistId: 'physio',
    encounter: null,
    ...overrides,
  });
  const db = {
    patient: { findFirst: jest.fn() },
    branch: { findFirst: jest.fn() },
    appointment: { findFirst: jest.fn(), updateMany: jest.fn() },
    encounter: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    specialtyRecord: { count: jest.fn() },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new EncountersService(
    prisma as unknown as PrismaService,
    new ClinicalAuditService(prisma as unknown as PrismaService, plain),
    plain,
  );
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);
  const start = (dto = {}, actor = physio) =>
    service.start('tenant-1', 'patient-1', actor, {
      encounterType: 'FIRST_VISIT',
      reason: ' Dolor lumbar ',
      ...dto,
    } as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.encounter.findFirst.mockResolvedValue(null);
    db.encounter.create.mockImplementation(({ data }) => Promise.resolve(encounter(data)));
    db.encounter.update.mockImplementation(({ data }) =>
      Promise.resolve(encounter({ ...data, version: 2 })),
    );
    db.specialtyRecord.count.mockResolvedValue(0);
  });

  describe('list', () => {
    it('returns the live encounters with their record count and audits each read', async () => {
      db.encounter.findMany.mockResolvedValue([{ ...encounter(), _count: { records: 3 } }]);

      const [listed] = await service.list('tenant-1', 'patient-1', other);

      expect(db.encounter.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(listed).toMatchObject({ id: 'encounter-1', recordCount: 3 });
      expect(listed).not.toHaveProperty('_count');
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entity: 'ENCOUNTER',
          entityId: 'encounter-1',
          userId: 'other',
        }),
      ]);
    });

    it('does not list encounters of a patient outside the tenant', async () => {
      db.patient.findFirst.mockResolvedValue(null);

      await expect(service.list('tenant-1', 'foreign', physio)).rejects.toMatchObject({
        status: 404,
      });
      expect(db.encounter.findMany).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('opens the encounter under the author and their specialty and audits it', async () => {
      const started = await start();

      expect(db.encounter.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'physio',
        specialtyId: 'physiotherapy',
        encounterType: 'FIRST_VISIT',
        reason: 'Dolor lumbar',
      });
      expect(started).toMatchObject({ status: 'OPEN', recordCount: 0 });
      expect(db.appointment.updateMany).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          entity: 'ENCOUNTER',
          changes: { before: null, after: expect.objectContaining({ reason: 'Dolor lumbar' }) },
        }),
      ]);
    });

    it('allows one open encounter per professional and patient', async () => {
      db.encounter.findFirst.mockResolvedValue({ id: 'encounter-0' });

      await expect(start()).rejects.toMatchObject({
        status: 409,
        response: { code: 'ENCOUNTER_ALREADY_OPEN', encounterId: 'encounter-0' },
      });
      expect(db.encounter.findFirst.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'physio',
        status: 'OPEN',
        deletedAt: null,
      });
      expect(db.encounter.create).not.toHaveBeenCalled();
    });

    it('attends an appointment: takes its branch and marks it in progress', async () => {
      db.appointment.findFirst.mockResolvedValue(appointment());

      await start({ appointmentId: 'appointment-1' });

      expect(db.appointment.findFirst.mock.calls[0][0].where).toEqual({
        id: 'appointment-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
      });
      expect(db.encounter.create.mock.calls[0][0].data).toMatchObject({
        appointmentId: 'appointment-1',
        branchId: 'branch-1',
      });
      expect(db.appointment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'appointment-1',
          tenantId: 'tenant-1',
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
        },
        data: { status: 'IN_PROGRESS' },
      });
    });

    it.each([
      ['of another patient or tenant', null, 400, undefined],
      [
        'of another professional',
        appointment({ professionalId: 'other' }),
        403,
        'CLINICAL_RECORD_FORBIDDEN',
      ],
      [
        'that was cancelled',
        appointment({ status: 'CANCELLED' }),
        409,
        'ENCOUNTER_APPOINTMENT_NOT_ATTENDABLE',
      ],
      [
        'that already has an encounter',
        appointment({ encounter: { id: 'e' } }),
        409,
        'ENCOUNTER_EXISTS',
      ],
    ])('refuses an appointment %s', async (_label, found, status, code) => {
      db.appointment.findFirst.mockResolvedValue(found);

      await expect(start({ appointmentId: 'appointment-1' })).rejects.toMatchObject({
        status,
        ...(code ? { response: { code } } : {}),
      });
      expect(db.encounter.create).not.toHaveBeenCalled();
    });

    it('refuses a branch that is not an active one of the tenant', async () => {
      db.branch.findFirst.mockResolvedValue(null);

      await expect(start({ branchId: 'foreign' })).rejects.toMatchObject({
        status: 400,
        response: { code: 'BRANCH_NOT_AVAILABLE' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('changes type and reason of an open encounter and keeps both states in the audit log', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter());

      await service.update('tenant-1', 'patient-1', 'encounter-1', physio, {
        encounterType: 'CONTROL',
        reason: 'Control de dolor lumbar',
      } as never);

      expect(db.encounter.update.mock.calls[0][0].data).toEqual({
        encounterType: 'CONTROL',
        reason: 'Control de dolor lumbar',
        version: { increment: 1 },
      });
      expect(auditRows()[0]).toMatchObject({
        action: 'UPDATE',
        changes: {
          before: expect.objectContaining({ encounterType: 'FIRST_VISIT', version: 1 }),
          after: expect.objectContaining({ encounterType: 'CONTROL', version: 2 }),
        },
      });
    });

    it('is refused to anyone but the author and once the encounter is closed', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter());
      await expect(
        service.update('tenant-1', 'patient-1', 'encounter-1', other, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });

      db.encounter.findFirst.mockResolvedValue(encounter({ status: 'CLOSED' }));
      await expect(
        service.update('tenant-1', 'patient-1', 'encounter-1', physio, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'ENCOUNTER_CLOSED' } });

      expect(db.encounter.update).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('signs the encounter off and completes its appointment', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter({ appointmentId: 'appointment-1' }));

      const closed = await service.close('tenant-1', 'patient-1', 'encounter-1', physio, {
        summary: ' Control en 7 días ',
      });

      expect(db.encounter.update.mock.calls[0][0].data).toEqual({
        status: 'CLOSED',
        closedAt: expect.any(Date),
        summary: 'Control en 7 días',
        version: { increment: 1 },
      });
      expect(closed.status).toBe('CLOSED');
      expect(db.appointment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'appointment-1',
          tenantId: 'tenant-1',
          status: { in: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] },
        },
        data: { status: 'COMPLETED' },
      });
      expect(auditRows()[0]).toMatchObject({ action: 'UPDATE', reason: 'Cierre de la atención' });
    });

    it('cannot be done twice or by another professional', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter({ status: 'CLOSED' }));
      await expect(
        service.close('tenant-1', 'patient-1', 'encounter-1', physio, {}),
      ).rejects.toMatchObject({ status: 409 });

      db.encounter.findFirst.mockResolvedValue(encounter());
      await expect(
        service.close('tenant-1', 'patient-1', 'encounter-1', other, {}),
      ).rejects.toMatchObject({ status: 403 });

      expect(db.encounter.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('keeps the row, frees the appointment and puts it back as scheduled', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter({ appointmentId: 'appointment-1' }));

      await service.delete('tenant-1', 'patient-1', 'encounter-1', physio, {
        reason: 'Paciente equivocado',
      });

      expect(db.encounter.update.mock.calls[0][0].data).toEqual({
        deletedAt: expect.any(Date),
        deletedById: 'physio',
        deletionReason: 'Paciente equivocado',
        appointmentId: null,
      });
      expect(db.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'appointment-1', tenantId: 'tenant-1', status: 'IN_PROGRESS' },
        data: { status: 'SCHEDULED' },
      });
      expect(auditRows()[0]).toMatchObject({
        action: 'DELETE',
        reason: 'Paciente equivocado',
        changes: {
          before: expect.objectContaining({ appointmentId: 'appointment-1' }),
          after: null,
        },
      });
    });

    it('is refused while the encounter holds records', async () => {
      db.encounter.findFirst.mockResolvedValue(encounter());
      db.specialtyRecord.count.mockResolvedValue(2);

      await expect(
        service.delete('tenant-1', 'patient-1', 'encounter-1', physio, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'ENCOUNTER_HAS_RECORDS' } });
      expect(db.specialtyRecord.count).toHaveBeenCalledWith({
        where: { encounterId: 'encounter-1', deletedAt: null },
      });
      expect(db.encounter.update).not.toHaveBeenCalled();
    });
  });

  describe('an encounter that belongs to a treatment session', () => {
    const managed = () => encounter({ treatmentSession: { id: 'session-1' } });
    const refusal = { status: 409, response: { code: 'ENCOUNTER_MANAGED_BY_SESSION' } };

    beforeEach(() => db.encounter.findFirst.mockResolvedValue(managed()));

    it('cannot be closed from the encounters routes', async () => {
      await expect(
        service.close('tenant-1', 'patient-1', 'encounter-1', physio, {}),
      ).rejects.toMatchObject(refusal);
      expect(db.encounter.update).not.toHaveBeenCalled();
    });

    it('cannot be edited from the encounters routes', async () => {
      await expect(
        service.update('tenant-1', 'patient-1', 'encounter-1', physio, { reason: 'x' }),
      ).rejects.toMatchObject(refusal);
      expect(db.encounter.update).not.toHaveBeenCalled();
    });

    it('cannot be deleted from the encounters routes', async () => {
      await expect(
        service.delete('tenant-1', 'patient-1', 'encounter-1', physio, { reason: 'x' }),
      ).rejects.toMatchObject(refusal);
      expect(db.encounter.update).not.toHaveBeenCalled();
    });

    it('is closed by its session through closeEncounter', async () => {
      const closed = await service.closeEncounter(
        db as never,
        'tenant-1',
        'encounter-1',
        physio,
        ' Procedimiento sin complicaciones ',
      );

      expect(db.encounter.findFirst.mock.calls[0][0].where).toEqual({
        id: 'encounter-1',
        tenantId: 'tenant-1',
        deletedAt: null,
      });
      expect(db.encounter.update.mock.calls[0][0].data).toEqual({
        status: 'CLOSED',
        closedAt: expect.any(Date),
        summary: 'Procedimiento sin complicaciones',
        version: { increment: 1 },
      });
      expect(closed.status).toBe('CLOSED');
    });
  });

  describe('assertOpenEncounter', () => {
    const check = (actor = physio) =>
      assertOpenEncounter(
        db as unknown as PrismaService,
        'tenant-1',
        'patient-1',
        'encounter-1',
        actor,
      );

    it('accepts an open encounter of the caller with that patient', async () => {
      db.encounter.findFirst.mockResolvedValue({ professionalId: 'physio', status: 'OPEN' });

      await expect(check()).resolves.toBeUndefined();
      expect(db.encounter.findFirst.mock.calls[0][0].where).toEqual({
        id: 'encounter-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
    });

    it('refuses a missing, foreign or closed encounter', async () => {
      db.encounter.findFirst.mockResolvedValue(null);
      await expect(check()).rejects.toMatchObject({ status: 404 });

      db.encounter.findFirst.mockResolvedValue({ professionalId: 'physio', status: 'OPEN' });
      await expect(check(other)).rejects.toMatchObject({ status: 403 });

      db.encounter.findFirst.mockResolvedValue({ professionalId: 'physio', status: 'CLOSED' });
      await expect(check()).rejects.toMatchObject({
        status: 409,
        response: { code: 'ENCOUNTER_CLOSED' },
      });
    });
  });
});
