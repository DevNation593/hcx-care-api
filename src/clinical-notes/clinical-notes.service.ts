import { Injectable, NotFoundException } from '@nestjs/common';
import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';
import { ClinicalNote, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertOpenEncounter } from '../encounters/encounters.service';
import { PUBLIC_USER_SELECT } from '../common/utils/public-user-select';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import {
  clinicalRecordForbidden,
  clinicalRecordNotFound,
} from '../clinical-access/clinical-errors';
import {
  CreateClinicalNoteDto,
  DeleteClinicalNoteDto,
  UpdateClinicalNoteDto,
} from './dto/clinical-note.dto';

const personSelect = { id: true, firstName: true, lastName: true } as const;

/** Stored encrypted; everything outside this service works with the decrypted note. */
export const ENCRYPTED_NOTE_FIELDS = [
  'content',
  'diagnosis',
  'treatment',
  'observations',
  'deletionReason',
] as const;

/** The clinical state of a note, stored in the audit log before and after every change. */
export function snapshotClinicalNote(note: ClinicalNote) {
  return {
    version: note.version,
    patientId: note.patientId,
    appointmentId: note.appointmentId,
    psychologistId: note.psychologistId,
    specialtyId: note.specialtyId,
    content: note.content,
    diagnosis: note.diagnosis,
    treatment: note.treatment,
    observations: note.observations,
    sessionDate: note.sessionDate,
    sessionDuration: note.sessionDuration,
  };
}

@Injectable()
export class ClinicalNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  async create(tenantId: string, actor: ClinicalActor, createDto: CreateClinicalNoteDto) {
    const { patientId, appointmentId, encounterId, sessionDate, ...noteData } = createDto;

    // Verify patient belongs to tenant
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    // If appointmentId provided, verify it exists and belongs to this professional
    if (appointmentId) {
      const appointment = await this.prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          tenantId,
          patientId,
          psychologistId: actor.userId,
        },
      });

      if (!appointment) {
        throw new NotFoundException('Cita no encontrada o no autorizada');
      }
    }
    if (encounterId) {
      await assertOpenEncounter(this.prisma, tenantId, patientId, encounterId, actor);
    }

    return this.transaction(async (tx) => {
      const stored = await tx.clinicalNote.create({
        data: {
          ...this.encrypt(tenantId, noteData),
          tenantId,
          patientId,
          appointmentId,
          encounterId,
          psychologistId: actor.userId,
          specialtyId: actor.specialtyId,
          sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
        },
        include: {
          patient: { select: personSelect },
          psychologist: { select: personSelect },
        },
      });
      const note = this.decrypt(stored);

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'CLINICAL_NOTE',
            entityId: note.id,
            patientId,
            after: snapshotClinicalNote(note),
          },
        ],
        tx,
      );

      return note;
    });
  }

  async findAll(
    tenantId: string,
    actor: ClinicalActor,
    filters?: { patientId?: string; psychologistId?: string },
  ) {
    // The history is shared: every professional of the tenant reads all of it.
    const where: Prisma.ClinicalNoteWhereInput = { tenantId, deletedAt: null };

    if (filters?.patientId) {
      where.patientId = filters.patientId;
    }

    if (filters?.psychologistId) {
      where.psychologistId = filters.psychologistId;
    }

    const stored = await this.prisma.clinicalNote.findMany({
      where,
      include: {
        patient: { select: personSelect },
        psychologist: { select: personSelect },
      },
      orderBy: { sessionDate: 'desc' },
    });
    const notes = stored.map((note) => this.decrypt(note));

    await this.audit.record(
      tenantId,
      actor,
      notes.map((note) => ({
        action: 'READ' as const,
        entity: 'CLINICAL_NOTE' as const,
        entityId: note.id,
        patientId: note.patientId,
      })),
    );

    return notes;
  }

  async findOne(tenantId: string, noteId: string, actor: ClinicalActor) {
    const stored = await this.prisma.clinicalNote.findFirst({
      where: { id: noteId, tenantId, deletedAt: null },
      include: {
        patient: { omit: LEGACY_BILLING_OMIT },
        psychologist: { select: PUBLIC_USER_SELECT },
        appointment: true,
      },
    });

    if (!stored) {
      throw clinicalRecordNotFound('Nota clínica no encontrada');
    }
    const note = this.decrypt(stored);

    await this.audit.record(tenantId, actor, [
      { action: 'READ', entity: 'CLINICAL_NOTE', entityId: noteId, patientId: note.patientId },
    ]);

    return note;
  }

  async update(
    tenantId: string,
    noteId: string,
    actor: ClinicalActor,
    updateDto: UpdateClinicalNoteDto,
  ) {
    const { changeReason, sessionDate, ...fields } = updateDto;

    return this.transaction(async (tx) => {
      const note = await this.findOwnNote(tx, tenantId, noteId, actor, 'editar');

      const updated = this.decrypt(
        await tx.clinicalNote.update({
          where: { id: noteId },
          data: {
            ...this.encrypt(tenantId, fields),
            ...(sessionDate ? { sessionDate: new Date(sessionDate) } : {}),
            version: { increment: 1 },
          },
          include: {
            patient: { omit: LEGACY_BILLING_OMIT },
            psychologist: { select: PUBLIC_USER_SELECT },
          },
        }),
      );

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'CLINICAL_NOTE',
            entityId: noteId,
            patientId: note.patientId,
            before: snapshotClinicalNote(note),
            after: snapshotClinicalNote(updated),
            reason: changeReason,
          },
        ],
        tx,
      );

      return updated;
    });
  }

  async delete(tenantId: string, noteId: string, actor: ClinicalActor, dto: DeleteClinicalNoteDto) {
    return this.transaction(async (tx) => {
      const note = await this.findOwnNote(tx, tenantId, noteId, actor, 'eliminar');

      // The row stays for audit; it only stops being listed.
      await tx.clinicalNote.update({
        where: { id: noteId },
        data: {
          deletedAt: new Date(),
          deletedById: actor.userId,
          deletionReason: this.crypto.encrypt(tenantId, dto.reason),
        },
      });

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'DELETE',
            entity: 'CLINICAL_NOTE',
            entityId: noteId,
            patientId: note.patientId,
            before: snapshotClinicalNote(note),
            reason: dto.reason,
          },
        ],
        tx,
      );

      return { message: 'Nota clínica eliminada exitosamente' };
    });
  }

  private async findOwnNote(
    tx: Prisma.TransactionClient,
    tenantId: string,
    noteId: string,
    actor: ClinicalActor,
    verb: string,
  ) {
    const stored = await tx.clinicalNote.findFirst({
      where: { id: noteId, tenantId, deletedAt: null },
    });

    if (!stored) {
      throw clinicalRecordNotFound('Nota clínica no encontrada');
    }
    const note = this.decrypt(stored);

    if (note.psychologistId !== actor.userId) {
      throw clinicalRecordForbidden(`Solo puedes ${verb} tus propias notas clínicas`);
    }

    return note;
  }

  private encrypt<T extends Partial<ClinicalNote>>(tenantId: string, fields: T): T {
    return this.crypto.encryptFields(tenantId, fields, ENCRYPTED_NOTE_FIELDS);
  }

  private decrypt<T extends ClinicalNote>(note: T): T {
    return this.crypto.decryptFields(note.tenantId, note, ENCRYPTED_NOTE_FIELDS);
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
