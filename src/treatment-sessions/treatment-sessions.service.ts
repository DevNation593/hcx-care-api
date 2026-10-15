import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsentDocument,
  PatientFile,
  Prisma,
  Treatment,
  TreatmentSession,
  TreatmentSessionStatus,
  TreatmentVersion,
} from '@prisma/client';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { clinicalRecordForbidden } from '../clinical-access/clinical-errors';
import { EncountersService } from '../encounters/encounters.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import {
  parseTreatmentRequirements,
  TreatmentRequirements,
} from '../treatments/treatment-requirements';
import { TreatmentsService } from '../treatments/treatments.service';
import {
  CancelTreatmentSessionDto,
  CompleteTreatmentSessionDto,
  CreateTreatmentSessionDto,
  SaveSessionFormDto,
} from './dto/treatment-session.dto';
import { loadSessionFacts } from './session-facts';
import { evaluateSession, MissingRequirement, requirementsMissing } from './session-requirements';
import {
  allowedCommands,
  assertCommandAllowed,
  SessionCommand,
  statusAfterIntake,
} from './session-state';

/** Stored encrypted; everything outside this service works with the decrypted session. */
const ENCRYPTED_SESSION_FIELDS = ['procedureNotes', 'cancellationReason'] as const;
const ENCRYPTED_FILE_FIELDS = ['fileName', 'description'] as const;

type VersionWithTreatment = TreatmentVersion & { treatment: Treatment };

const sessionInclude = {
  treatmentVersion: { include: { treatment: true } },
} satisfies Prisma.TreatmentSessionInclude;

const patientSelect = {
  id: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  identificationNumber: true,
  guardianName: true,
  guardianRelationship: true,
  guardianIdentification: true,
} satisfies Prisma.PatientSelect;

// The body of a consent is only returned by the consent routes.
const documentSelect = {
  id: true,
  treatmentSessionId: true,
  templateVersionId: true,
  title: true,
  checksum: true,
  status: true,
  presentedAt: true,
  signedAt: true,
  refusedAt: true,
  revokedAt: true,
  pdfChecksum: true,
  createdAt: true,
} satisfies Prisma.ConsentDocumentSelect;

const mediaSelect = {
  id: true,
  treatmentSessionId: true,
  encounterId: true,
  uploadedById: true,
  phase: true,
  category: true,
  fileName: true,
  description: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.PatientFileSelect;

export type SessionPatient = Prisma.PatientGetPayload<{ select: typeof patientSelect }>;
export type SessionConsentDocument = Pick<ConsentDocument, keyof typeof documentSelect>;
export type SessionMedia = Pick<PatientFile, keyof typeof mediaSelect>;
export interface SessionTreatment {
  id: string;
  name: string;
  version: number;
}

export type SessionSummary = Omit<TreatmentSession, (typeof ENCRYPTED_SESSION_FIELDS)[number]> & {
  treatment: SessionTreatment;
  professional: { id: string; firstName: string; lastName: string };
};

export type SessionDetail = TreatmentSession & {
  patient: SessionPatient;
  treatment: SessionTreatment;
  policy: TreatmentRequirements;
  form: {
    formDefinitionId: string;
    formVersion: number;
    name: string;
    schema: Prisma.JsonValue;
    data: Record<string, unknown> | null;
  } | null;
  consentDocuments: SessionConsentDocument[];
  media: SessionMedia[];
  requirements: { start: MissingRequirement[]; complete: MissingRequirement[] };
  allowedCommands: SessionCommand[];
};

/** The state of a session, stored in the audit log with every change. */
export function snapshotTreatmentSession(session: TreatmentSession) {
  return {
    version: session.version,
    patientId: session.patientId,
    professionalId: session.professionalId,
    treatmentVersionId: session.treatmentVersionId,
    encounterId: session.encounterId,
    appointmentId: session.appointmentId,
    branchId: session.branchId,
    formRecordId: session.formRecordId,
    consentDocumentId: session.consentDocumentId,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    cancelledAt: session.cancelledAt,
    procedureNotes: session.procedureNotes,
    cancellationReason: session.cancellationReason,
  };
}

const sessionNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'TREATMENT_SESSION_NOT_FOUND',
    message: 'Atención de tratamiento no encontrada.',
  });

