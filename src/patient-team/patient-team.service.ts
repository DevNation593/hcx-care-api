import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { toCanonicalRole } from '../common/roles/role-compatibility';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { EligibleProfessional, TeamActor, TeamDb } from './patient-team.types';
import { ProfessionalEligibilityService } from './professional-eligibility.service';

const specialtySelect = { id: true, code: true, name: true } as const;
const patientTeamInclude = {
  assignedBy: { select: { id: true, firstName: true, lastName: true } },
  professional: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      isActive: true,
      professionalTitle: true,
      licenseNumber: true,
      professionalProfile: { include: { specialty: true } },
    },
  },
} satisfies Prisma.PatientProfessionalInclude;

type TeamRow = Prisma.PatientProfessionalGetPayload<{ include: typeof patientTeamInclude }>;

@Injectable()
export class PatientTeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ProfessionalEligibilityService,
  ) {}

  async list(tenantId: string, patientId: string, actor: TeamActor) {
    this.assertActorScope(tenantId, actor);
    this.authorizeRead(actor);
    await this.findPatient(this.prisma, tenantId, patientId);
    const rows = await this.prisma.patientProfessional.findMany({
      where: { tenantId, patientId },
      include: patientTeamInclude,
    });
    const enabled = await this.prisma.tenantSpecialty.findMany({
      where: { tenantId },
      select: { specialtyId: true },
    });
    const specialtyIds = new Set(enabled.map((item) => item.specialtyId));
    return rows
      .map((row) => this.toTeamMember(row, specialtyIds))
      .sort((a, b) => {
        const active = Number(b.isActive) - Number(a.isActive);
        if (active) return active;
        const aSpecialty = a.professional.specialty?.name;
        const bSpecialty = b.professional.specialty?.name;
        if (aSpecialty == null && bSpecialty != null) return 1;
        if (aSpecialty != null && bSpecialty == null) return -1;
        return (
          (aSpecialty ?? '').localeCompare(bSpecialty ?? '') ||
          a.professional.lastName.localeCompare(b.professional.lastName) ||
          a.professional.firstName.localeCompare(b.professional.firstName) ||
          a.id.localeCompare(b.id)
        );
      });
  }

  async listEligible(
    tenantId: string,
    patientId: string,
    specialtyId: string | undefined,
    actor: TeamActor,
  ) {
    this.assertActorScope(tenantId, actor);
    await this.authorize(this.prisma, tenantId, patientId, actor);
    await this.findPatient(this.prisma, tenantId, patientId);
    const professionals = await this.eligibility.list(this.prisma, tenantId, specialtyId);
    const assignments = await this.prisma.patientProfessional.findMany({
      where: { tenantId, patientId },
      select: { professionalId: true, isActive: true },
    });
    const assigned = new Map(assignments.map((row) => [row.professionalId, row.isActive]));
    return professionals.map((user) => ({
      ...this.toProfessional(user),
      isAssigned: assigned.get(user.id) === true,
    }));
  }

  async assign(tenantId: string, patientId: string, professionalId: string, actor: TeamActor) {
    this.assertActorScope(tenantId, actor);
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      await this.authorize(tx, tenantId, patientId, actor);
      await this.findPatient(tx, tenantId, patientId);
      const assignment = await this.ensureActive(tx, {
        tenantId,
        patientId,
        professionalId,
        assignedById: actor.userId,
      });
      return this.toTeamMember(assignment);
    });
  }

  // Transaction helpers are shared by trusted tenant-scoped domain callers.
  // They deliberately do not start nested transactions or infer an actor role.
  async ensureActive(
    db: Prisma.TransactionClient,
    input: { tenantId: string; patientId: string; professionalId: string; assignedById: string },
  ): Promise<TeamRow> {
    const { tenantId, patientId, professionalId, assignedById } = input;
    await this.eligibility.resolve(db, tenantId, professionalId);
    await this.findPatient(db, tenantId, patientId);
    const assignmentId = randomUUID();
    const assignedAt = new Date();
    await db.$executeRaw`
      INSERT INTO "PatientProfessional" (
        "id", "tenantId", "patientId", "professionalId", "assignedAt",
        "assignedById", "isActive", "createdAt", "updatedAt"
      ) VALUES (
        ${assignmentId}, ${tenantId}, ${patientId}, ${professionalId}, ${assignedAt},
        ${assignedById}, TRUE, ${assignedAt}, ${assignedAt}
      )
      ON CONFLICT ("patientId", "professionalId") DO UPDATE
      SET
        "isActive" = TRUE,
        "assignedAt" = EXCLUDED."assignedAt",
        "assignedById" = EXCLUDED."assignedById",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "PatientProfessional"."isActive" = FALSE
    `;
    const assignment = await db.patientProfessional.findUniqueOrThrow({
      where: { patientId_professionalId: { patientId, professionalId } },
      include: patientTeamInclude,
    });
    if (assignment.tenantId !== tenantId) throw new NotFoundException('Asignación no encontrada');
    await db.patient.updateMany({
      where: { id: patientId, tenantId, assignedPsychologistId: null },
      data: { assignedPsychologistId: professionalId },
    });
    return assignment;
  }

  async remove(tenantId: string, patientId: string, professionalId: string, actor: TeamActor) {
    this.assertActorScope(tenantId, actor);
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      await this.authorize(tx, tenantId, patientId, actor, true);
      const patient = await this.findPatient(tx, tenantId, patientId);
      const assignment = await tx.patientProfessional.findUnique({
        where: { patientId_professionalId: { patientId, professionalId } },
        include: patientTeamInclude,
      });
      if (!assignment || assignment.tenantId !== tenantId) {
        throw new NotFoundException('Asignación no encontrada');
      }
      await this.assertNoFutureAppointments(tx, tenantId, professionalId, patientId);
      const result = assignment.isActive
        ? await tx.patientProfessional.update({
            where: { id: assignment.id, tenantId },
            data: { isActive: false },
            include: patientTeamInclude,
          })
        : assignment;
      if (patient.assignedPsychologistId === professionalId) {
        const remaining = await tx.patientProfessional.findFirst({
          where: { tenantId, patientId, isActive: true, professionalId: { not: professionalId } },
          orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
          select: { professionalId: true },
        });
        await tx.patient.updateMany({
          where: { id: patientId, tenantId, assignedPsychologistId: professionalId },
          data: { assignedPsychologistId: remaining?.professionalId ?? null },
        });
      }
      return this.toTeamMember(result);
    });
  }

  async assertActiveMembership(
    db: TeamDb,
    tenantId: string,
    patientId: string,
    professionalId: string,
  ): Promise<void> {
    const assignment = await db.patientProfessional.findUnique({
      where: { patientId_professionalId: { patientId, professionalId } },
    });
    if (!assignment || assignment.tenantId !== tenantId || !assignment.isActive) {
      throw this.teamForbidden();
    }
    try {
      await this.eligibility.resolve(db, tenantId, professionalId);
    } catch (error) {
      if (error instanceof HttpException && [403, 404, 409].includes(error.getStatus())) {
        throw this.teamForbidden();
      }
      throw error;
    }
  }

  async assertNoFutureAppointmentsForProfessional(
    db: TeamDb,
    tenantId: string,
    professionalId: string,
  ): Promise<void> {
    await this.assertNoFutureAppointments(db, tenantId, professionalId);
  }

  async deactivateAllForProfessional(db: TeamDb, tenantId: string, professionalId: string) {
    const result = await db.patientProfessional.updateMany({
      where: { tenantId, professionalId, isActive: true },
      data: { isActive: false },
    });
    return result.count;
  }

  private async assertNoFutureAppointments(
    db: TeamDb,
    tenantId: string,
    professionalId: string,
    patientId?: string,
  ) {
    const appointments = await db.appointment.findMany({
      where: {
        tenantId,
        ...(patientId ? { patientId } : {}),
        startTime: { gt: new Date() },
        status: { not: 'CANCELLED' },
        OR: [{ professionalId }, { professionalId: null, psychologistId: professionalId }],
      },
      select: {
        id: true,
        patientId: true,
        startTime: true,
        status: true,
        title: true,
        specialty: { select: specialtySelect },
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    });
    if (appointments.length) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS',
        message: 'El profesional tiene citas futuras. Cancélalas o reasígnalas antes de continuar.',
        details: { appointments },
      });
    }
  }

  private assertActorScope(tenantId: string, actor: TeamActor) {
    if (actor.tenantId !== tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'No tienes acceso a la información de esta cuenta master.',
      });
    }
  }

  private async authorize(
    db: TeamDb,
    tenantId: string,
    patientId: string,
    actor: TeamActor,
    administrativeOnly = false,
  ) {
    const role = toCanonicalRole(actor.role);
    if (role === 'MASTER' || role === 'ASISTENTE') return;
    if (role !== 'PROFESIONAL' || administrativeOnly) throw this.teamForbidden();
    await this.assertActiveMembership(db, tenantId, patientId, actor.userId);
  }

  /** Reading is open to every clinical role of the clinic; changing the team still needs membership. */
  private authorizeRead(actor: TeamActor) {
    const role = toCanonicalRole(actor.role);
    if (role !== 'MASTER' && role !== 'ASISTENTE' && role !== 'PROFESIONAL') {
      throw this.teamForbidden();
    }
  }

  private teamForbidden() {
    return new ForbiddenException({
      statusCode: 403,
      code: 'TEAM_ASSIGNMENT_FORBIDDEN',
      message: 'No tienes permiso para modificar este equipo tratante.',
    });
  }

  private async findPatient(db: TeamDb, tenantId: string, patientId: string) {
    const patient = await db.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true, tenantId: true, assignedPsychologistId: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    return patient;
  }

  private toProfessional(user: TeamRow['professional'] | EligibleProfessional) {
    const profile = user.professionalProfile;
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      professionalTitle:
        profile?.professionalTitle ?? ('professionalTitle' in user ? user.professionalTitle : null),
      licenseNumber:
        profile?.licenseNumber ?? ('licenseNumber' in user ? user.licenseNumber : null),
      specialty: profile
        ? { id: profile.specialty.id, code: profile.specialty.code, name: profile.specialty.name }
        : null,
    };
  }

  private toTeamMember(row: TeamRow, enabledSpecialtyIds?: Set<string>) {
    const profile = row.professional.professionalProfile;
    return {
      id: row.id,
      patientId: row.patientId,
      professionalId: row.professionalId,
      assignedAt: row.assignedAt,
      assignedBy: row.assignedBy,
      isActive:
        row.isActive &&
        row.professional.isActive &&
        profile?.isActive === true &&
        profile.specialty.isActive &&
        (!enabledSpecialtyIds || enabledSpecialtyIds.has(profile.specialtyId)),
      professional: this.toProfessional(row.professional),
    };
  }
}
