import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PatientTeamService } from '../patient-team/patient-team.service';
import { toCanonicalRole } from '../common/roles/role-compatibility';
import { LEGACY_BILLING_OMIT } from './legacy-billing';
import { CreatePatientDto, PatientListStatus, UpdatePatientDto } from './dto/patient.dto';
import { isPaginated, pageMeta, PageRequest, pageWindow } from '../common/pagination/pagination';
import { escapeLike } from '../common/pagination/escape-like';
import { readInTransaction } from '../common/pagination/read-in-transaction';
import {
  assertGuardianForMinor,
  mergePatientIdentification,
  normalizeTaxId,
  PatientIdentification,
} from './patient-identity';

const IDENTIFICATION_FIELDS = ['identificationType', 'identificationNumber'] as const;

// Free-text demographic columns: trimmed, and stored as null when left blank.
const PROFILE_FIELDS = [
  'maritalStatus',
  'occupation',
  'nationality',
  'bloodType',
  'disability',
  'insuranceProvider',
  'insurancePolicyNumber',
  'guardianName',
  'guardianRelationship',
  'guardianIdentification',
  'guardianPhone',
] as const;

type MergedFields = (typeof IDENTIFICATION_FIELDS)[number];

export interface PatientListOptions extends PageRequest {
  status?: PatientListStatus;
}

/**
 * The DTO without its identification keys; those are written only through
 * mergePatientIdentification.
 */
function withoutMergedFields(dto: UpdatePatientDto): Omit<UpdatePatientDto, MergedFields> {
  const copy: Record<string, unknown> = { ...dto };
  for (const field of IDENTIFICATION_FIELDS) delete copy[field];
  return copy;
}

const identificationTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PATIENT_IDENTIFICATION_TAKEN',
    message: 'Ya existe un paciente con esa identificación.',
  });

@Injectable()
export class PatientsService {
  constructor(
    private prisma: PrismaService,
    private patientTeam: PatientTeamService,
  ) {}

