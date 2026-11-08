import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Encounter, EncounterType, Prisma } from '@prisma/client';
import { assertBranchAvailable } from '../branches/branches.service';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import {
  clinicalRecordForbidden,
  clinicalRecordNotFound,
} from '../clinical-access/clinical-errors';
import {
  encounterContentHash,
  noteContentHash,
  recordContentHash,
} from '../clinical-access/clinical-signature';
import { ENCRYPTED_NOTE_FIELDS } from '../clinical-notes/encrypted-note-fields';
import { PrismaService } from '../prisma/prisma.service';
import {
  CloseEncounterDto,
  DeleteEncounterDto,
  StartEncounterDto,
  UpdateEncounterDto,
} from './dto/encounter.dto';

const encounterInclude = {
  professional: { select: { id: true, firstName: true, lastName: true } },
  specialty: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, name: true } },
  appointment: { select: { id: true, title: true, startTime: true } },
} satisfies Prisma.EncounterInclude;

/** Stored encrypted; everything outside this service works with the decrypted encounter. */
export const ENCRYPTED_ENCOUNTER_FIELDS = ['reason', 'summary'] as const;

const UNATTENDED: AppointmentStatus[] = [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED];

type EncounterDb = PrismaService | Prisma.TransactionClient;

/** The clinical state of an encounter, stored in the audit log with every change. */
export function snapshotEncounter(encounter: Encounter) {
  return {
    version: encounter.version,
    patientId: encounter.patientId,
    professionalId: encounter.professionalId,
    specialtyId: encounter.specialtyId,
    appointmentId: encounter.appointmentId,
    branchId: encounter.branchId,
    encounterType: encounter.encounterType,
    status: encounter.status,
    reason: encounter.reason,
    summary: encounter.summary,
    startedAt: encounter.startedAt,
    closedAt: encounter.closedAt,
    signedAt: encounter.signedAt,
    signedById: encounter.signedById,
    contentHash: encounter.contentHash,
  };
}

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ statusCode: 409, code, message, ...extra });

/** The encounter of a treatment session follows the session; the encounters routes leave it alone. */
function assertNotManagedBySession(encounter: { treatmentSession?: { id: string } | null }) {
  if (encounter.treatmentSession) {
    throw conflict(
      'ENCOUNTER_MANAGED_BY_SESSION',
      'Esta atención pertenece a una sesión de tratamiento y se gestiona desde ella.',
      { treatmentSessionId: encounter.treatmentSession.id },
    );
  }
}

/**
 * A record can be written into an encounter only while it is open and by the professional
 * who is attending it. Throws 404, 403 CLINICAL_RECORD_FORBIDDEN or 409 ENCOUNTER_CLOSED.
 */
export async function assertOpenEncounter(
  db: EncounterDb,
  tenantId: string,
  patientId: string,
  encounterId: string,
  actor: ClinicalActor,
): Promise<void> {
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, tenantId, patientId, deletedAt: null },
    select: { professionalId: true, status: true },
  });
  if (!encounter) throw clinicalRecordNotFound('Atención no encontrada');
  if (encounter.professionalId !== actor.userId) {
    throw clinicalRecordForbidden('Solo puedes registrar en tus propias atenciones');
  }
  if (encounter.status !== 'OPEN') {
    throw conflict('ENCOUNTER_CLOSED', 'La atención ya está cerrada.');
  }
}

/**
 * Holds the encounter open until the caller's transaction ends: it takes a shared lock on the
 * row, so closing (which signs what the encounter holds) waits for writes already under way, and
 * a write that starts after the close sees it closed. Returns false when it is not open.
 */
