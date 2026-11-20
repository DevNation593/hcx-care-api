import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { assertBranchAvailable, assertProfessionalInBranch } from '../branches/branches.service';
import { toCanonicalRole } from '../common/roles/role-compatibility';
import { PUBLIC_USER_SELECT } from '../common/utils/public-user-select';
import { getZonedDateParts } from '../common/utils/timezone';
import { PatientTeamService } from '../patient-team/patient-team.service';
import { TeamActor, TeamDb } from '../patient-team/patient-team.types';
import { ProfessionalEligibilityService } from '../patient-team/professional-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';

const userSelect = { id: true, firstName: true, lastName: true, email: true } as const;
const patientSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
} as const;
const appointmentInclude = {
  patient: { select: patientSelect },
  professional: { select: userSelect },
  psychologist: { select: userSelect },
  specialty: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, name: true } },
} satisfies Prisma.AppointmentInclude;
type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;
type ProfessionalReference = {
  professionalId?: string;
  psychologistId?: string;
  specialtyId?: string;
};

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ProfessionalEligibilityService,
    private readonly team: PatientTeamService,
  ) {}

  async create(tenantId: string, input: CreateAppointmentDto, actor: TeamActor) {
    this.assertActor(tenantId, actor);
    const reference = this.normalizeProfessionalReference(input)!;
    const start = this.parseStart(input.startTime);
    const end = this.endTime(start, input.duration);

    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      if (start < new Date())
        throw new BadRequestException('No se pueden crear citas en el pasado');
      await this.findPatient(tx, tenantId, input.patientId);
      await this.authorizeCreate(tx, tenantId, input.patientId, reference.professionalId, actor);
      const specialtyId = await this.resolveSpecialty(tx, tenantId, reference);
      if (input.branchId) {
        await assertBranchAvailable(tx, tenantId, input.branchId);
        await assertProfessionalInBranch(tx, tenantId, reference.professionalId, input.branchId);
      }
      const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
      this.assertWorkingHours(settings, start);
      if (!settings?.allowDoubleBooking) {
        await this.checkConflicts(tx, tenantId, reference.professionalId, start, end);
      }
      await this.team.ensureActive(tx, {
        tenantId,
        patientId: input.patientId,
        professionalId: reference.professionalId,
        assignedById: actor.userId,
      });
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          professionalId: reference.professionalId,
          psychologistId: reference.professionalId,
          specialtyId,
          startTime: start,
          endTime: end,
          duration: input.duration,
          status: AppointmentStatus.SCHEDULED,
          ...(input.branchId && { branchId: input.branchId }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.location !== undefined && { location: input.location }),
          ...(input.isOnline !== undefined && { isOnline: input.isOnline }),
          ...(input.meetingUrl !== undefined && { meetingUrl: input.meetingUrl }),
        },
        include: appointmentInclude,
      });
      return this.normalizeAppointment(appointment);
    });
  }

  async findAll(tenantId: string, filters: ListAppointmentsQueryDto, actor: TeamActor) {
    this.assertActor(tenantId, actor);
    const reference = this.normalizeProfessionalReference(filters, false);
    const role = toCanonicalRole(actor.role);
    const where: Prisma.AppointmentWhereInput = { tenantId, AND: [] };
    if (reference?.professionalId) {
      (where.AND as Prisma.AppointmentWhereInput[]).push(
        this.professionalMatch(reference.professionalId),
      );
    }
    // Without a patient the list is a calendar, and only the master sees every professional
    // at once. Inside a patient record the treating team still sees that patient's appointments.
    const isCalendar = !filters.patientId;
    if (role === 'ASISTENTE' && isCalendar && !reference?.professionalId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'APPOINTMENT_PROFESSIONAL_REQUIRED',
        message: 'Selecciona un profesional para ver su calendario.',
      });
    }
    if (role === 'PROFESIONAL') {
      const own = this.professionalMatch(actor.userId);
      (where.AND as Prisma.AppointmentWhereInput[]).push(
        isCalendar
          ? own
          : {
              OR: [
                ...(own.OR as Prisma.AppointmentWhereInput[]),
                {
                  patient: {
                    is: {
                      tenantId,
                      deletedAt: null,
                      professionalAssignments: {
                        some: { tenantId, professionalId: actor.userId, isActive: true },
                      },
                    },
                  },
                },
              ],
            },
      );
    }
    if (filters.specialtyId) where.specialtyId = filters.specialtyId;
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.patientId) where.patientId = filters.patientId;
    if (filters.status) where.status = filters.status;
    if (filters.from || filters.to) {
      where.startTime = {
        ...(filters.from && { gte: new Date(filters.from) }),
        ...(filters.to && { lte: new Date(filters.to) }),
      };
    }
    const appointments = await this.prisma.appointment.findMany({
      where,
      include: appointmentInclude,
      orderBy: { startTime: 'asc' },
    });
    return appointments.map((item) => this.normalizeAppointment(item));
  }

  async findOne(tenantId: string, appointmentId: string, actor: TeamActor) {
    this.assertActor(tenantId, actor);
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId },
      include: appointmentInclude,
    });
    if (!appointment) throw new NotFoundException('Cita no encontrada');
    await this.authorizeRead(this.prisma, tenantId, appointment, actor);
    return this.normalizeAppointment(appointment);
  }

  async update(
    tenantId: string,
    appointmentId: string,
    input: UpdateAppointmentDto,
    actor: TeamActor,
  ) {
    this.assertActor(tenantId, actor);
    this.assertNonNullUpdateFields(input);
    const pureCancellation =
      input.status === AppointmentStatus.CANCELLED &&
      Object.entries(input).every(([field, value]) => field === 'status' || value === undefined);
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const existing = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId } });
      if (!existing) throw new NotFoundException('Cita no encontrada');
      const currentProfessionalId = existing.professionalId ?? existing.psychologistId;
      if (pureCancellation) {
        this.assertCancellationOwnership(currentProfessionalId, actor);
        const cancelled = await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            status: AppointmentStatus.CANCELLED,
            ...this.cancellationData(actor.userId, null),
          },
          include: appointmentInclude,
        });
        return this.normalizeAppointment(cancelled);
      }
      await this.findPatient(tx, tenantId, existing.patientId);
      await this.authorizeUpdate(tx, tenantId, existing.patientId, currentProfessionalId, actor);
      if (input.branchId && input.branchId !== existing.branchId) {
        await assertBranchAvailable(tx, tenantId, input.branchId);
      }

      const hasProfessionalReference =
        input.professionalId !== undefined || input.psychologistId !== undefined;
      const reference = hasProfessionalReference
        ? this.normalizeProfessionalReference(input)!
        : undefined;
      const professionalId = reference?.professionalId ?? currentProfessionalId;
      const patientId = input.patientId ?? existing.patientId;
      let specialtyId = input.specialtyId ?? existing.specialtyId;
      const start =
        input.startTime === undefined ? existing.startTime : this.parseStart(input.startTime);
      const duration = input.duration ?? existing.duration;
      const end = this.endTime(start, duration);
      const patientChanged = patientId !== existing.patientId;
      const professionalChanged = professionalId !== currentProfessionalId;
      const specialtyChanged = specialtyId !== existing.specialtyId;
      const branchId = input.branchId === undefined ? existing.branchId : input.branchId;
      if (branchId && (professionalChanged || branchId !== existing.branchId)) {
        await assertProfessionalInBranch(tx, tenantId, professionalId, branchId);
      }
      const rescheduled = start.getTime() !== existing.startTime.getTime();
      const intervalChanged = rescheduled || duration !== existing.duration;
      const reactivating =
        existing.status === AppointmentStatus.CANCELLED &&
        input.status !== undefined &&
        input.status !== AppointmentStatus.CANCELLED;
      const cancelling =
        existing.status !== AppointmentStatus.CANCELLED &&
        input.status === AppointmentStatus.CANCELLED;

      if (
        toCanonicalRole(actor.role) === 'PROFESIONAL' &&
        (patientChanged || professionalChanged || specialtyChanged)
      )
        throw this.appointmentForbidden();
      if (patientChanged) await this.findPatient(tx, tenantId, patientId);
      if (professionalChanged && reference?.legacyOnly && !input.specialtyId) {
        specialtyId = undefined;
      }
      if (professionalChanged && reference && !reference.legacyOnly && !input.specialtyId) {
        throw this.specialtyRequired();
      }
      if (professionalChanged || specialtyChanged || intervalChanged || reactivating) {
        const resolved = await this.resolveSpecialty(tx, tenantId, {
          professionalId,
          specialtyId: specialtyId ?? undefined,
          legacyOnly: professionalChanged && !!reference?.legacyOnly,
        });
        specialtyId = resolved;
      }
      if (intervalChanged || reactivating) {
        if (start < new Date()) throw new BadRequestException('No se pueden mover citas al pasado');
      }
      if (professionalChanged || intervalChanged || reactivating) {
        const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
        this.assertWorkingHours(settings, start);
        if (!settings?.allowDoubleBooking) {
          await this.checkConflicts(tx, tenantId, professionalId, start, end, appointmentId);
        }
      }
      if (patientChanged || professionalChanged || reactivating) {
        await this.team.ensureActive(tx, {
          tenantId,
          patientId,
          professionalId,
          assignedById: actor.userId,
        });
      }
      const appointment = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          ...(patientChanged && { patientId }),
          ...(professionalChanged && { professionalId, psychologistId: professionalId }),
          ...((professionalChanged || specialtyChanged) && { specialtyId }),
          ...(intervalChanged && { startTime: start, endTime: end, duration }),
          // A moved appointment must be reminded again at its new time.
          ...(rescheduled && { reminderSent24h: false, reminderSent2h: false }),
          // Null takes the appointment out of any branch.
          ...(input.branchId !== undefined && { branchId: input.branchId }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.location !== undefined && { location: input.location }),
          ...(input.isOnline !== undefined && { isOnline: input.isOnline }),
          ...(input.meetingUrl !== undefined && { meetingUrl: input.meetingUrl }),
          ...(input.status !== undefined && { status: input.status }),
          ...(cancelling && this.cancellationData(actor.userId, null)),
          ...(reactivating && {
            cancelledAt: null,
            cancelledBy: null,
            cancellationReason: null,
          }),
        },
        include: appointmentInclude,
      });
      return this.normalizeAppointment(appointment);
    });
  }

  async cancel(tenantId: string, appointmentId: string, reason: string, actor: TeamActor) {
    this.assertActor(tenantId, actor);
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, tenantId },
      });
      if (!appointment) throw new NotFoundException('Cita no encontrada');
      this.assertCancellationOwnership(
        appointment.professionalId ?? appointment.psychologistId,
        actor,
      );
      const updated = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.CANCELLED,
          ...this.cancellationData(actor.userId, reason),
        },
        include: appointmentInclude,
      });
      return this.normalizeAppointment(updated);
    });
  }

  private cancellationData(userId: string, reason: string | null) {
    return { cancelledAt: new Date(), cancelledBy: userId, cancellationReason: reason };
  }

  private assertCancellationOwnership(professionalId: string, actor: TeamActor) {
    if (toCanonicalRole(actor.role) === 'PROFESIONAL' && professionalId !== actor.userId) {
      throw this.appointmentForbidden();
    }
  }

  private assertNonNullUpdateFields(input: UpdateAppointmentDto) {
    /** What each field is called in the message the user reads. */
    const fieldLabels: Record<string, string> = {
      patientId: 'el paciente',
      professionalId: 'el profesional',
      psychologistId: 'el profesional',
      specialtyId: 'la especialidad',
      startTime: 'la fecha y hora de inicio',
      duration: 'la duración',
      status: 'el estado',
      title: 'el título',
      isOnline: 'si la cita es presencial o en línea',
    };
    for (const [field, label] of Object.entries(fieldLabels)) {
      if ((input as unknown as Record<string, unknown>)[field] === null) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'APPOINTMENT_FIELD_INVALID',
          message: `Indica ${label} de la cita.`,
        });
      }
    }
  }

  private assertActor(tenantId: string, actor: TeamActor) {
    if (!actor || actor.tenantId !== tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'No tienes acceso a la información de este consultorio.',
      });
    }
    if (!['MASTER', 'ASISTENTE', 'PROFESIONAL'].includes(toCanonicalRole(actor.role) ?? '')) {
      throw this.appointmentForbidden();
    }
  }

  private appointmentForbidden() {
    return new ForbiddenException({
      statusCode: 403,
      code: 'APPOINTMENT_FORBIDDEN',
      message: 'No tienes permiso para esta cita.',
    });
  }

  private normalizeProfessionalReference(
    input: ProfessionalReference,
    required = true,
  ): { professionalId: string; specialtyId?: string; legacyOnly: boolean } | undefined {
    const hasProfessional = input.professionalId !== undefined;
    const hasPsychologist = input.psychologistId !== undefined;
    if (hasProfessional && hasPsychologist && input.professionalId !== input.psychologistId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PROFESSIONAL_REFERENCE_MISMATCH',
        message:
          'No se pudo identificar al profesional seleccionado. Vuelve a elegirlo e inténtalo de nuevo.',
      });
    }
    if (!hasProfessional && !hasPsychologist) {
      if (!required) return undefined;
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PROFESSIONAL_REQUIRED',
        message: 'Selecciona un profesional.',
      });
    }
    const professionalId = hasProfessional ? input.professionalId : input.psychologistId;
    if (typeof professionalId !== 'string' || !professionalId.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PROFESSIONAL_REFERENCE_INVALID',
        message: 'Selecciona un identificador profesional válido.',
      });
    }
    return {
      professionalId,
      specialtyId: input.specialtyId,
      legacyOnly: !hasProfessional && hasPsychologist,
    };
  }

  private specialtyRequired() {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'SPECIALTY_REQUIRED',
      message: 'Selecciona una especialidad para el profesional.',
    });
  }

  private async resolveSpecialty(
    db: TeamDb,
    tenantId: string,
    reference: { professionalId: string; specialtyId?: string; legacyOnly: boolean },
  ) {
    const professional = await this.eligibility.resolve(
      db,
      tenantId,
      reference.professionalId,
      reference.specialtyId,
    );
    if (!reference.specialtyId && !reference.legacyOnly) throw this.specialtyRequired();
    return reference.specialtyId ?? professional.professionalProfile!.specialtyId;
  }

  private async findPatient(db: TeamDb, tenantId: string, patientId: string) {
    const patient = await db.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    return patient;
  }

  private async authorizeCreate(
    db: TeamDb,
    tenantId: string,
    patientId: string,
    professionalId: string,
    actor: TeamActor,
  ) {
    if (toCanonicalRole(actor.role) !== 'PROFESIONAL') return;
    if (professionalId !== actor.userId) throw this.appointmentForbidden();
    await this.team.assertActiveMembership(db, tenantId, patientId, actor.userId);
  }

  private async authorizeRead(
    db: TeamDb,
    tenantId: string,
    appointment: { patientId: string; professionalId: string | null; psychologistId: string },
    actor: TeamActor,
  ) {
    if (toCanonicalRole(actor.role) !== 'PROFESIONAL') return;
    if ((appointment.professionalId ?? appointment.psychologistId) === actor.userId) return;
    await this.team.assertActiveMembership(db, tenantId, appointment.patientId, actor.userId);
  }

  private async authorizeUpdate(
    db: TeamDb,
    tenantId: string,
    patientId: string,
    professionalId: string,
    actor: TeamActor,
  ) {
    if (toCanonicalRole(actor.role) !== 'PROFESIONAL') return;
    if (professionalId !== actor.userId) throw this.appointmentForbidden();
    await this.team.assertActiveMembership(db, tenantId, patientId, actor.userId);
  }

  private professionalMatch(professionalId: string): Prisma.AppointmentWhereInput {
    return { OR: [{ professionalId }, { professionalId: null, psychologistId: professionalId }] };
  }

  private parseStart(value: string): Date {
    const start = new Date(value);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Fecha de inicio inválida');
    return start;
  }

  private endTime(start: Date, duration: number): Date {
    if (!Number.isInteger(duration) || duration < 15 || duration > 240) {
      throw new BadRequestException('Duración inválida');
    }
    return new Date(start.getTime() + duration * 60000);
  }

  /** Working days and hours are evaluated in the tenant's own time zone, not the server's. */
  private assertWorkingHours(
    settings: {
      workingDays: string[];
      workingHoursStart: string;
      workingHoursEnd: string;
      timezone?: string | null;
    } | null,
    start: Date,
  ) {
    if (!settings) return;
    const { dayOfWeek, minutesOfDay } = getZonedDateParts(start, settings.timezone);
    const dayLabels: Record<string, string> = {
      MONDAY: 'Lunes',
      TUESDAY: 'Martes',
      WEDNESDAY: 'Miércoles',
      THURSDAY: 'Jueves',
      FRIDAY: 'Viernes',
      SATURDAY: 'Sábado',
      SUNDAY: 'Domingo',
    };
    if (!settings.workingDays.includes(dayOfWeek)) {
      const days = settings.workingDays.map((day) => dayLabels[day] || day).join(', ');
      throw new BadRequestException({
        statusCode: 400,
        code: 'NON_WORKING_DAY',
        error: 'NON_WORKING_DAY',
        message: `No se pueden programar citas el día ${dayLabels[dayOfWeek] || dayOfWeek}. Días laborales: ${days}`,
      });
    }
    const [startHour, startMinute] = settings.workingHoursStart.split(':').map(Number);
    const [endHour, endMinute] = settings.workingHoursEnd.split(':').map(Number);
    if (minutesOfDay < startHour * 60 + startMinute || minutesOfDay >= endHour * 60 + endMinute) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'OUTSIDE_WORKING_HOURS',
        error: 'OUTSIDE_WORKING_HOURS',
        message: `Las citas deben estar dentro del horario laboral: ${settings.workingHoursStart} - ${settings.workingHoursEnd}`,
      });
    }
  }

  private async checkConflicts(
    db: TeamDb,
    tenantId: string,
    professionalId: string,
    start: Date,
    end: Date,
    excludeAppointmentId?: string,
  ) {
    const conflicts = await db.appointment.findMany({
      where: {
        tenantId,
        status: { not: AppointmentStatus.CANCELLED },
        ...(excludeAppointmentId && { id: { not: excludeAppointmentId } }),
        AND: [
          this.professionalMatch(professionalId),
          {
            OR: [
              { startTime: { lte: start }, endTime: { gt: start } },
              { startTime: { lt: end }, endTime: { gte: end } },
              { startTime: { gte: start }, endTime: { lte: end } },
            ],
          },
        ],
      },
      include: { patient: { select: { firstName: true, lastName: true } } },
    });
    if (!conflicts.length) return;
    const details = conflicts.map((item) => ({
      id: item.id,
      patient: `${item.patient.firstName} ${item.patient.lastName}`,
      startTime: item.startTime,
      endTime: item.endTime,
    }));
    throw new ConflictException({
      statusCode: 409,
      code: 'APPOINTMENT_CONFLICT',
      error: 'APPOINTMENT_CONFLICT',
      message: 'Este horario tiene conflicto con cita(s) existente(s)',
      details: { conflicts: details },
    });
  }

  private normalizeAppointment(row: AppointmentRow) {
    const professionalId = row.professionalId ?? row.psychologistId;
    const professional = row.professional ?? row.psychologist;
    return {
      ...row,
      professionalId,
      professional,
      psychologistId: professionalId,
      psychologist: professional,
    };
  }

  /** Reminder-worker internals retain the legacy psychologist relation during migration. */
  async findAppointmentsNeedingReminders(hoursBeforeList: number[]) {
    const now = new Date();
    const appointments = await this.prisma.appointment.findMany({
      where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startTime: { gte: now } },
      include: {
        patient: true,
        psychologist: { select: PUBLIC_USER_SELECT },
        tenant: { include: { settings: true } },
      },
    });
    const needingReminders = [];
    for (const appointment of appointments) {
      const hoursUntil = (appointment.startTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      for (const hoursBefore of hoursBeforeList) {
        const alreadySent =
          (hoursBefore === 24 && appointment.reminderSent24h) ||
          (hoursBefore === 2 && appointment.reminderSent2h);
        if (hoursUntil <= hoursBefore && hoursUntil > hoursBefore - 0.5 && !alreadySent) {
          needingReminders.push({ appointment, hoursBefore });
        }
      }
    }
    return needingReminders;
  }

  async markReminderSent(appointmentId: string, hoursBefore: number) {
    const updates: Prisma.AppointmentUpdateInput = { lastReminderSentAt: new Date() };
    if (hoursBefore === 24) updates.reminderSent24h = true;
    else if (hoursBefore === 2) updates.reminderSent2h = true;
    await this.prisma.appointment.update({ where: { id: appointmentId }, data: updates });
  }
}
