import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SpecialtyRecord } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import {
  clinicalRecordForbidden,
  clinicalRecordNotFound,
} from '../clinical-access/clinical-errors';
import { evaluateFormAlerts, FormAlert, FormSchema } from '../clinical-forms/form-schema';
import { assertOpenEncounter } from '../encounters/encounters.service';
import {
  CUSTOM_MODULE_PREFIX,
  findClinicalModule,
  isHealthSpecialty,
  latestClinicalModule,
  resolveWriteVersion,
  STANDING_ALERT_MODULES,
  validateModuleData,
} from '../clinical-modules/clinical-module-registry';
import { TERMINAL_SESSION_STATUSES } from '../treatment-sessions/session-state';
import {
  CreateSpecialtyRecordDto,
  DeleteSpecialtyRecordDto,
  UpdateSpecialtyRecordDto,
} from './dto/create-specialty-record.dto';
import { newVerificationCode } from './verification-code';

const recordInclude = {
  specialty: { select: { code: true, name: true } },
  // Title and licence sign the record when it is printed as a document.
  professional: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      professionalProfile: { select: { professionalTitle: true, licenseNumber: true } },
    },
  },
  appointment: { select: { id: true, title: true, startTime: true } },
  encounter: { select: { id: true, encounterType: true, status: true, startedAt: true } },
} satisfies Prisma.SpecialtyRecordInclude;

/** What a record is validated and rendered with: one version of a module or tenant form. */
interface RecordDefinition {
  name: string;
  schemaVersion: number;
  legacy?: boolean;
  schema: FormSchema;
}

export interface PatientClinicalAlert extends FormAlert {
  recordId: string;
  moduleKey: string;
  moduleName: string;
  recordDate: Date;
}

/** The clinical state of a record, stored in the audit log with every change. */
export function snapshotSpecialtyRecord(record: SpecialtyRecord) {
  return {
    version: record.version,
    patientId: record.patientId,
    professionalId: record.professionalId,
    specialtyId: record.specialtyId,
    moduleKey: record.moduleKey,
    schemaVersion: record.schemaVersion,
    appointmentId: record.appointmentId,
    recordDate: record.recordDate,
    data: record.data,
    notes: record.notes,
  };
}

/** `data` and `notes` are stored encrypted; callers always receive the decrypted record. */
export function decryptSpecialtyRecord<T extends SpecialtyRecord>(
  cipher: ClinicalCipher,
  record: T,
): T {
  return {
    ...record,
    data: cipher.decryptJson(record.tenantId, record.data),
    notes: record.notes === null ? null : cipher.decrypt(record.tenantId, record.notes),
  };
}

const moduleUnknown = () =>
  new BadRequestException({
    statusCode: 400,
    code: 'CLINICAL_MODULE_UNKNOWN',
    message: 'El módulo no tiene una definición clínica.',
  });

const moduleVersionOutdated = () =>
  new ConflictException({
    statusCode: 409,
    code: 'CLINICAL_MODULE_VERSION_OUTDATED',
    message: 'El formulario cambió. Vuelve a cargarlo antes de registrar.',
  });

@Injectable()
export class SpecialtyRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  async list(tenantId: string, patientId: string, actor: ClinicalActor, moduleKey?: string) {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.specialtyRecord.findMany({
      where: { tenantId, patientId, deletedAt: null, ...(moduleKey ? { moduleKey } : {}) },
      include: recordInclude,
      orderBy: { recordDate: 'desc' },
    });
    const records = stored.map((record) => decryptSpecialtyRecord(this.crypto, record));
    const definitionOf = await this.definitionsOf(tenantId, records);

    await this.audit.record(
      tenantId,
      actor,
      records.map((record) => ({
        action: 'READ' as const,
        entity: 'SPECIALTY_RECORD' as const,
        entityId: record.id,
        patientId,
      })),
    );

