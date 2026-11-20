import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ForbiddenException } from '@nestjs/common';
import { PermissionChecker } from '../common/permissions/permission-checker.service';
import { PrismaService } from '../prisma/prisma.service';
import { PatientTeamService } from '../patient-team/patient-team.service';
import { ProfessionalEligibilityService } from '../patient-team/professional-eligibility.service';
import { TeamActor } from '../patient-team/patient-team.types';
import { AppointmentsController } from './appointments.controller';
import { CreateAppointmentDto, ListAppointmentsQueryDto } from './dto/appointment.dto';
import { AppointmentsService } from './appointments.service';

describe('AppointmentsService canonical appointments', () => {
  const tenantId = 'tenant-1';
  const now = new Date('2026-09-28T12:00:00.000Z');
  const startTime = '2026-09-29T13:00:00.000Z';
  const admin: TeamActor = { tenantId, userId: 'admin-1', role: 'MASTER' };
  const assistant: TeamActor = { tenantId, userId: 'assistant-1', role: 'ASISTENTE' };
  const clinician: TeamActor = { tenantId, userId: 'professional-1', role: 'PROFESIONAL' };
  const specialty = { id: 'nutrition', code: 'NUTRITION', name: 'Nutrición', isActive: true };
  const professional = (id = 'professional-1', specialtyId = 'nutrition') => ({
    id,
    tenantId,
    firstName: 'Ana',
    lastName: 'López',
    email: 'ana@example.test',
    role: 'PROFESIONAL',
    isActive: true,
    professionalProfile: {
      isActive: true,
      specialtyId,
      specialty: { ...specialty, id: specialtyId },
      professionalTitle: 'Nutricionista',
      licenseNumber: '123',
    },
  });
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'appointment-1',
    tenantId,
    patientId: 'patient-1',
    professionalId: 'professional-1',
    psychologistId: 'professional-1',
    specialtyId: 'nutrition',
    startTime: new Date(startTime),
    endTime: new Date('2026-09-29T14:00:00.000Z'),
    duration: 60,
    status: 'SCHEDULED',
    title: 'Consulta',
    description: null,
    patient: { id: 'patient-1', firstName: 'Pat', lastName: 'Smith' },
    professional: professional(),
    psychologist: professional(),
    specialty,
    ...overrides,
  });
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    patientId: 'patient-1',
    professionalId: 'professional-1',
    specialtyId: 'nutrition',
    startTime,
    duration: 60,
    ...overrides,
  });
  const db = {
    patient: { findFirst: jest.fn() },
    user: { findFirst: jest.fn() },
    patientProfessional: { findUnique: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    appointment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const eligibility = { resolve: jest.fn() };
  const team = { assertActiveMembership: jest.fn(), ensureActive: jest.fn(), remove: jest.fn() };
  let service: AppointmentsService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1', tenantId, deletedAt: null });
    db.user.findFirst.mockResolvedValue(professional());
    db.patientProfessional.findUnique.mockResolvedValue({ tenantId, isActive: true });
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
      workingHoursStart: '00:00',
      workingHoursEnd: '23:59',
    });
    db.appointment.findMany.mockResolvedValue([]);
    db.appointment.findFirst.mockResolvedValue(row());
    db.appointment.create.mockImplementation(async ({ data }) => row(data));
    db.appointment.update.mockImplementation(async ({ data }) => row(data));
    eligibility.resolve.mockImplementation(async (_db, _tenant, id) => professional(id));
    team.ensureActive.mockResolvedValue({ id: 'assignment-1' });
    service = new (AppointmentsService as any)(
      prisma as unknown as PrismaService,
      eligibility as unknown as ProfessionalEligibilityService,
      team as unknown as PatientTeamService,
    );
  });
  afterEach(() => jest.useRealTimers());

  const create = (input: Record<string, unknown>, actor: TeamActor = admin) =>
    (service as any).create(tenantId, input, actor);
  const update = (input: Record<string, unknown>, actor: TeamActor = admin) =>
    (service as any).update(tenantId, 'appointment-1', input, actor);
  const list = (filters: Record<string, unknown> = {}, actor: TeamActor = admin) =>
    (service as any).findAll(tenantId, filters, actor);
  const get = (actor: TeamActor = admin) =>
    (service as any).findOne(tenantId, 'appointment-1', actor);
  const cancel = (actor: TeamActor = admin) =>
    (service as any).cancel(tenantId, 'appointment-1', 'Patient request', actor);

  it('accepts canonical and legacy DTO fields and rejects noninteger duration', () => {
    expect(validateSync(plainToInstance(CreateAppointmentDto, createInput()))).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(
          CreateAppointmentDto,
          createInput({
            professionalId: undefined,
            psychologistId: 'professional-1',
            specialtyId: undefined,
          }),
        ),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(CreateAppointmentDto, createInput({ duration: 60.5 }))),
    ).not.toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(ListAppointmentsQueryDto, {
          professionalId: 'professional-1',
          specialtyId: 'nutrition',
        }),
      ),
    ).toHaveLength(0);
  });

  it.each(['create', 'list', 'get', 'update', 'cancel'])(
    '%s rejects another tenant before database work',
    async (method) => {
      const other = { ...admin, tenantId: 'tenant-2' };
      const action = {
        create: () => create(createInput(), other),
        list: () => list({}, other),
        get: () => get(other),
        update: () => update({ title: 'New' }, other),
        cancel: () => cancel(other),
      }[method];
      await expect(action!()).rejects.toMatchObject({
        status: 403,
        response: { code: 'TENANT_SCOPE_VIOLATION' },
      });
      expect(db.patient.findFirst).not.toHaveBeenCalled();
      expect(db.appointment.findFirst).not.toHaveBeenCalled();
      expect(db.appointment.findMany).not.toHaveBeenCalled();
    },
  );

  it('writes matching canonical and legacy IDs and team assignment in the same transaction', async () => {
    const result = await create(createInput(), assistant);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'patient-1', tenantId, deletedAt: null },
      }),
    );
    expect(eligibility.resolve).toHaveBeenCalledWith(db, tenantId, 'professional-1', 'nutrition');
    expect(team.ensureActive).toHaveBeenCalledWith(db, {
      tenantId,
      patientId: 'patient-1',
      professionalId: 'professional-1',
      assignedById: 'assistant-1',
    });
    expect(db.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          professionalId: 'professional-1',
          psychologistId: 'professional-1',
          specialtyId: 'nutrition',
        }),
      }),
    );
    expect(result).toMatchObject({
      professionalId: 'professional-1',
      psychologistId: 'professional-1',
    });
    expect(result.professional).toEqual(result.psychologist);
  });

  it('derives specialty only from a legacy-only professional reference', async () => {
    await create(
      createInput({
        professionalId: undefined,
        psychologistId: 'professional-1',
        specialtyId: undefined,
      }),
    );
    expect(db.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          professionalId: 'professional-1',
          psychologistId: 'professional-1',
          specialtyId: 'nutrition',
        }),
      }),
    );
  });

  it('resolves professional eligibility before reporting a missing canonical specialty', async () => {
    await expect(create(createInput({ specialtyId: undefined }))).rejects.toMatchObject({
      status: 422,
      response: { code: 'SPECIALTY_REQUIRED' },
    });
    expect(eligibility.resolve).toHaveBeenCalledWith(db, tenantId, 'professional-1', undefined);
  });

  it.each([
    [
      createInput({ professionalId: 'one', psychologistId: 'two' }),
      400,
      'PROFESSIONAL_REFERENCE_MISMATCH',
    ],
    [createInput({ professionalId: undefined }), 422, 'PROFESSIONAL_REQUIRED'],
    [createInput({ specialtyId: undefined }), 422, 'SPECIALTY_REQUIRED'],
  ])('rejects invalid professional/specialty reference %#', async (input, status, code) => {
    await expect(create(input)).rejects.toMatchObject({ status, response: { code } });
    expect(db.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects a deleted or foreign-tenant patient without writing', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    await expect(create(createInput())).rejects.toMatchObject({ status: 404 });
    expect(team.ensureActive).not.toHaveBeenCalled();
  });

  it('rechecks the existing patient tenant and deletion state before an update', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    await expect(update({ title: 'Changed' })).rejects.toMatchObject({ status: 404 });
    expect(db.patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'patient-1', tenantId, deletedAt: null },
      }),
    );
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it.each([admin, assistant])(
    'administrative actors can reassign an eligible professional',
    async (actor) => {
      await update({ professionalId: 'professional-2', specialtyId: 'nutrition' }, actor);
      expect(team.ensureActive).toHaveBeenCalledWith(db, {
        tenantId,
        patientId: 'patient-1',
        professionalId: 'professional-2',
        assignedById: actor.userId,
      });
      expect(db.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            professionalId: 'professional-2',
            psychologistId: 'professional-2',
            specialtyId: 'nutrition',
          }),
        }),
      );
      expect(team.remove).not.toHaveBeenCalled();
    },
  );

  it('requires an explicit specialty for canonical reassignment', async () => {
    await expect(update({ professionalId: 'professional-2' })).rejects.toMatchObject({
      status: 422,
      response: { code: 'SPECIALTY_REQUIRED' },
    });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('rejects a null specialty on canonical reassignment', async () => {
    await expect(
      update({ professionalId: 'professional-2', specialtyId: null }),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it.each([
    'patientId',
    'professionalId',
    'psychologistId',
    'specialtyId',
    'startTime',
    'duration',
    'status',
    'title',
    'isOnline',
  ])('rejects explicit null for nonnullable update field %s', async (field) => {
    await expect(update({ [field]: null })).rejects.toMatchObject({ status: 400 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('preserves legitimate nullable metadata updates', async () => {
    await update({ description: null, location: null, meetingUrl: null });
    expect(db.appointment.update.mock.calls[0][0].data).toMatchObject({
      description: null,
      location: null,
      meetingUrl: null,
    });
  });

  it('derives specialty for legacy-only reassignment', async () => {
    await update({ psychologistId: 'professional-2' });
    expect(db.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          professionalId: 'professional-2',
          psychologistId: 'professional-2',
          specialtyId: 'nutrition',
        }),
      }),
    );
  });

  it('checks current working hours on reassignment even when the time is unchanged', async () => {
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['MONDAY'],
      workingHoursStart: '09:00',
      workingHoursEnd: '17:00',
    });
    await expect(
      update({ professionalId: 'professional-2', specialtyId: 'nutrition' }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: expect.stringMatching(/^(NON_WORKING_DAY|OUTSIDE_WORKING_HOURS)$/) },
    });
    expect(db.appointment.update).not.toHaveBeenCalled();
    expect(team.ensureActive).not.toHaveBeenCalled();
  });

  it('reports a non-working day with a stable code and the configured days in the message', async () => {
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['MONDAY', 'WEDNESDAY'],
      workingHoursStart: '00:00',
      workingHoursEnd: '23:59',
      timezone: 'UTC',
    });
    await expect(create(createInput())).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'NON_WORKING_DAY',
        message: 'No se pueden programar citas el día Martes. Días laborales: Lunes, Miércoles',
      },
    });
    expect(db.appointment.create).not.toHaveBeenCalled();
  });

  it('reports a time outside working hours with a stable code and the configured hours in the message', async () => {
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['TUESDAY'],
      workingHoursStart: '14:00',
      workingHoursEnd: '18:00',
      timezone: 'UTC',
    });
    await expect(create(createInput())).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'OUTSIDE_WORKING_HOURS',
        message: 'Las citas deben estar dentro del horario laboral: 14:00 - 18:00',
      },
    });
    expect(db.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects contradictory identifiers on reassignment before writing', async () => {
    await expect(
      update({
        professionalId: 'professional-2',
        psychologistId: 'professional-3',
        specialtyId: 'nutrition',
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PROFESSIONAL_REFERENCE_MISMATCH' } });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('preserves historical specialty for title-only edits with unchanged identifiers', async () => {
    db.appointment.findFirst.mockResolvedValue(row({ specialtyId: 'historic-specialty' }));
    db.appointment.update.mockImplementation(async ({ data }) =>
      row({ specialtyId: 'historic-specialty', ...data }),
    );
    const result = await update({
      title: 'Follow-up',
      professionalId: 'professional-1',
      specialtyId: 'historic-specialty',
    });
    expect(eligibility.resolve).not.toHaveBeenCalled();
    expect(result.specialtyId).toBe('historic-specialty');
    expect(db.appointment.update.mock.calls[0][0].data).not.toHaveProperty('specialtyId');
  });

  it('does not revalidate current profile for a description-only edit', async () => {
    db.appointment.findFirst.mockResolvedValue(row({ specialtyId: 'historic-specialty' }));
    await update({ description: 'New note' });
    expect(eligibility.resolve).not.toHaveBeenCalled();
    expect(team.ensureActive).not.toHaveBeenCalled();
    expect(db.appointment.update.mock.calls[0][0].data).toEqual({ description: 'New note' });
  });

  it('revalidates eligibility when the appointment interval changes', async () => {
    await update({ startTime: '2026-09-29T15:00:00.000Z' });
    expect(eligibility.resolve).toHaveBeenCalledWith(db, tenantId, 'professional-1', 'nutrition');
    expect(db.appointment.findMany).toHaveBeenCalledTimes(1);
  });

  it('reactivates a cancelled booking only after current checks and clears cancellation metadata', async () => {
    db.appointment.findFirst.mockResolvedValue(
      row({
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledBy: 'admin-1',
        cancellationReason: 'Prior cancellation',
      }),
    );
    await update({ status: 'SCHEDULED' });
    expect(eligibility.resolve).toHaveBeenCalledWith(db, tenantId, 'professional-1', 'nutrition');
    expect(db.tenantSettings.findUnique).toHaveBeenCalledWith({ where: { tenantId } });
    expect(db.appointment.findMany).toHaveBeenCalledTimes(1);
    expect(team.ensureActive).toHaveBeenCalledWith(db, {
      tenantId,
      patientId: 'patient-1',
      professionalId: 'professional-1',
      assignedById: 'admin-1',
    });
    expect(db.appointment.update.mock.calls[0][0].data).toMatchObject({
      status: 'SCHEDULED',
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    });
  });

  it('refuses reactivation when the current slot conflicts', async () => {
    db.appointment.findFirst.mockResolvedValue(row({ status: 'CANCELLED' }));
    db.appointment.findMany.mockResolvedValue([
      {
        id: 'other',
        startTime: new Date(startTime),
        endTime: new Date('2026-09-29T14:00:00.000Z'),
        patient: { firstName: 'Other', lastName: 'Patient' },
      },
    ]);
    await expect(update({ status: 'CONFIRMED' })).rejects.toMatchObject({
      status: 409,
      response: { code: 'APPOINTMENT_CONFLICT' },
    });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('audits cancellation through PATCH status', async () => {
    await update({ status: 'CANCELLED' }, assistant);
    expect(db.appointment.update.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledBy: 'assistant-1',
    });
    expect(eligibility.resolve).not.toHaveBeenCalled();
  });

  it('lets an owner cancel through PATCH without active team membership, like the cancel endpoint', async () => {
    team.assertActiveMembership.mockRejectedValue({ status: 403 });
    await update({ status: 'CANCELLED' }, clinician);
    expect(db.appointment.update.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'professional-1',
    });
    expect(team.assertActiveMembership).not.toHaveBeenCalled();
  });

  it('PATCH-cancels an archived patient appointment with audit metadata and normalized aliases', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    db.appointment.findFirst.mockResolvedValue(row({ professionalId: null, professional: null }));
    db.appointment.update.mockImplementation(async ({ data }) =>
      row({ professionalId: null, professional: null, ...data }),
    );
    const result = await update({ status: 'CANCELLED' }, clinician);
    expect(result).toMatchObject({
      status: 'CANCELLED',
      professionalId: 'professional-1',
      psychologistId: 'professional-1',
      cancelledAt: now,
      cancelledBy: 'professional-1',
      cancellationReason: null,
    });
    expect(result.professional).toEqual(result.psychologist);
    expect(db.patient.findFirst).not.toHaveBeenCalled();
    expect(team.assertActiveMembership).not.toHaveBeenCalled();
  });

  it('dedicated cancel also handles an archived patient and records the supplied reason', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    db.appointment.findFirst.mockResolvedValue(row({ professionalId: null, professional: null }));
    db.appointment.update.mockImplementation(async ({ data }) =>
      row({ professionalId: null, professional: null, ...data }),
    );
    const result = await cancel(clinician);
    expect(result).toMatchObject({
      status: 'CANCELLED',
      professionalId: 'professional-1',
      psychologistId: 'professional-1',
      cancelledAt: now,
      cancelledBy: 'professional-1',
      cancellationReason: 'Patient request',
    });
    expect(db.patient.findFirst).not.toHaveBeenCalled();
  });

  it('keeps active-patient validation for mixed cancellation and metadata edits', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    await expect(
      update({ status: 'CANCELLED', title: 'Changed' }, clinician),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('requires team edit permission for mixed cancellation payloads', async () => {
    team.assertActiveMembership.mockRejectedValue({ status: 403 });
    await expect(
      update({ status: 'CANCELLED', title: 'Changed' }, clinician),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('still rejects a third-party professional cancelling through PATCH', async () => {
    db.appointment.findFirst.mockResolvedValue(
      row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
    );
    await expect(update({ status: 'CANCELLED' }, clinician)).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('does not revalidate or reassign for a non-cancellation status-only transition', async () => {
    await update({ status: 'CONFIRMED' });
    expect(eligibility.resolve).not.toHaveBeenCalled();
    expect(db.tenantSettings.findUnique).not.toHaveBeenCalled();
    expect(db.appointment.findMany).not.toHaveBeenCalled();
    expect(team.ensureActive).not.toHaveBeenCalled();
  });

  it('propagates a specialty mismatch from authoritative eligibility', async () => {
    eligibility.resolve.mockRejectedValue({
      status: 422,
      response: { code: 'PROFESSIONAL_SPECIALTY_MISMATCH' },
    });
    await expect(create(createInput())).rejects.toMatchObject({
      status: 422,
      response: { code: 'PROFESSIONAL_SPECIALTY_MISMATCH' },
    });
    expect(db.appointment.create).not.toHaveBeenCalled();
  });

  it('requires active membership before a professional creates for self', async () => {
    await create(createInput(), clinician);
    expect(team.assertActiveMembership).toHaveBeenCalledWith(
      db,
      tenantId,
      'patient-1',
      'professional-1',
    );
    expect(team.ensureActive).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ assignedById: clinician.userId }),
    );
  });

  it('rejects a professional creating for another professional', async () => {
    await expect(
      create(createInput({ professionalId: 'professional-2' }), clinician),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects a professional without active membership before eligibility lookup', async () => {
    team.assertActiveMembership.mockRejectedValue({ status: 403 });
    await expect(create(createInput(), clinician)).rejects.toMatchObject({ status: 403 });
    expect(eligibility.resolve).not.toHaveBeenCalled();
  });

  it('allows a team member to read another professional appointment for that patient', async () => {
    db.appointment.findFirst.mockResolvedValue(
      row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
    );
    await expect(get(clinician)).resolves.toMatchObject({ id: 'appointment-1' });
    expect(team.assertActiveMembership).toHaveBeenCalledWith(
      prisma,
      tenantId,
      'patient-1',
      'professional-1',
    );
  });

  it('allows an owner to read without a team assignment', async () => {
    await expect(get(clinician)).resolves.toMatchObject({ id: 'appointment-1' });
    expect(team.assertActiveMembership).not.toHaveBeenCalled();
  });

  it('returns 403 for a professional not assigned to the patient', async () => {
    db.appointment.findFirst.mockResolvedValue(
      row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
    );
    team.assertActiveMembership.mockRejectedValue({ status: 403 });
    await expect(get(clinician)).rejects.toMatchObject({ status: 403 });
  });

  it('allows only the owner to update or cancel an appointment', async () => {
    db.appointment.findFirst.mockResolvedValue(
      row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
    );
    await expect(update({ title: 'Changed' }, clinician)).rejects.toMatchObject({ status: 403 });
    await expect(cancel(clinician)).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it.each([
    { patientId: 'patient-2' },
    { professionalId: 'professional-2', specialtyId: 'nutrition' },
    { specialtyId: 'psychology' },
  ])('rejects a professional changing patient, professional or specialty', async (change) => {
    await expect(update(change, clinician)).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('requires active patient membership before a professional edits own appointment', async () => {
    team.assertActiveMembership.mockRejectedValue({ status: 403 });
    await expect(update({ title: 'Changed' }, clinician)).rejects.toMatchObject({ status: 403 });
  });

  it('composes actor and professional filters independently with legacy fallback', async () => {
    await list({ professionalId: 'professional-2', specialtyId: 'nutrition' }, clinician);
    const where = db.appointment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId, specialtyId: 'nutrition' });
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { professionalId: 'professional-2' },
            { professionalId: null, psychologistId: 'professional-2' },
          ],
        },
        expect.objectContaining({
          OR: expect.arrayContaining([
            { professionalId: 'professional-1' },
            { professionalId: null, psychologistId: 'professional-1' },
          ]),
        }),
      ]),
    );
  });

  describe('calendar scope', () => {
    const own = {
      OR: [
        { professionalId: 'professional-1' },
        { professionalId: null, psychologistId: 'professional-1' },
      ],
    };
    const listedWhere = () => db.appointment.findMany.mock.calls[0][0].where;

    it('shows a professional only their own appointments', async () => {
      await list({}, clinician);

      expect(listedWhere().AND).toEqual([own]);
    });

    it('keeps the appointments of an assigned patient visible in the patient record', async () => {
      await list({ patientId: 'patient-1' }, clinician);

      expect(listedWhere().patientId).toBe('patient-1');
      expect(listedWhere().AND).toEqual([
        {
          OR: [
            ...own.OR,
            {
              patient: {
                is: {
                  tenantId,
                  deletedAt: null,
                  professionalAssignments: {
                    some: { tenantId, professionalId: 'professional-1', isActive: true },
                  },
                },
              },
            },
          ],
        },
      ]);
    });

    it('shows the master every professional at once', async () => {
      await list({}, admin);

      expect(listedWhere().AND).toEqual([]);
    });

    it('asks an assistant to choose a professional instead of showing every calendar', async () => {
      await expect(
        list({ from: '2026-09-28', branchId: 'branch-1' }, assistant),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'APPOINTMENT_PROFESSIONAL_REQUIRED' },
      });
      expect(db.appointment.findMany).not.toHaveBeenCalled();
    });

    it('shows an assistant the calendar of the chosen professional', async () => {
      await list({ professionalId: 'professional-2' }, assistant);

      expect(listedWhere().AND).toEqual([
        {
          OR: [
            { professionalId: 'professional-2' },
            { professionalId: null, psychologistId: 'professional-2' },
          ],
        },
      ]);
    });

    it('shows an assistant the appointments of one patient without choosing a professional', async () => {
      await list({ patientId: 'patient-1' }, assistant);

      expect(listedWhere()).toMatchObject({ patientId: 'patient-1', AND: [] });
    });
  });

  it('rejects contradictory professional filters', async () => {
    await expect(list({ professionalId: 'one', psychologistId: 'two' })).rejects.toMatchObject({
      status: 400,
      response: { code: 'PROFESSIONAL_REFERENCE_MISMATCH' },
    });
  });

  it.each([
    ['create', { professionalId: '', psychologistId: 'professional-1', specialtyId: 'nutrition' }],
    ['update', { professionalId: '', psychologistId: 'professional-1', specialtyId: 'nutrition' }],
    ['list', { professionalId: '', psychologistId: 'professional-1' }],
  ])('%s rejects differing aliases even if one is empty', async (operation, input) => {
    const action =
      operation === 'create'
        ? create(createInput(input))
        : operation === 'update'
          ? update(input)
          : list(input);
    await expect(action).rejects.toMatchObject({
      status: 400,
      response: { code: 'PROFESSIONAL_REFERENCE_MISMATCH' },
    });
  });

  it.each(['create', 'update', 'list'])(
    '%s rejects a supplied empty professional identifier',
    async (operation) => {
      const action =
        operation === 'create'
          ? create(createInput({ professionalId: '' }))
          : operation === 'update'
            ? update({ professionalId: '' })
            : list({ professionalId: '' });
      await expect(action).rejects.toMatchObject({ status: 400 });
      expect(db.appointment.create).not.toHaveBeenCalled();
      expect(db.appointment.update).not.toHaveBeenCalled();
      expect(db.appointment.findMany).not.toHaveBeenCalled();
    },
  );

  it('applies a legacy-only professional filter to canonical and unmigrated rows', async () => {
    await list({ psychologistId: 'professional-2' });
    expect(db.appointment.findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        { professionalId: 'professional-2' },
        { professionalId: null, psychologistId: 'professional-2' },
      ],
    });
  });

  it('returns normalized legacy appointment aliases and excludes clinical notes', async () => {
    db.appointment.findFirst.mockResolvedValue(row({ professionalId: null, professional: null }));
    const result = await get();
    expect(result.professionalId).toBe('professional-1');
    expect(result.psychologistId).toBe('professional-1');
    expect(result.professional).toEqual(result.psychologist);
    expect(db.appointment.findFirst.mock.calls[0][0].include).not.toHaveProperty('clinicalNotes');
  });

  it('normalizes list and cancellation responses', async () => {
    db.appointment.findMany.mockResolvedValue([row({ professionalId: null, professional: null })]);
    const items = await list();
    expect(items[0]).toMatchObject({
      professionalId: 'professional-1',
      psychologistId: 'professional-1',
    });
    db.appointment.update.mockResolvedValue(
      row({ professionalId: null, professional: null, status: 'CANCELLED' }),
    );
    const cancelled = await cancel(assistant);
    expect(cancelled).toMatchObject({
      professionalId: 'professional-1',
      psychologistId: 'professional-1',
      status: 'CANCELLED',
    });
    expect(db.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancelledBy: 'assistant-1',
          cancellationReason: 'Patient request',
        }),
      }),
    );
  });

  it('rechecks team and conflict on each serialization retry', async () => {
    prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(db);
        throw { code: 'P2034' };
      })
      .mockImplementationOnce((callback) => callback(db));
    await create(createInput());
    expect(db.patient.findFirst).toHaveBeenCalledTimes(2);
    expect(eligibility.resolve).toHaveBeenCalledTimes(2);
    expect(db.appointment.findMany).toHaveBeenCalledTimes(2);
    expect(team.ensureActive).toHaveBeenCalledTimes(2);
    expect(db.appointment.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a start that becomes past before a create retry', async () => {
    prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(db);
        jest.setSystemTime(new Date('2026-09-29T14:00:00.000Z'));
        throw { code: 'P2034' };
      })
      .mockImplementationOnce((callback) => callback(db));
    await expect(create(createInput())).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(db.appointment.create).toHaveBeenCalledTimes(1);
  });

  it('rechecks update ownership after a serialization retry and rejects the former owner', async () => {
    db.appointment.findFirst
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(
        row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
      );
    prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(db);
        throw { code: 'P2034' };
      })
      .mockImplementationOnce((callback) => callback(db));
    await expect(update({ title: 'Changed' }, clinician)).rejects.toMatchObject({ status: 403 });
    expect(db.appointment.update).toHaveBeenCalledTimes(1);
  });

  it('rechecks cancellation ownership in the same transaction after reassignment', async () => {
    db.appointment.findFirst
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(
        row({ professionalId: 'professional-2', psychologistId: 'professional-2' }),
      );
    prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(db);
        throw { code: 'P2034' };
      })
      .mockImplementationOnce((callback) => callback(db));
    await expect(cancel(clinician)).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(db.appointment.findFirst).toHaveBeenCalledTimes(2);
    expect(db.appointment.update).toHaveBeenCalledTimes(1);
    expect(prisma.appointment.update).toHaveBeenCalledTimes(1);
  });

  it('evaluates working hours in the tenant time zone, not the server zone', async () => {
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
      workingHoursStart: '09:00',
      workingHoursEnd: '18:00',
      timezone: 'Asia/Tokyo', // UTC+9, no DST
    });

    // 01:00 UTC is 10:00 in Tokyo: inside working hours.
    await expect(
      create(createInput({ startTime: '2026-09-29T01:00:00.000Z' })),
    ).resolves.toMatchObject({ id: 'appointment-1' });
    // 15:00 UTC is 00:00 in Tokyo: outside working hours.
    await expect(
      create(createInput({ startTime: '2026-09-29T15:00:00.000Z' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('skips conflict detection on create and reschedule when the tenant allows double booking', async () => {
    db.tenantSettings.findUnique.mockResolvedValue({
      workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
      workingHoursStart: '00:00',
      workingHoursEnd: '23:59',
      timezone: 'UTC',
      allowDoubleBooking: true,
    });

    await create(createInput());
    await update({ startTime: '2026-09-29T15:00:00.000Z' });

    expect(db.appointment.findMany).not.toHaveBeenCalled();
    expect(db.appointment.create).toHaveBeenCalledTimes(1);
    expect(db.appointment.update).toHaveBeenCalledTimes(1);
  });

  it('resets reminder flags only when the appointment start moves', async () => {
    await update({ startTime: '2026-09-29T15:00:00.000Z' });
    expect(db.appointment.update.mock.calls[0][0].data).toMatchObject({
      reminderSent24h: false,
      reminderSent2h: false,
    });

    db.appointment.update.mockClear();
    await update({ title: 'Seguimiento' });
    expect(db.appointment.update.mock.calls[0][0].data).not.toHaveProperty('reminderSent24h');
    expect(db.appointment.update.mock.calls[0][0].data).not.toHaveProperty('reminderSent2h');
  });

  it('rejects moving an appointment into the past', async () => {
    await expect(update({ startTime: '2026-09-28T11:00:00.000Z' })).rejects.toMatchObject({
      status: 400,
      message: 'No se pueden mover citas al pasado',
    });
    expect(db.appointment.update).not.toHaveBeenCalled();
  });

  it('keeps reminder records using the psychologist relation', async () => {
    db.appointment.findMany.mockResolvedValue([
      row({
        reminderSent24h: false,
        reminderSent2h: false,
        startTime: new Date('2026-09-29T12:00:00.000Z'),
      }),
    ]);
    const reminders = await service.findAppointmentsNeedingReminders([24]);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].appointment.psychologist).toMatchObject({ id: 'professional-1' });
    const { select } = db.appointment.findMany.mock.calls[0][0].include.psychologist;
    expect(select).toMatchObject({ id: true, email: true });
    expect(select.password).toBeUndefined();
  });
});