export async function lockOpenEncounter(
  tx: Prisma.TransactionClient,
  tenantId: string,
  encounterId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Encounter"
    WHERE "id" = ${encounterId} AND "tenantId" = ${tenantId}
      AND "status" = 'OPEN' AND "deletedAt" IS NULL
    FOR SHARE`;
  return rows.length > 0;
}

@Injectable()
export class EncountersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  /** Encounters of the patient, newest first, with how many live records each one holds. */
  async list(tenantId: string, patientId: string, actor: ClinicalActor) {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.encounter.findMany({
      where: { tenantId, patientId, deletedAt: null },
      include: {
        ...encounterInclude,
        _count: { select: { records: { where: { deletedAt: null } } } },
      },
      orderBy: { startedAt: 'desc' },
    });

    await this.audit.record(
      tenantId,
      actor,
      stored.map((encounter) => ({
        action: 'READ' as const,
        entity: 'ENCOUNTER' as const,
        entityId: encounter.id,
        patientId,
      })),
    );

    return stored.map(({ _count, ...encounter }) => ({
      ...this.decrypt(encounter),
      recordCount: _count.records,
    }));
  }

  async start(tenantId: string, patientId: string, actor: ClinicalActor, dto: StartEncounterDto) {
    await this.assertPatient(tenantId, patientId);
    if (dto.branchId) await assertBranchAvailable(this.prisma, tenantId, dto.branchId);

    return this.transaction(async (tx) => {
      const encounter = await this.openEncounter(tx, tenantId, patientId, actor, dto);
      return { ...encounter, recordCount: 0 };
    });
  }

  /**
   * Opens an encounter of the caller with the patient inside the caller's transaction and
   * audits it. One open encounter per professional and patient (409 ENCOUNTER_ALREADY_OPEN);
   * with an appointment, only its professional attends it and it is marked in progress.
   * `startedAt` is only accepted from the encounters routes; every other caller gets the
   * server time.
   */
  async openEncounter(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    input: {
      encounterType: EncounterType;
      reason: string;
      appointmentId?: string;
      branchId?: string;
      startedAt?: string;
    },
  ): Promise<Encounter> {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (input.branchId) await assertBranchAvailable(tx, tenantId, input.branchId);

    const open = await tx.encounter.findFirst({
      where: {
        tenantId,
        patientId,
        professionalId: actor.userId,
        status: 'OPEN',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (open) {
      throw conflict(
        'ENCOUNTER_ALREADY_OPEN',
        'Ya tienes una atención abierta con este paciente. Ciérrala antes de iniciar otra.',
        { encounterId: open.id },
      );
    }

    const appointment = input.appointmentId
      ? await this.findAttendableAppointment(tx, tenantId, patientId, input.appointmentId, actor)
      : null;

    const stored = await tx.encounter.create({
      data: {
        tenantId,
        patientId,
        professionalId: actor.userId,
        specialtyId: actor.specialtyId,
        appointmentId: appointment?.id,
        branchId: input.branchId ?? appointment?.branchId ?? undefined,
        encounterType: input.encounterType,
        reason: this.crypto.encrypt(tenantId, input.reason.trim()),
        startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
      },
      include: encounterInclude,
    });
    const encounter = this.decrypt(stored);

    if (appointment) {
      await tx.appointment.updateMany({
        where: { id: appointment.id, tenantId, status: { in: UNATTENDED } },
        data: { status: AppointmentStatus.IN_PROGRESS },
      });
    }

    await this.audit.record(
      tenantId,
      actor,
      [
        {
          action: 'CREATE',
          entity: 'ENCOUNTER',
          entityId: encounter.id,
          patientId,
          after: snapshotEncounter(encounter),
        },
      ],
      tx,
    );

    return encounter;
  }

  /** Type and reason can change while the encounter is open; a closed one is final. */
  async update(
    tenantId: string,
    patientId: string,
    encounterId: string,
    actor: ClinicalActor,
    dto: UpdateEncounterDto,
  ) {
    return this.transaction(async (tx) => {
      const current = await this.findOwnOpen(tx, tenantId, patientId, encounterId, actor, 'editar');
      assertNotManagedBySession(current);

      const stored = await tx.encounter.update({
        where: { id: encounterId },
        data: {
          ...(dto.encounterType ? { encounterType: dto.encounterType } : {}),
          ...(typeof dto.reason === 'string'
            ? { reason: this.crypto.encrypt(tenantId, dto.reason.trim()) }
            : {}),
          version: { increment: 1 },
        },
        include: encounterInclude,
      });
      const encounter = this.decrypt(stored);

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'ENCOUNTER',
            entityId: encounterId,
            patientId,
            before: snapshotEncounter(current),
            after: snapshotEncounter(encounter),
          },
        ],
        tx,
      );

      return encounter;
    });
  }

  /** The professional's sign-off: the encounter takes no more records and its appointment is completed. */
  async close(
    tenantId: string,
    patientId: string,
    encounterId: string,
    actor: ClinicalActor,
    dto: CloseEncounterDto,
  ) {
    return this.transaction(async (tx) => {
      const current = await this.findOwnOpen(tx, tenantId, patientId, encounterId, actor, 'cerrar');
      assertNotManagedBySession(current);
      return this.closeEncounter(tx, tenantId, encounterId, actor, dto.summary);
    });
  }

  /**
   * Closes an open encounter of the caller inside the caller's transaction, completes its
   * appointment and audits it. Treatment sessions close their own encounter through it.
   * `anyAuthor` lets a caller that already authorized the actor close another professional's
   * encounter (the tenant MASTER revoking a consent); the audit still names the actor.
   */
  async closeEncounter(
    tx: Prisma.TransactionClient,
    tenantId: string,
    encounterId: string,
    actor: ClinicalActor,
    summary?: string,
    options: { anyAuthor?: boolean } = {},
  ): Promise<Encounter> {
    // Writes into the encounter hold a shared lock on it: closing waits for them to finish, and
    // the ones that come after find it closed. What is signed below is therefore final.
    await tx.$queryRaw`SELECT "id" FROM "Encounter" WHERE "id" = ${encounterId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await this.findOwnOpen(
      tx,
      tenantId,
      null,
      encounterId,
      options.anyAuthor ? null : actor,
      'cerrar',
    );
    const trimmed = summary?.trim();
    const closedAt = new Date();
    const contentHash = await this.signContents(tx, tenantId, encounterId, closedAt, {
      ...current,
      summary: trimmed || current.summary,
      closedAt,
    });

    const stored = await tx.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'CLOSED',
        closedAt,
        ...(trimmed ? { summary: this.crypto.encrypt(tenantId, trimmed) } : {}),
        signedAt: closedAt,
        signedById: actor.userId,
        contentHash,
        version: { increment: 1 },
      },
      include: encounterInclude,
    });
    const encounter = this.decrypt(stored);

    if (current.appointmentId) {
      await tx.appointment.updateMany({
        where: {
          id: current.appointmentId,
          tenantId,
          status: { in: [...UNATTENDED, AppointmentStatus.IN_PROGRESS] },
        },
        data: { status: AppointmentStatus.COMPLETED },
      });
    }

    await this.audit.record(
      tenantId,
      actor,
      [
        {
          action: 'UPDATE',
          entity: 'ENCOUNTER',
          entityId: encounterId,
          patientId: current.patientId,
          before: snapshotEncounter(current),
          after: snapshotEncounter(encounter),
          reason: 'Cierre de la atención',
        },
      ],
      tx,
    );

    return encounter;
  }

  /**
   * Signs the records and notes the encounter holds as of `signedAt` and returns the hash of the
   * encounter, which covers theirs. Records keep the date of their last change: signing is not one.
   */
  private async signContents(
    tx: Prisma.TransactionClient,
    tenantId: string,
    encounterId: string,
    signedAt: Date,
    encounter: Parameters<typeof encounterContentHash>[0],
  ): Promise<string> {
    const records = await tx.specialtyRecord.findMany({
      where: { tenantId, encounterId, deletedAt: null },
    });
    const recordHashes: { id: string; contentHash: string }[] = [];
    for (const record of records) {
      const contentHash = recordContentHash({
        ...record,
        data: this.crypto.decryptJson(tenantId, record.data),
        notes: record.notes === null ? null : this.crypto.decrypt(tenantId, record.notes),
        amendmentReason:
          record.amendmentReason === null
            ? null
            : this.crypto.decrypt(tenantId, record.amendmentReason),
      });
      recordHashes.push({ id: record.id, contentHash });
      if (!record.signedAt) {
        await tx.specialtyRecord.update({
          where: { id: record.id },
          data: { signedAt, contentHash, updatedAt: record.updatedAt },
        });
      }
    }

    const notes = await tx.clinicalNote.findMany({
      where: { tenantId, encounterId, deletedAt: null },
    });
    const noteHashes = notes.map((stored) => {
      const note = this.crypto.decryptFields(tenantId, stored, ENCRYPTED_NOTE_FIELDS);
      return { id: note.id, contentHash: noteContentHash(note) };
    });

    return encounterContentHash(encounter, recordHashes, noteHashes);
  }

  /** An encounter started by mistake. It must hold no records; the row stays for audit. */
  async delete(
    tenantId: string,
    patientId: string,
    encounterId: string,
    actor: ClinicalActor,
    dto: DeleteEncounterDto,
  ) {
    return this.transaction(async (tx) => {
      const current = await this.findOwn(tx, tenantId, patientId, encounterId, actor, 'eliminar');
      assertNotManagedBySession(current);
      if (current.status === 'CLOSED') {
        throw conflict(
          'ENCOUNTER_SIGNED',
          'La atención está cerrada y firmada: no se puede eliminar.',
        );
      }

      const records = await tx.specialtyRecord.count({ where: { encounterId, deletedAt: null } });
      if (records > 0) {
        throw conflict(
          'ENCOUNTER_HAS_RECORDS',
          'La atención tiene registros. Elimínalos antes de eliminar la atención.',
        );
      }

      await tx.encounter.update({
        where: { id: encounterId },
        data: {
          deletedAt: new Date(),
          deletedById: actor.userId,
          deletionReason: this.crypto.encrypt(tenantId, dto.reason),
          // Frees the appointment so it can be attended in another encounter.
          appointmentId: null,
        },
      });
      if (current.appointmentId && current.status === 'OPEN') {
        await tx.appointment.updateMany({
          where: { id: current.appointmentId, tenantId, status: AppointmentStatus.IN_PROGRESS },
          data: { status: AppointmentStatus.SCHEDULED },
        });
      }

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'DELETE',
            entity: 'ENCOUNTER',
            entityId: encounterId,
            patientId,
            before: snapshotEncounter(current),
            reason: dto.reason,
          },
        ],
        tx,
      );

      return { message: 'Atención eliminada exitosamente' };
    });
  }

  private async findAttendableAppointment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    appointmentId: string,
    actor: ClinicalActor,
  ) {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, tenantId, patientId },
      select: {
        id: true,
        status: true,
        branchId: true,
        professionalId: true,
        psychologistId: true,
        encounter: { select: { id: true } },
      },
    });
    if (!appointment) {
      throw new BadRequestException('La cita no pertenece al paciente o tenant');
    }
    if ((appointment.professionalId ?? appointment.psychologistId) !== actor.userId) {
      throw clinicalRecordForbidden('Solo el profesional de la cita puede atenderla');
    }
    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.NO_SHOW
    ) {
      throw conflict(
        'ENCOUNTER_APPOINTMENT_NOT_ATTENDABLE',
        'La cita está cancelada o marcada como no asistida.',
      );
    }
    if (appointment.encounter) {
      throw conflict('ENCOUNTER_EXISTS', 'La cita ya tiene una atención.', {
        encounterId: appointment.encounter.id,
      });
    }
    return appointment;
  }

  /** `patientId` null: the encounter is looked up by its id alone, within the tenant. */
  private async findOwn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string | null,
    encounterId: string,
    actor: ClinicalActor | null,
    verb: string,
  ) {
    const stored = await tx.encounter.findFirst({
      where: { id: encounterId, tenantId, ...(patientId ? { patientId } : {}), deletedAt: null },
      include: { treatmentSession: { select: { id: true } } },
    });
    if (!stored) throw clinicalRecordNotFound('Atención no encontrada');
    // A null actor means the caller already decided who may act on this encounter.
    if (actor && stored.professionalId !== actor.userId) {
      throw clinicalRecordForbidden(`Solo puedes ${verb} tus propias atenciones`);
    }
    return this.decrypt(stored);
  }

  private async findOwnOpen(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string | null,
    encounterId: string,
    actor: ClinicalActor | null,
    verb: string,
  ) {
    const encounter = await this.findOwn(tx, tenantId, patientId, encounterId, actor, verb);
    if (encounter.status !== 'OPEN') {
      throw conflict('ENCOUNTER_CLOSED', 'La atención ya está cerrada.');
    }
    return encounter;
  }

  private decrypt<T extends Encounter>(encounter: T): T {
    return this.crypto.decryptFields(encounter.tenantId, encounter, ENCRYPTED_ENCOUNTER_FIELDS);
  }

  private async assertPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