  private normalizeOptionalString(value?: string | null): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeDateOfBirth(value?: string): Date | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    // HTML date inputs send YYYY-MM-DD; Prisma DateTime expects a Date instance or full ISO datetime.
    return new Date(`${trimmed}T00:00:00.000Z`);
  }

  private profileFields(dto: UpdatePatientDto) {
    return Object.fromEntries(
      PROFILE_FIELDS.map((field) => [field, this.normalizeOptionalString(dto[field])]),
    ) as Record<(typeof PROFILE_FIELDS)[number], string | null | undefined>;
  }

  /** Identification columns to write on update, or nothing when the request does not mention them. */
  private identificationUpdate(current: PatientIdentification, dto: UpdatePatientDto) {
    if (!IDENTIFICATION_FIELDS.some((field) => dto[field] !== undefined)) return {};
    return mergePatientIdentification(current, dto);
  }

  /** The pair is unique among live patients; the partial index backs this check against races. */
  private async assertIdentificationFree(
    tx: Prisma.TransactionClient,
    tenantId: string,
    identification: Partial<PatientIdentification>,
    exceptPatientId?: string,
  ) {
    if (!identification.identificationNumber) return;
    const other = await tx.patient.findFirst({
      where: {
        tenantId,
        identificationType: identification.identificationType,
        identificationNumber: identification.identificationNumber,
        deletedAt: null,
        ...(exceptPatientId ? { id: { not: exceptPatientId } } : {}),
      },
      select: { id: true },
    });
    if (other) throw identificationTaken();
  }

  private sanitizeCreatePayload(createPatientDto: CreatePatientDto) {
    return {
      ...createPatientDto,
      ...this.profileFields(createPatientDto),
      ...mergePatientIdentification(null, createPatientDto),
      dateOfBirth: this.normalizeDateOfBirth(createPatientDto.dateOfBirth),
      email: this.normalizeOptionalString(createPatientDto.email),
      phone: this.normalizeOptionalString(createPatientDto.phone),
      gender: this.normalizeOptionalString(createPatientDto.gender),
      address: this.normalizeOptionalString(createPatientDto.address),
      emergencyContact: this.normalizeOptionalString(createPatientDto.emergencyContact),
      emergencyPhone: this.normalizeOptionalString(createPatientDto.emergencyPhone),
      emergencyContactName: this.normalizeOptionalString(createPatientDto.emergencyContactName),
      emergencyContactPhone: this.normalizeOptionalString(createPatientDto.emergencyContactPhone),
      assignedPsychologistId: this.normalizeOptionalString(createPatientDto.assignedPsychologistId),
      allergies: this.normalizeOptionalString(createPatientDto.allergies),
      currentMedication: this.normalizeOptionalString(createPatientDto.currentMedication),
      notes: this.normalizeOptionalString(createPatientDto.notes),
    };
  }

  private sanitizeUpdatePayload(updatePatientDto: UpdatePatientDto) {
    return {
      ...withoutMergedFields(updatePatientDto),
      ...this.profileFields(updatePatientDto),
      dateOfBirth: this.normalizeDateOfBirth(updatePatientDto.dateOfBirth),
      email: this.normalizeOptionalString(updatePatientDto.email),
      phone: this.normalizeOptionalString(updatePatientDto.phone),
      gender: this.normalizeOptionalString(updatePatientDto.gender),
      address: this.normalizeOptionalString(updatePatientDto.address),
      emergencyContact: this.normalizeOptionalString(updatePatientDto.emergencyContact),
      emergencyPhone: this.normalizeOptionalString(updatePatientDto.emergencyPhone),
      emergencyContactName: this.normalizeOptionalString(updatePatientDto.emergencyContactName),
      emergencyContactPhone: this.normalizeOptionalString(updatePatientDto.emergencyContactPhone),
      assignedPsychologistId: this.normalizeOptionalString(updatePatientDto.assignedPsychologistId),
      allergies: this.normalizeOptionalString(updatePatientDto.allergies),
      currentMedication: this.normalizeOptionalString(updatePatientDto.currentMedication),
      notes: this.normalizeOptionalString(updatePatientDto.notes),
    };
  }

  async create(
    tenantId: string,
    createPatientDto: CreatePatientDto,
    currentUserId: string,
    currentUserRole: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.prisma.applyRlsContext(tx, {
          tenantId,
          userId: currentUserId,
          role: currentUserRole,
        });

        const sanitized = this.sanitizeCreatePayload(createPatientDto);
        const assignedPsychologistId = sanitized.assignedPsychologistId;
        if (assignedPsychologistId && toCanonicalRole(currentUserRole) === 'PROFESIONAL') {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'TEAM_ASSIGNMENT_FORBIDDEN',
            message: 'No tienes permiso para modificar este equipo tratante.',
          });
        }

        let subscription = await tx.tenantSubscription.findUnique({
          where: { tenantId },
        });

        // Some RLS policies only allow admins to read subscription details.
        if (!subscription && currentUserRole !== 'MASTER') {
          await this.prisma.applyRlsContext(tx, {
            tenantId,
            userId: currentUserId,
            role: 'MASTER',
          });
          subscription = await tx.tenantSubscription.findUnique({
            where: { tenantId },
          });

          // Restore effective caller context before patient write.
          await this.prisma.applyRlsContext(tx, {
            tenantId,
            userId: currentUserId,
            role: currentUserRole,
          });
        }

        this.assertCanCreatePatient(tenantId, subscription);
        assertGuardianForMinor(sanitized.dateOfBirth, sanitized.guardianName);
        await this.assertIdentificationFree(tx, tenantId, sanitized);

        const patient = await tx.patient.create({
          omit: LEGACY_BILLING_OMIT,
          data: {
            ...sanitized,
            tenantId,
          },
        });

        if (assignedPsychologistId) {
          await this.patientTeam.ensureActive(tx, {
            tenantId,
            patientId: patient.id,
            professionalId: assignedPsychologistId,
            assignedById: currentUserId,
          });
        }

        // Maintain usage counters; if RLS blocks this for non-admin roles, retry under admin context.
        let updated = await tx.tenantSubscription.updateMany({
          where: {
            tenantId,
            activePatientsCount: { lt: subscription.maxActivePatients },
          },
          data: { activePatientsCount: { increment: 1 } },
        });

        if (updated.count === 0 && currentUserRole !== 'MASTER') {
          await this.prisma.applyRlsContext(tx, {
            tenantId,
            userId: currentUserId,
            role: 'MASTER',
          });
          updated = await tx.tenantSubscription.updateMany({
            where: {
              tenantId,
              activePatientsCount: { lt: subscription.maxActivePatients },
            },
            data: { activePatientsCount: { increment: 1 } },
          });
        }

        if (updated.count === 0) {
          throw new ForbiddenException({
            error: 'PATIENT_LIMIT_REACHED',
            message: `Límite de pacientes alcanzado. Tu plan permite ${subscription.maxActivePatients} paciente(s) activo(s). Contacta a soporte para ampliarlo.`,
            details: {
              maxActivePatients: subscription.maxActivePatients,
              activePatientsCount: subscription.activePatientsCount,
            },
          });
        }

        return patient;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private assertCanCreatePatient(tenantId: string, subscription: any) {
    if (!subscription) {
      throw new ForbiddenException('No se encontró suscripción para esta clínica');
    }

    // Check subscription status
    if (subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING') {
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'No se pueden crear pacientes. Tu suscripción no está activa.',
        status: subscription.status,
      });
    }

    // Check patient limit
    if (subscription.activePatientsCount >= subscription.maxActivePatients) {
      throw new ForbiddenException({
        error: 'PATIENT_LIMIT_REACHED',
        message: `Límite de pacientes alcanzado. Tu plan permite ${subscription.maxActivePatients} paciente(s) activo(s). Contacta a soporte para ampliarlo.`,
        details: {
          maxActivePatients: subscription.maxActivePatients,
          activePatientsCount: subscription.activePatientsCount,
        },
      });
    }
  }

  /**
   * Without `page`/`limit` this is the whole list as an array (what the mobile app and the
   * selectors read). With either one it is a page: `{ data, meta }`. Both use the same `where`.
   */
  async findAll(tenantId: string, search?: string, options: PatientListOptions = {}) {
    const status = options.status ?? 'active';
    const where: any = {
      tenantId,
      deletedAt: null,
    };
    // Active only unless the caller asks otherwise; deleted patients are never listed.
    if (status !== 'all') {
      where.isActive = status === 'active';
    }

    if (search) {
      // Stored without spaces or hyphens, so the search term is compared the same way. A term
      // made only of those ("-") has nothing to compare and must not match every identification.
      const identification = normalizeTaxId(search);
      // Prisma does not escape the LIKE wildcards of `contains`: "%" or "_" would match everything.
      const term = escapeLike(search);
      where.OR = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
        ...(identification
          ? [{ identificationNumber: { contains: escapeLike(identification) } }]
          : []),
      ];
    }

    const query = {
      where,
      omit: LEGACY_BILLING_OMIT,
      include: {
        assignedPsychologist: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
            role: true,
          },
        },
      },
    };

    if (!isPaginated(options)) {
      return this.prisma.patient.findMany({ ...query, orderBy: { lastName: 'asc' } });
    }

    const { page, limit, skip, take } = pageWindow(options);
    // One transaction, queries in sequence on `tx` (see readInTransaction).
    return readInTransaction(this.prisma, async (tx) => {
      const total = await tx.patient.count({ where });
      const data = await tx.patient.findMany({
        ...query,
        // `id` breaks ties between equal last names so no row repeats or vanishes between pages.
        orderBy: [{ lastName: 'asc' }, { id: 'asc' }],
        skip,
        take,
      });
      return { data, meta: pageMeta(total, page, limit) };
    });
  }

  async findOne(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      omit: LEGACY_BILLING_OMIT,
      where: {
        id: patientId,
        tenantId,
        deletedAt: null,
      },
      include: {
        assignedPsychologist: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
          },
        },
        appointments: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { startTime: 'desc' },
          take: 10,
        },
        _count: {
          select: {
            appointments: true,
            clinicalNotes: { where: { deletedAt: null } },
            tasks: true,
          },
        },
      },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    return patient;
  }

  async update(
    tenantId: string,
    patientId: string,
    updatePatientDto: UpdatePatientDto,
    currentUserId: string,
    currentUserRole: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.prisma.applyRlsContext(tx, {
          tenantId,
          userId: currentUserId,
          role: currentUserRole,
        });

        const patient = await tx.patient.findFirst({
          where: { id: patientId, tenantId, deletedAt: null },
        });

        if (!patient) {
          throw new NotFoundException('Paciente no encontrado');
        }

        const { assignedPsychologistId, ...otherData } =
          this.sanitizeUpdatePayload(updatePatientDto);
        if (assignedPsychologistId && toCanonicalRole(currentUserRole) === 'PROFESIONAL') {
          await this.patientTeam.assertActiveMembership(tx, tenantId, patientId, currentUserId);
        }

        const identification = this.identificationUpdate(patient, updatePatientDto);
        await this.assertIdentificationFree(tx, tenantId, identification, patientId);
        // Checked only when the request touches the birth date or the guardian, so a minor
        // registered before the rule existed can still have other fields edited.
        if (otherData.dateOfBirth !== undefined || otherData.guardianName !== undefined) {
          assertGuardianForMinor(
            otherData.dateOfBirth === undefined ? patient.dateOfBirth : otherData.dateOfBirth,
            otherData.guardianName === undefined ? patient.guardianName : otherData.guardianName,
          );
        }

        const updated = await tx.patient.update({
          omit: LEGACY_BILLING_OMIT,
          where: { id: patientId },
          data: {
            ...otherData,
            ...identification,
            ...(assignedPsychologistId !== undefined ? { assignedPsychologistId } : {}),
          },
        });

        if (assignedPsychologistId) {
          await this.patientTeam.ensureActive(tx, {
            tenantId,
            patientId,
            professionalId: assignedPsychologistId,
            assignedById: currentUserId,
          });
        }

        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async softDelete(
    tenantId: string,
    patientId: string,
    currentUserId: string,
    currentUserRole: string,
  ) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    if (!patient.isActive || patient.deletedAt) {
      return { success: true, message: 'El paciente ya está desactivado' };
    }

    // Update patient and decrement counter in a transaction
    await this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx, {
        tenantId,
        userId: currentUserId,
        role: currentUserRole,
      });

      await tx.patient.update({
        where: { id: patientId },
        data: {
          isActive: false,
          deletedAt: new Date(),
        },
      });

      let subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });

      if (!subscription && currentUserRole !== 'MASTER') {
        await this.prisma.applyRlsContext(tx, {
          tenantId,
          userId: currentUserId,
          role: 'MASTER',
        });
        subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });
      }

      if (subscription && subscription.activePatientsCount > 0) {
        await tx.tenantSubscription.updateMany({
          where: {
            tenantId,
            activePatientsCount: { gt: 0 },
          },
          data: { activePatientsCount: { decrement: 1 } },
        });
      }
    });

    return { success: true, message: 'Patient deactivated successfully' };
  }
}
