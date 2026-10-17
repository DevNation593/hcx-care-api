import { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { PatientTeamService } from '../patient-team/patient-team.service';
import { PrismaService } from '../prisma/prisma.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';
import { PatientsService } from './patients.service';

describe('PatientsService legacy assignment compatibility', () => {
  const patient = {
    id: 'patient-1',
    tenantId: 'tenant-1',
    firstName: 'Ana',
    lastName: 'Paz',
    assignedPsychologistId: 'professional-1',
  };
  const subscription = {
    tenantId: 'tenant-1',
    status: 'ACTIVE',
    activePatientsCount: 0,
    maxActivePatients: 10,
    planType: 'PRO',
  };
  const tx = {
    patient: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    tenantSubscription: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    patientProfessional: { updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
  };
  const team = { ensureActive: jest.fn(), assertActiveMembership: jest.fn(), remove: jest.fn() };
  const service = new PatientsService(
    prisma as unknown as PrismaService,
    team as unknown as PatientTeamService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    tx.patient.create.mockResolvedValue(patient);
    tx.patient.findFirst.mockResolvedValue(patient);
    tx.patient.update.mockResolvedValue(patient);
    tx.tenantSubscription.findUnique.mockResolvedValue(subscription);
    tx.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });
  });

  const createInput = (overrides: Partial<CreatePatientDto> = {}): CreatePatientDto => ({
    firstName: 'Ana',
    lastName: 'Paz',
    ...overrides,
  });
  const assignmentForbidden = () =>
    new ForbiddenException({
      statusCode: 403,
      code: 'TEAM_ASSIGNMENT_FORBIDDEN',
      message: 'No tienes permiso para modificar este equipo tratante.',
    });

  it('creates the same patient and activates its legacy assignee in one serializable transaction', async () => {
    const result = await service.create(
      'tenant-1',
      createInput({ assignedPsychologistId: 'professional-1' }),
      'admin-1',
      'MASTER',
    );

    expect(result).toBe(patient);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(prisma.applyRlsContext).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      userId: 'admin-1',
      role: 'MASTER',
    });
    expect(tx.patient.create).toHaveBeenCalledWith({
      omit: expect.any(Object),
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        assignedPsychologistId: 'professional-1',
      }),
    });
    expect(team.ensureActive).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      professionalId: 'professional-1',
      assignedById: 'admin-1',
    });
    expect(team.remove).not.toHaveBeenCalled();
  });

  it('keeps an unassigned create free of team writes', async () => {
    await service.create('tenant-1', createInput(), 'admin-1', 'MASTER');
    expect(team.ensureActive).not.toHaveBeenCalled();
  });

  it.each(['PROFESIONAL'])(
    'rejects a %s creating a patient with a legacy assignee before any write',
    async (role) => {
      await expect(
        service.create(
          'tenant-1',
          createInput({ assignedPsychologistId: 'professional-1' }),
          'professional-1',
          role,
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: {
          statusCode: 403,
          code: 'TEAM_ASSIGNMENT_FORBIDDEN',
        },
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.findUnique).not.toHaveBeenCalled();
      expect(tx.patient.create).not.toHaveBeenCalled();
      expect(team.ensureActive).not.toHaveBeenCalled();
      expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    'allows a professional to create patient demographics with pointer %s',
    async (assignedPsychologistId) => {
      await service.create(
        'tenant-1',
        createInput({ assignedPsychologistId }),
        'professional-1',
        'PROFESIONAL',
      );

      expect(tx.patient.create).toHaveBeenCalledTimes(1);
      expect(team.ensureActive).not.toHaveBeenCalled();
    },
  );

  it('clears only the legacy pointer when update explicitly supplies null', async () => {
    await service.update(
      'tenant-1',
      'patient-1',
      { assignedPsychologistId: null },
      'assistant-1',
      'ASISTENTE',
    );

    expect(tx.patient.update).toHaveBeenCalledWith({
      omit: expect.any(Object),
      where: { id: 'patient-1' },
      data: expect.objectContaining({ assignedPsychologistId: null }),
    });
    expect(team.ensureActive).not.toHaveBeenCalled();
    expect(team.remove).not.toHaveBeenCalled();
    expect(tx.patientProfessional.updateMany).not.toHaveBeenCalled();
  });

  it('leaves the pointer and team untouched when update omits the legacy field', async () => {
    await service.update('tenant-1', 'patient-1', { firstName: 'Anita' }, 'admin-1', 'MASTER');

    const data = tx.patient.update.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({ firstName: 'Anita' }));
    expect(data).not.toHaveProperty('assignedPsychologistId');
    expect(team.ensureActive).not.toHaveBeenCalled();
    expect(team.remove).not.toHaveBeenCalled();
    expect(tx.patientProfessional.updateMany).not.toHaveBeenCalled();
  });

  it('updates the legacy pointer and reactivates only the selected team member', async () => {
    const result = await service.update(
      'tenant-1',
      'patient-1',
      { assignedPsychologistId: 'professional-2' },
      'professional-1',
      'PROFESIONAL',
    );

    expect(result).toBe(patient);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(prisma.applyRlsContext).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      userId: 'professional-1',
      role: 'PROFESIONAL',
    });
    expect(tx.patient.findFirst).toHaveBeenCalledWith({
      where: { id: 'patient-1', tenantId: 'tenant-1', deletedAt: null },
    });
    expect(tx.patient.update).toHaveBeenCalledWith({
      omit: expect.any(Object),
      where: { id: 'patient-1' },
      data: expect.objectContaining({ assignedPsychologistId: 'professional-2' }),
    });
    expect(team.assertActiveMembership).toHaveBeenCalledWith(
      tx,
      'tenant-1',
      'patient-1',
      'professional-1',
    );
    expect(team.assertActiveMembership.mock.invocationCallOrder[0]).toBeLessThan(
      tx.patient.update.mock.invocationCallOrder[0],
    );
    expect(team.ensureActive).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      professionalId: 'professional-2',
      assignedById: 'professional-1',
    });
    expect(team.remove).not.toHaveBeenCalled();
    expect(tx.patientProfessional.updateMany).not.toHaveBeenCalled();
  });

  it.each([['PROFESIONAL', 'professional-1']])(
    'denies an unassigned %s adding %s through the legacy pointer',
    async (role, targetId) => {
      team.assertActiveMembership.mockRejectedValue(assignmentForbidden());

      await expect(
        service.update(
          'tenant-1',
          'patient-1',
          { assignedPsychologistId: targetId },
          'professional-1',
          role,
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: {
          statusCode: 403,
          code: 'TEAM_ASSIGNMENT_FORBIDDEN',
        },
      });

      expect(team.assertActiveMembership).toHaveBeenCalledWith(
        tx,
        'tenant-1',
        'patient-1',
        'professional-1',
      );
      expect(tx.patient.update).not.toHaveBeenCalled();
      expect(team.ensureActive).not.toHaveBeenCalled();
    },
  );

  it.each(['MASTER', 'ASISTENTE'])(
    'lets %s activate a legacy assignee without a team membership check',
    async (role) => {
      await service.update(
        'tenant-1',
        'patient-1',
        { assignedPsychologistId: 'professional-2' },
        'actor-1',
        role,
      );

      expect(team.assertActiveMembership).not.toHaveBeenCalled();
      expect(team.ensureActive).toHaveBeenCalledWith(tx, {
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'professional-2',
        assignedById: 'actor-1',
      });
    },
  );

  describe('legacy billing fields', () => {
    const BILLING_KEYS = [
      'billingName',
      'billingTaxIdType',
      'billingTaxId',
      'billingEmail',
      'billingAddress',
    ];
    const omitted = (call: { omit?: Record<string, boolean> }) =>
      expect(Object.keys(call.omit ?? {}).sort()).toEqual([...BILLING_KEYS].sort());

    it.each(BILLING_KEYS)('rejects %s in the create and update DTOs', async (field) => {
      for (const Dto of [CreatePatientDto, UpdatePatientDto]) {
        const dto = plainToInstance(Dto, { firstName: 'Ana', lastName: 'Paz', [field]: 'x' });
        // Same options as the global ValidationPipe of main.ts.
        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
        expect(errors.map((error) => error.property)).toEqual([field]);
      }
    });

    it('leaves the billing columns out of create and update responses', async () => {
      await service.create('tenant-1', createInput(), 'admin-1', 'MASTER');
      omitted(tx.patient.create.mock.calls[0][0]);

      await service.update('tenant-1', 'patient-1', { firstName: 'Anabel' }, 'admin-1', 'MASTER');
      omitted(tx.patient.update.mock.calls[0][0]);
      const data = tx.patient.update.mock.calls[0][0].data;
      for (const key of BILLING_KEYS) expect(data).not.toHaveProperty(key);
    });

    it('leaves the billing columns out of list and detail responses', async () => {
      const reads = {
        patient: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      };
      reads.patient.findFirst.mockResolvedValue(patient);
      const reader = new PatientsService(
        reads as unknown as PrismaService,
        team as unknown as PatientTeamService,
      );

      await reader.findAll('tenant-1');
      omitted(reads.patient.findMany.mock.calls[0][0]);
      await reader.findOne('tenant-1', 'patient-1');
      omitted(reads.patient.findFirst.mock.calls[0][0]);
    });
  });
});