describe('AppointmentsController actor forwarding', () => {
  it('forwards the authenticated actor to every endpoint', async () => {
    const actor = {
      userId: 'assistant-1',
      tenantId: 'tenant-1',
      role: 'ASISTENTE',
      email: 'a@example.test',
    };
    const service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
    };
    const permissions = { assertAllowed: jest.fn() };
    const controller = new AppointmentsController(
      service as unknown as AppointmentsService,
      permissions as unknown as PermissionChecker,
    );
    await (controller as any).create('tenant-1', {} as any, actor);
    await (controller as any).findAll('tenant-1', {} as any, actor);
    await (controller as any).findOne('tenant-1', 'appointment-1', actor);
    await (controller as any).update('tenant-1', 'appointment-1', {} as any, actor);
    await (controller as any).cancel('tenant-1', 'appointment-1', { reason: 'x' }, actor);
    expect(service.create).toHaveBeenCalledWith('tenant-1', {}, actor);
    expect(service.findAll).toHaveBeenCalledWith('tenant-1', {}, actor);
    expect(service.findOne).toHaveBeenCalledWith('tenant-1', 'appointment-1', actor);
    expect(service.update).toHaveBeenCalledWith('tenant-1', 'appointment-1', {}, actor);
    expect(service.cancel).toHaveBeenCalledWith('tenant-1', 'appointment-1', 'x', actor);
    // An ordinary update asks for nothing beyond the route's own permission.
    expect(permissions.assertAllowed).not.toHaveBeenCalled();
  });

  it('asks for the cancel permission when an update cancels the appointment', async () => {
    const actor = { userId: 'assistant-1', tenantId: 'tenant-1', role: 'ASISTENTE' };
    const service = { update: jest.fn() };
    const permissions = {
      assertAllowed: jest.fn().mockRejectedValue(new ForbiddenException('withdrawn')),
    };
    const controller = new AppointmentsController(
      service as unknown as AppointmentsService,
      permissions as unknown as PermissionChecker,
    );

    await expect(
      (controller as any).update('tenant-1', 'appointment-1', { status: 'CANCELLED' }, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(permissions.assertAllowed).toHaveBeenCalledWith(actor, 'appointments.cancel');
    expect(service.update).not.toHaveBeenCalled();
  });
});