    return records.map((record) => ({
      ...record,
      alerts: this.alertsOf(definitionOf(record), record.data),
    }));
  }

  /** One record, for printing it as a document. Audited like any other read. */
  async findOne(tenantId: string, patientId: string, recordId: string, actor: ClinicalActor) {
    const stored = await this.prisma.specialtyRecord.findFirst({
      where: { id: recordId, tenantId, patientId, deletedAt: null },
      include: recordInclude,
    });
    if (!stored) throw clinicalRecordNotFound('Registro no encontrado');
    const record = decryptSpecialtyRecord(this.crypto, stored);
    const definition = (await this.definitionsOf(tenantId, [record]))(record);
    // This is the read a document is printed from: a record from before the codes gets its own.
    const verificationCode = record.verificationCode ?? (await this.assignVerificationCode(stored));

    await this.audit.record(tenantId, actor, [
      { action: 'READ', entity: 'SPECIALTY_RECORD', entityId: recordId, patientId },
    ]);

    return { ...record, verificationCode, alerts: this.alertsOf(definition, record.data) };
  }

  /**
   * The record together with the definition it was written under: what is needed to render it
   * as a document outside the client. Audited as a read, like `findOne`.
   */
  async findDocument(tenantId: string, patientId: string, recordId: string, actor: ClinicalActor) {
    const stored = await this.prisma.specialtyRecord.findFirst({
      where: { id: recordId, tenantId, patientId, deletedAt: null },
      include: recordInclude,
    });
    if (!stored) throw clinicalRecordNotFound('Registro no encontrado');
    const record = decryptSpecialtyRecord(this.crypto, stored);
    const definition = (await this.definitionsOf(tenantId, [record]))(record);
    if (!definition) throw moduleUnknown();
    const verificationCode = record.verificationCode ?? (await this.assignVerificationCode(stored));

    await this.audit.record(tenantId, actor, [
      { action: 'READ', entity: 'SPECIALTY_RECORD', entityId: recordId, patientId },
    ]);

    return { record: { ...record, verificationCode }, definition };
  }

  /** Gives a record without a verification code its own, leaving the rest of the row as it was. */
  private async assignVerificationCode(stored: Pick<SpecialtyRecord, 'id' | 'updatedAt'>) {
    const code = newVerificationCode();
    const { count } = await this.prisma.specialtyRecord.updateMany({
      where: { id: stored.id, verificationCode: null },
      // The code is not a correction: the date of the last change stays.
      data: { verificationCode: code, updatedAt: stored.updatedAt },
    });
    if (count > 0) return code;

    // Another request assigned one in between.
    const current = await this.prisma.specialtyRecord.findUnique({
      where: { id: stored.id },
      select: { verificationCode: true },
    });
    return current?.verificationCode ?? code;
  }

  /**
   * The alerts the patient's records raise today: every record of a standing-fact module
   * (allergies) and the most recent record of each other module.
   */
  async alerts(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
  ): Promise<PatientClinicalAlert[]> {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.specialtyRecord.findMany({
      where: { tenantId, patientId, deletedAt: null },
      orderBy: { recordDate: 'desc' },
    });
    const definitionOf = await this.definitionsOf(tenantId, stored);

    const seenModules = new Set<string>();
    const alerts = stored.flatMap((storedRecord) => {
      const isStanding = STANDING_ALERT_MODULES.includes(storedRecord.moduleKey);
      if (!isStanding && seenModules.has(storedRecord.moduleKey)) return [];
      seenModules.add(storedRecord.moduleKey);

      const definition = definitionOf(storedRecord);
      if (!definition?.schema.alerts?.length) return [];
      const record = decryptSpecialtyRecord(this.crypto, storedRecord);
      return this.alertsOf(definition, record.data).map((alert) => ({
        ...alert,
        recordId: record.id,
        moduleKey: record.moduleKey,
        moduleName: definition.name,
        recordDate: record.recordDate,
      }));
    });

    // Only the records whose content the answer discloses are audited as read.
    await this.audit.record(
      tenantId,
      actor,
      [...new Set(alerts.map((alert) => alert.recordId))].map((entityId) => ({
        action: 'READ' as const,
        entity: 'SPECIALTY_RECORD' as const,
        entityId,
        patientId,
      })),
    );

    return alerts;
  }

  async create(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateSpecialtyRecordDto,
  ) {
    await this.assertPatient(tenantId, patientId);

    const target = dto.moduleKey.startsWith(CUSTOM_MODULE_PREFIX)
      ? await this.resolveCustomForm(tenantId, actor, dto)
      : await this.resolveModule(tenantId, actor, dto);
    const data = validateModuleData(target.definition, dto.data);

    if (dto.appointmentId) {
      const appointment = await this.prisma.appointment.findFirst({
        where: { id: dto.appointmentId, tenantId, patientId },
      });
      if (!appointment) {
        throw new BadRequestException('La cita no pertenece al paciente o tenant');
      }
    }
    if (dto.encounterId) {
      await assertOpenEncounter(this.prisma, tenantId, patientId, dto.encounterId, actor);
    }

    return this.transaction(async (tx) => {
      const stored = await tx.specialtyRecord.create({
        data: {
          tenantId,
          patientId,
          professionalId: actor.userId,
          specialtyId: target.specialtyId,
          moduleKey: dto.moduleKey,
          schemaVersion: target.definition.schemaVersion,
          verificationCode: newVerificationCode(),
          formDefinitionId: target.formDefinitionId,
          appointmentId: dto.appointmentId,
          encounterId: dto.encounterId,
          recordDate: dto.recordDate ? new Date(dto.recordDate) : undefined,
          data: this.crypto.encryptJson(tenantId, data) as Prisma.InputJsonValue,
          notes: dto.notes === undefined ? undefined : this.crypto.encrypt(tenantId, dto.notes),
        },
        include: recordInclude,
      });
      const record = decryptSpecialtyRecord(this.crypto, stored);

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'SPECIALTY_RECORD',
            entityId: record.id,
            patientId,
            after: snapshotSpecialtyRecord(record),
          },
        ],
        tx,
      );

      return { ...record, alerts: this.alertsOf(target.definition, record.data) };
    });
  }

  /**
   * A correction by the author. The data is checked against the version the record was
   * written under, the record version is bumped and the previous state stays in the audit log.
   */
  async update(
    tenantId: string,
    patientId: string,
    recordId: string,
    actor: ClinicalActor,
    dto: UpdateSpecialtyRecordDto,
  ) {
    return this.transaction(async (tx) => {
      const current = await this.findOwnRecord(
        tx,
        tenantId,
        patientId,
        recordId,
        actor,
        'corregir',
      );
      await this.assertNotStartedSessionForm(tx, tenantId, recordId);
      const definition = (await this.definitionsOf(tenantId, [current], tx))(current);

      let data: Record<string, unknown> | undefined;
      if (dto.data != null) {
        if (!definition) throw moduleUnknown();
        data = validateModuleData(definition, dto.data);
      }

      const stored = await tx.specialtyRecord.update({
        where: { id: recordId },
        data: {
          ...(data
            ? { data: this.crypto.encryptJson(tenantId, data) as Prisma.InputJsonValue }
            : {}),
          ...(dto.notes !== undefined
            ? { notes: dto.notes?.trim() ? this.crypto.encrypt(tenantId, dto.notes.trim()) : null }
            : {}),
          ...(dto.recordDate ? { recordDate: new Date(dto.recordDate) } : {}),
          version: { increment: 1 },
        },
        include: recordInclude,
      });
      const record = decryptSpecialtyRecord(this.crypto, stored);

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'SPECIALTY_RECORD',
            entityId: recordId,
            patientId,
            before: snapshotSpecialtyRecord(current),
            after: snapshotSpecialtyRecord(record),
            reason: dto.changeReason,
          },
        ],
        tx,
      );

      return { ...record, alerts: this.alertsOf(definition, record.data) };
    });
  }

  async delete(
    tenantId: string,
    patientId: string,
    recordId: string,
    actor: ClinicalActor,
    dto: DeleteSpecialtyRecordDto,
  ) {
    return this.transaction(async (tx) => {
      const current = await this.findOwnRecord(
        tx,
        tenantId,
        patientId,
        recordId,
        actor,
        'eliminar',
      );
      await this.assertNotStartedSessionForm(tx, tenantId, recordId);

      // The row stays for audit; it only stops being listed.
      await tx.specialtyRecord.update({
        where: { id: recordId },
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
            entity: 'SPECIALTY_RECORD',
            entityId: recordId,
            patientId,
            before: snapshotSpecialtyRecord(current),
            reason: dto.reason,
          },
        ],
        tx,
      );

      return { message: 'Registro eliminado exitosamente' };
    });
  }

  /**
   * The answers to a form pinned by someone else (a treatment version), written inside the
   * caller's transaction. The data is validated against that exact version, whatever the
   * form's current version is. With `recordId` the record is corrected by its author (version
   * bumped, both states audited); otherwise a record is created in the open encounter.
   */
  async writePinnedForm(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    input: {
      encounterId: string;
      formDefinitionId: string;
      formVersion: number;
      data: unknown;
      recordId?: string | null;
    },
  ): Promise<{ id: string }> {
    const pinned = await tx.formDefinitionVersion.findFirst({
      where: {
        formDefinitionId: input.formDefinitionId,
        version: input.formVersion,
        formDefinition: { tenantId },
      },
      include: { formDefinition: { select: { name: true } } },
    });
    if (!pinned) throw moduleUnknown();
    const definition: RecordDefinition = {
      name: pinned.formDefinition.name,
      schemaVersion: pinned.version,
      schema: pinned.schema as unknown as FormSchema,
    };
    const data = validateModuleData(definition, input.data);
    const encrypted = this.crypto.encryptJson(tenantId, data) as Prisma.InputJsonValue;

    if (input.recordId) {
      const current = await this.findOwnRecord(
        tx,
        tenantId,
        patientId,
        input.recordId,
        actor,
        'corregir',
      );
      const stored = await tx.specialtyRecord.update({
        where: { id: current.id },
        data: { data: encrypted, version: { increment: 1 } },
      });
      const record = decryptSpecialtyRecord(this.crypto, stored);

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'SPECIALTY_RECORD',
            entityId: record.id,
            patientId,
            before: snapshotSpecialtyRecord(current),
            after: snapshotSpecialtyRecord(record),
          },
        ],
        tx,
      );
      return { id: record.id };
    }

    await assertOpenEncounter(tx, tenantId, patientId, input.encounterId, actor);
    const stored = await tx.specialtyRecord.create({
      data: {
        tenantId,
        patientId,
        professionalId: actor.userId,
        specialtyId: actor.specialtyId,
        moduleKey: `${CUSTOM_MODULE_PREFIX}${input.formDefinitionId}`,
        schemaVersion: pinned.version,
        verificationCode: newVerificationCode(),
        formDefinitionId: input.formDefinitionId,
        encounterId: input.encounterId,
        data: encrypted,
      },
    });
    const record = decryptSpecialtyRecord(this.crypto, stored);

    await this.audit.record(
      tenantId,
      actor,
      [
        {
          action: 'CREATE',
          entity: 'SPECIALTY_RECORD',
          entityId: record.id,
          patientId,
          after: snapshotSpecialtyRecord(record),
        },
      ],
      tx,
    );
    return { id: record.id };
  }

  /** A module defined by the platform: the caller's specialty must own it or be allowed to use it. */
  private async resolveModule(
    tenantId: string,
    actor: ClinicalActor,
    dto: CreateSpecialtyRecordDto,
  ) {
    const definition = resolveWriteVersion(dto.moduleKey, dto.schemaVersion);
    if (!definition) throw moduleUnknown();
    // New records follow the current definition; only pre-definition clients still write the legacy one.
    if (!definition.legacy && definition !== latestClinicalModule(dto.moduleKey)) {
      throw moduleVersionOutdated();
    }
    const target = { definition, formDefinitionId: null };

    if (definition.scope === 'GENERAL') {
      if (definition.allowedSpecialtyCodes || definition.healthOnly) {
        const own = await this.prisma.specialty.findFirst({
          where: { id: actor.specialtyId },
          select: { code: true },
        });
        const allowed =
          (!definition.allowedSpecialtyCodes ||
            (!!own && definition.allowedSpecialtyCodes.includes(own.code))) &&
          (!definition.healthOnly || isHealthSpecialty(own?.code));
        if (!allowed) {
          throw clinicalRecordForbidden('Tu especialidad no puede registrar este módulo');
        }
      }
      return { ...target, specialtyId: actor.specialtyId };
    }

    if (dto.specialtyCode && dto.specialtyCode.toUpperCase() !== definition.specialtyCode) {
      throw new BadRequestException('El módulo no corresponde a la especialidad seleccionada');
    }
    const specialty = await this.prisma.specialty.findFirst({
      where: {
        code: definition.specialtyCode!,
        isActive: true,
        tenants: { some: { tenantId } },
      },
    });
    if (!specialty) {
      throw new BadRequestException('La especialidad no está habilitada para este tenant');
    }

    // The history is shared for reading, but each professional writes only under their own specialty.
    if (specialty.id !== actor.specialtyId) {
      throw clinicalRecordForbidden('Solo puedes crear registros de tu propia especialidad');
    }

    const module = await this.prisma.tenantModule.findFirst({
      where: { tenantId, moduleKey: dto.moduleKey, enabled: true },
    });
    if (!module) {
      throw new ForbiddenException('El módulo especializado no está habilitado');
    }

    const specialtyModule = await this.prisma.specialtyModule.findFirst({
      where: { specialtyId: specialty.id, moduleKey: dto.moduleKey },
    });
    if (!specialtyModule) {
      throw new BadRequestException('El módulo no corresponde a la especialidad seleccionada');
    }

    return { ...target, specialtyId: specialty.id };
  }

  /** A form designed by the clinic: active, current version, and within its specialty if it has one. */
  private async resolveCustomForm(
    tenantId: string,
    actor: ClinicalActor,
    dto: CreateSpecialtyRecordDto,
  ) {
    const form = await this.prisma.formDefinition.findFirst({
      where: { id: dto.moduleKey.slice(CUSTOM_MODULE_PREFIX.length), tenantId },
    });
    if (!form) throw moduleUnknown();
    if (!form.isActive) {
      throw new ForbiddenException('El formulario está inactivo');
    }
    if (form.specialtyId && form.specialtyId !== actor.specialtyId) {
      throw clinicalRecordForbidden('Este formulario pertenece a otra especialidad');
    }
    if (dto.schemaVersion !== undefined && dto.schemaVersion !== form.currentVersion) {
      throw moduleVersionOutdated();
    }

    const version = await this.prisma.formDefinitionVersion.findFirst({
      where: { formDefinitionId: form.id, version: form.currentVersion },
    });
    if (!version) throw moduleUnknown();

    const definition: RecordDefinition = {
      name: form.name,
      schemaVersion: version.version,
      schema: version.schema as unknown as FormSchema,
    };
    return { definition, formDefinitionId: form.id, specialtyId: actor.specialtyId };
  }

  /** Looks up the definition each record was written under; tenant forms are fetched in one query. */
  private async definitionsOf(
    tenantId: string,
    records: Pick<SpecialtyRecord, 'moduleKey' | 'schemaVersion' | 'formDefinitionId'>[],
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<(record: (typeof records)[number]) => RecordDefinition | undefined> {
    const formIds = [...new Set(records.flatMap(({ formDefinitionId }) => formDefinitionId ?? []))];
    const versions = formIds.length
      ? await db.formDefinitionVersion.findMany({
          where: { formDefinitionId: { in: formIds }, formDefinition: { tenantId } },
          include: { formDefinition: { select: { name: true } } },
        })
      : [];
    const custom = new Map(
      versions.map((version) => [
        `${version.formDefinitionId}:${version.version}`,
        {
          name: version.formDefinition.name,
          schemaVersion: version.version,
          schema: version.schema as unknown as FormSchema,
        } satisfies RecordDefinition,
      ]),
    );

    return (record) => {
      if (record.formDefinitionId) {
        return custom.get(`${record.formDefinitionId}:${record.schemaVersion}`);
      }
      return findClinicalModule(record.moduleKey, record.schemaVersion);
    };
  }

  private alertsOf(definition: RecordDefinition | undefined, data: unknown): FormAlert[] {
    return definition ? evaluateFormAlerts(definition.schema, data) : [];
  }

  /** RN-05: the form of a treatment session is fixed once the session has started or ended. */
  private async assertNotStartedSessionForm(
    tx: Prisma.TransactionClient,
    tenantId: string,
    recordId: string,
  ) {
    const session = await tx.treatmentSession.findFirst({
      where: { tenantId, formRecordId: recordId },
      select: { status: true },
    });
    if (
      session &&
      (session.status === 'IN_PROGRESS' || TERMINAL_SESSION_STATUSES.includes(session.status))
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TREATMENT_SESSION_INVALID_TRANSITION',
        message: 'La ficha de una atención de tratamiento ya no puede cambiar.',
        status: session.status,
      });
    }
  }

  private async findOwnRecord(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    recordId: string,
    actor: ClinicalActor,
    verb: string,
  ) {
    const stored = await tx.specialtyRecord.findFirst({
      where: { id: recordId, tenantId, patientId, deletedAt: null },
    });
    if (!stored) {
      throw clinicalRecordNotFound('Registro no encontrado');
    }
    if (stored.professionalId !== actor.userId) {
      throw clinicalRecordForbidden(`Solo puedes ${verb} tus propios registros`);
    }
    return decryptSpecialtyRecord(this.crypto, stored);
  }

  private async assertPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