const invalidTransition = (status: TreatmentSessionStatus, message: string, extra = {}) =>
  new ConflictException({
    statusCode: 409,
    code: 'TREATMENT_SESSION_INVALID_TRANSITION',
    message,
    status,
    ...extra,
  });

const STARTED_STATUSES: readonly TreatmentSessionStatus[] = ['IN_PROGRESS', 'CLINICAL_COMPLETE'];

/** Appointments a cancellation or a no-show of the session still applies to. */
const OPEN_APPOINTMENT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] as const;

/** The appointment keeps a plain note; the clinical reason stays encrypted on the session. */
const APPOINTMENT_CANCELLATION_NOTE = 'Atención de tratamiento cancelada';

@Injectable()
export class TreatmentSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
    private readonly treatments: TreatmentsService,
    private readonly encounters: EncountersService,
    private readonly records: SpecialtyRecordsService,
  ) {}

  /** Sessions of the patient, newest first, without clinical content. Each one is audited. */
  async list(tenantId: string, patientId: string, actor: ClinicalActor): Promise<SessionSummary[]> {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    const stored = await this.prisma.treatmentSession.findMany({
      where: { tenantId, patientId },
      include: {
        treatmentVersion: {
          select: { version: true, treatment: { select: { id: true, name: true } } },
        },
        professional: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await this.audit.record(
      tenantId,
      actor,
      stored.map((session) => ({
        action: 'READ' as const,
        entity: 'TREATMENT_SESSION' as const,
        entityId: session.id,
        patientId,
      })),
    );

    return stored.map(
      ({ treatmentVersion, procedureNotes: _notes, cancellationReason: _reason, ...session }) => ({
        ...session,
        treatment: { ...treatmentVersion.treatment, version: treatmentVersion.version },
      }),
    );
  }

  /**
   * Opens a session of the treatment's current version on a new PROCEDURE encounter. It starts
   * waiting for the form, or ready for the consent, or already consented when an earlier
   * consent of the same treatment still applies.
   */
  async create(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateTreatmentSessionDto,
  ): Promise<SessionDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const version = await this.treatments.currentVersionFor(tx, tenantId, dto.treatmentId);
      const { treatment } = version;
      if (treatment.specialtyId && treatment.specialtyId !== actor.specialtyId) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'TREATMENT_SPECIALTY_MISMATCH',
          message: 'El tratamiento pertenece a otra especialidad.',
        });
      }
      const policy = parseTreatmentRequirements(version.requirements);

      const encounter = await this.encounters.openEncounter(tx, tenantId, patientId, actor, {
        encounterType: 'PROCEDURE',
        reason: treatment.name,
        appointmentId: dto.appointmentId,
        branchId: dto.branchId,
      });

      const created = await tx.treatmentSession.create({
        data: {
          tenantId,
          patientId,
          professionalId: actor.userId,
          branchId: encounter.branchId,
          appointmentId: encounter.appointmentId,
          treatmentVersionId: version.id,
          encounterId: encounter.id,
        },
      });

      const facts = await loadSessionFacts(
        tx,
        created,
        policy,
        version.consentTemplateVersionId,
        new Date(),
      );
      const status = statusAfterIntake(policy, facts);
      const session =
        status !== created.status || facts.applicableConsentId
          ? await tx.treatmentSession.update({
              where: { id: created.id },
              data: {
                status,
                ...(facts.applicableConsentId
                  ? { consentDocumentId: facts.applicableConsentId }
                  : {}),
              },
            })
          : created;

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'TREATMENT_SESSION',
            entityId: session.id,
            patientId,
            after: snapshotTreatmentSession(session),
          },
        ],
        tx,
      );

      return this.detail(tx, session, version, policy);
    });
  }

  /** The session with its policy, form, consents, photos and what is missing. Audited. */
  async get(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail> {
    return this.transaction(async (tx) => {
      const { session, version } = await this.findSession(tx, tenantId, sessionId);
      const detail = await this.detail(
        tx,
        session,
        version,
        parseTreatmentRequirements(version.requirements),
      );

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'READ',
            entity: 'TREATMENT_SESSION',
            entityId: session.id,
            patientId: session.patientId,
          },
        ],
        tx,
      );
      return detail;
    });
  }

  /**
   * Saves or corrects the form the treatment pins, validated whole. The first save of an
   * intake moves the session on to the consent (or straight to consented).
   */
  async saveForm(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    dto: SaveSessionFormDto,
  ): Promise<SessionDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'SAVE_FORM',
      );
      if (
        !policy.medicalForm.required ||
        !version.formDefinitionId ||
        version.formVersion === null
      ) {
        throw invalidTransition(session.status, 'El tratamiento no exige ficha médica.', {
          command: 'SAVE_FORM',
        });
      }

      // A record removed from the history is replaced by a new one, not corrected.
      const liveRecordId =
        session.formRecordId &&
        (await tx.specialtyRecord.count({
          where: { id: session.formRecordId, tenantId, deletedAt: null },
        })) > 0
          ? session.formRecordId
          : null;

      const record = await this.records.writePinnedForm(tx, tenantId, session.patientId, actor, {
        encounterId: session.encounterId,
        formDefinitionId: version.formDefinitionId,
        formVersion: version.formVersion,
        data: dto.data,
        recordId: liveRecordId,
      });

      const changes: Prisma.TreatmentSessionUpdateInput = {};
      if (session.formRecordId !== record.id) changes.formRecord = { connect: { id: record.id } };
      if (session.status === 'INTAKE_IN_PROGRESS') {
        const facts = await loadSessionFacts(
          tx,
          { ...session, formRecordId: record.id },
          policy,
          version.consentTemplateVersionId,
          new Date(),
        );
        const status = statusAfterIntake(policy, facts);
        if (status !== session.status) changes.status = status;
        if (facts.applicableConsentId && facts.applicableConsentId !== session.consentDocumentId) {
          changes.consentDocument = { connect: { id: facts.applicableConsentId } };
        }
      }

      let current = session;
      if (Object.keys(changes).length > 0) {
        current = await this.transition(tx, session, changes);
        await this.audit.record(
          tenantId,
          actor,
          [
            {
              action: 'UPDATE',
              entity: 'TREATMENT_SESSION',
              entityId: session.id,
              patientId: session.patientId,
              before: snapshotTreatmentSession(session),
              after: snapshotTreatmentSession(current),
            },
          ],
          tx,
        );
      }

      return this.detail(tx, current, version, policy);
    });
  }

  /**
   * Whether the session meets its treatment's requirements, without clinical content: what is
   * missing to start it until it has started, and to complete it afterwards.
   */
  async compliance(
    tenantId: string,
    sessionId: string,
  ): Promise<{ status: TreatmentSessionStatus; missing: MissingRequirement[] }> {
    return this.transaction(async (tx) => {
      const { session, version } = await this.findSession(tx, tenantId, sessionId);
      const policy = parseTreatmentRequirements(version.requirements);
      const facts = await loadSessionFacts(
        tx,
        session,
        policy,
        version.consentTemplateVersionId,
        new Date(),
      );
      const { start, complete } = evaluateSession(policy, facts);
      const started = STARTED_STATUSES.includes(session.status) || session.startedAt !== null;
      return { status: session.status, missing: started ? complete : start };
    });
  }

  /**
   * Starts the procedure when the facts read now meet the start requirements (422 with what is
   * missing otherwise). The start time is the server's, and the consent that applies is pinned.
   */
  async start(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'START',
      );
      const facts = await loadSessionFacts(
        tx,
        session,
        policy,
        version.consentTemplateVersionId,
        new Date(),
      );
      const { start } = evaluateSession(policy, facts);
      if (start.length > 0) throw requirementsMissing(start);

      const started = await this.transition(tx, session, {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        ...(policy.informedConsent.required && facts.applicableConsentId
          ? { consentDocument: { connect: { id: facts.applicableConsentId } } }
          : {}),
      });
      await this.auditTransition(tx, actor, session, started);
      return this.detail(tx, started, version, policy);
    });
  }

  /**
   * Completes the procedure when the complete requirements are met, with the notes of the
   * request or, without them, the stored ones. The notes become the summary of the encounter,
   * which closes.
   */
  async complete(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    dto: CompleteTreatmentSessionDto,
  ): Promise<SessionDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'COMPLETE',
      );
      const notes = dto.procedureNotes?.trim() || session.procedureNotes;
      const facts = await loadSessionFacts(
        tx,
        { ...session, procedureNotes: notes },
        policy,
        version.consentTemplateVersionId,
        new Date(),
      );
      const { complete } = evaluateSession(policy, facts);
      if (complete.length > 0) throw requirementsMissing(complete);

      const completed = await this.transition(tx, session, {
        status: 'CLINICAL_COMPLETE',
        completedAt: new Date(),
        ...(notes !== session.procedureNotes
          ? { procedureNotes: notes ? this.crypto.encrypt(tenantId, notes) : null }
          : {}),
      });
      await this.encounters.closeEncounter(
        tx,
        tenantId,
        session.encounterId,
        actor,
        notes ?? undefined,
      );
      await this.auditTransition(tx, actor, session, completed);
      return this.detail(tx, completed, version, policy);
    });
  }

  /**
   * Cancels the session with a reason, stored encrypted; its appointment (if still unattended
   * or in progress) is cancelled too, and its encounter closes.
   */
  async cancel(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    dto: CancelTreatmentSessionDto,
  ): Promise<SessionDetail> {
    const reason = dto.reason.trim();
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'CANCEL',
      );
      const cancelled = await this.transition(tx, session, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: this.crypto.encrypt(tenantId, reason),
      });
      // Before the encounter closes, which would otherwise complete the appointment.
      if (session.appointmentId) {
        await tx.appointment.updateMany({
          where: {
            id: session.appointmentId,
            tenantId,
            status: { in: [...OPEN_APPOINTMENT_STATUSES] },
          },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: actor.userId,
            cancellationReason: APPOINTMENT_CANCELLATION_NOTE,
          },
        });
      }
      await this.encounters.closeEncounter(tx, tenantId, session.encounterId, actor);
      await this.auditTransition(tx, actor, session, cancelled, reason);
      return this.detail(tx, cancelled, version, policy);
    });
  }

  /**
   * Records that the patient did not come: the session ends as NO_SHOW, its appointment (if
   * still unattended or in progress) too, and its encounter closes.
   */
  async noShow(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'NO_SHOW',
      );
      const missed = await this.transition(tx, session, {
        status: 'NO_SHOW',
        cancelledAt: new Date(),
      });
      // Before the encounter closes, which would otherwise complete the appointment.
      if (session.appointmentId) {
        await tx.appointment.updateMany({
          where: {
            id: session.appointmentId,
            tenantId,
            status: { in: [...OPEN_APPOINTMENT_STATUSES] },
          },
          data: { status: 'NO_SHOW' },
        });
      }
      await this.encounters.closeEncounter(tx, tenantId, session.encounterId, actor);
      await this.auditTransition(tx, actor, session, missed);
      return this.detail(tx, missed, version, policy);
    });
  }

  /** Loads the session for a command by its professional, checks the transition and returns it with its policy. */
  async loadForCommand(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    command: SessionCommand,
  ): Promise<{
    session: TreatmentSession;
    version: VersionWithTreatment;
    policy: TreatmentRequirements;
  }> {
    const { session, version } = await this.findSession(tx, tenantId, sessionId);
    if (session.professionalId !== actor.userId) {
      throw clinicalRecordForbidden('Solo el profesional de la atención puede registrar en ella');
    }
    const policy = parseTreatmentRequirements(version.requirements);
    assertCommandAllowed(session.status, command, policy);
    return { session, version, policy };
  }

  /** Updates status with optimistic concurrency on `version`; 409 TREATMENT_SESSION_INVALID_TRANSITION when the row moved. */
  async transition(
    tx: Prisma.TransactionClient,
    session: TreatmentSession,
    data: Prisma.TreatmentSessionUpdateInput,
  ): Promise<TreatmentSession> {
    try {
      const updated = await tx.treatmentSession.update({
        where: { id: session.id, version: session.version },
        data: { ...data, version: { increment: 1 } },
      });
      return this.decrypt(updated);
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError)?.code === 'P2025') {
        throw invalidTransition(
          session.status,
          'La atención cambió mientras se procesaba la acción. Vuelve a cargarla.',
        );
      }
      throw error;
    }
  }

  /** The decrypted session of the tenant with its pinned treatment version; 404 when it is not there. No authorization. */
  async findSession(tx: Prisma.TransactionClient, tenantId: string, sessionId: string) {
    const stored = await tx.treatmentSession.findFirst({
      where: { id: sessionId, tenantId },
      include: sessionInclude,
    });
    if (!stored) throw sessionNotFound();
    const { treatmentVersion: version, ...session } = stored;
    return { session: this.decrypt(session), version };
  }

  private auditTransition(
    tx: Prisma.TransactionClient,
    actor: ClinicalActor,
    before: TreatmentSession,
    after: TreatmentSession,
    reason?: string,
  ): Promise<void> {
    return this.audit.record(
      before.tenantId,
      actor,
      [
        {
          action: 'UPDATE',
          entity: 'TREATMENT_SESSION',
          entityId: before.id,
          patientId: before.patientId,
          before: snapshotTreatmentSession(before),
          after: snapshotTreatmentSession(after),
          ...(reason ? { reason } : {}),
        },
      ],
      tx,
    );
  }

  private async detail(
    tx: Prisma.TransactionClient,
    session: TreatmentSession,
    version: VersionWithTreatment,
    policy: TreatmentRequirements,
  ): Promise<SessionDetail> {
    const { tenantId } = session;
    const patient = await tx.patient.findFirst({
      where: { id: session.patientId, tenantId },
      select: patientSelect,
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    const form = policy.medicalForm.required ? await this.pinnedForm(tx, session, version) : null;

    // The session's own documents, plus the one reused from an earlier session.
    const documents = await tx.consentDocument.findMany({
      where: {
        tenantId,
        OR: [
          { treatmentSessionId: session.id },
          ...(session.consentDocumentId ? [{ id: session.consentDocumentId }] : []),
        ],
      },
      select: documentSelect,
      orderBy: { presentedAt: 'desc' },
    });
    const media = await tx.patientFile.findMany({
      where: { tenantId, treatmentSessionId: session.id, deletedAt: null },
      select: mediaSelect,
      orderBy: { createdAt: 'asc' },
    });

    const facts = await loadSessionFacts(
      tx,
      session,
      policy,
      version.consentTemplateVersionId,
      new Date(),
    );

    return {
      ...session,
      patient,
      treatment: {
        id: version.treatment.id,
        name: version.treatment.name,
        version: version.version,
      },
      policy,
      form,
      consentDocuments: documents.map((document) => ({
        ...document,
        title: this.crypto.decrypt(tenantId, document.title),
      })),
      media: media.map((file) => this.crypto.decryptFields(tenantId, file, ENCRYPTED_FILE_FIELDS)),
      requirements: evaluateSession(policy, facts),
      allowedCommands: allowedCommands(session.status, policy),
    };
  }

  /** The pinned form version and the decrypted answers of the session's live record. */
  private async pinnedForm(
    tx: Prisma.TransactionClient,
    session: TreatmentSession,
    version: VersionWithTreatment,
  ): Promise<SessionDetail['form']> {
    const { formDefinitionId, formVersion } = version;
    if (!formDefinitionId || formVersion === null) return null;

    const pinned = await tx.formDefinitionVersion.findFirst({
      where: {
        formDefinitionId,
        version: formVersion,
        formDefinition: { tenantId: session.tenantId },
      },
      include: { formDefinition: { select: { name: true } } },
    });
    if (!pinned) return null;

    const record = session.formRecordId
      ? await tx.specialtyRecord.findFirst({
          where: { id: session.formRecordId, tenantId: session.tenantId, deletedAt: null },
          select: { data: true },
        })
      : null;

    return {
      formDefinitionId,
      formVersion,
      name: pinned.formDefinition.name,
      schema: pinned.schema,
      data: record
        ? (this.crypto.decryptJson(session.tenantId, record.data) as Record<string, unknown>)
        : null,
    };
  }

  private decrypt<T extends TreatmentSession>(session: T): T {
    return this.crypto.decryptFields(session.tenantId, session, ENCRYPTED_SESSION_FIELDS);
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
