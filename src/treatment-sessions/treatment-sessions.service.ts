import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsentDocument,
  ConsentSignerRole,
  Encounter,
  EncounterStatus,
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
import {
  clinicalRecordForbidden,
  clinicalRecordNotFound,
} from '../clinical-access/clinical-errors';
import { DEFAULT_CLINIC_TIMEZONE } from '../common/utils/timezone';
import {
  assertOpenEncounter,
  EncountersService,
  lockOpenEncounter,
  lockOpenEncounterForUpdate,
} from '../encounters/encounters.service';
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
  SaveProcedureNotesDto,
  SaveSessionFormDto,
} from './dto/treatment-session.dto';
import { loadSessionFacts } from './session-facts';
import { evaluateSession, MissingRequirement, requirementsMissing } from './session-requirements';
import {
  allowedCommands,
  assertCommandAllowed,
  BILLING_SESSION_STATUSES,
  SessionCommand,
  statusAfterIntake,
  statusAfterClinicalCompletion,
} from './session-state';

/** Stored encrypted; everything outside this service works with the decrypted session. */
const ENCRYPTED_SESSION_FIELDS = ['procedureNotes', 'cancellationReason'] as const;
const ENCRYPTED_FILE_FIELDS = ['fileName', 'description'] as const;

/** Same limit as the encounter reason. */
const MAX_REASON_LENGTH = 2000;
/** Live treatments one encounter can hold; the DTO caps a single request at the same number. */
const MAX_TREATMENTS_PER_ENCOUNTER = 10;

type VersionWithTreatment = TreatmentVersion & { treatment: Treatment };
type OpenedSession = {
  session: TreatmentSession;
  version: VersionWithTreatment;
  policy: ReturnType<typeof parseTreatmentRequirements>;
};

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
  // Who signed; the identification, signature image, operator and network data stay out.
  signature: { select: { signerRole: true, signerName: true, relationship: true } },
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

const professionalSelect = {
  id: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export type SessionPatient = Prisma.PatientGetPayload<{ select: typeof patientSelect }>;
export type SessionProfessional = Prisma.UserGetPayload<{ select: typeof professionalSelect }>;

/** The signer of a signed consent as the API returns it: decrypted, without identification. */
export interface ConsentSignerView {
  signerName: string;
  signerRole: ConsentSignerRole;
  relationship: string | null;
}

export type SessionConsentDocument = Pick<
  ConsentDocument,
  Exclude<keyof typeof documentSelect, 'signature'>
> & { signature: ConsentSignerView | null };
export type SessionMedia = Pick<PatientFile, keyof typeof mediaSelect>;
export interface SessionTreatment {
  id: string;
  name: string;
  version: number;
}

/** A session of the patient's list: its procedure notes decrypted, without the cancellation reason. */
export type SessionSummary = Omit<TreatmentSession, 'cancellationReason'> & {
  treatment: SessionTreatment;
  professional: SessionProfessional;
};

export type SessionDetail = TreatmentSession & {
  patient: SessionPatient;
  /** The professional who owns the session; only they record in it. */
  professional: SessionProfessional | null;
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
  /** The clinic's IANA time zone, to show server times in. */
  timezone: string;
  media: SessionMedia[];
  requirements: { start: MissingRequirement[]; complete: MissingRequirement[] };
  /** What the reader may do now: empty for anyone but the owner, except a MASTER's revocation. */
  allowedCommands: SessionCommand[];
  encounterStatus: EncounterStatus;
  /** The other sessions of the same encounter, in the order they were opened. */
  encounterSessions: EncounterSiblingSession[];
};

export interface EncounterSiblingSession {
  id: string;
  status: TreatmentSessionStatus;
  treatmentName: string;
}

/** The commands of the status the actor may send: the owner all, a MASTER only the revocation. */
function commandsForActor(
  session: TreatmentSession,
  policy: TreatmentRequirements,
  actor: ClinicalActor,
): SessionCommand[] {
  const commands = allowedCommands(session.status, policy);
  if (session.professionalId === actor.userId) return commands;
  return actor.role === 'MASTER' ? commands.filter((command) => command === 'REVOKE_CONSENT') : [];
}

/** The signer fields of a stored signature, decrypted. */
export function consentSignerView(
  crypto: ClinicalCryptoService,
  tenantId: string,
  signature: { signerRole: ConsentSignerRole; signerName: string; relationship: string | null },
): ConsentSignerView {
  return {
    signerName: crypto.decrypt(tenantId, signature.signerName),
    signerRole: signature.signerRole,
    relationship: signature.relationship ? crypto.decrypt(tenantId, signature.relationship) : null,
  };
}

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

/** A no-show of the encounter ends the sessions in these statuses: nothing was done with the patient. */
const NO_SHOW_ELIGIBLE_STATUSES: readonly TreatmentSessionStatus[] = [
  'INTAKE_IN_PROGRESS',
  'READY_FOR_CONSENT',
  'CONSENTED',
];
/** Sessions that already ended without the patient being attended; they stay as they are. */
const NO_SHOW_IGNORED_STATUSES: readonly TreatmentSessionStatus[] = ['CANCELLED', 'NO_SHOW'];

const activityConflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, code, message });

const STARTED_STATUSES: readonly TreatmentSessionStatus[] = ['IN_PROGRESS', 'CLINICAL_COMPLETE'];

/** Appointments a no-show of the session still applies to. */
const OPEN_APPOINTMENT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] as const;

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

  /**
   * Sessions of the patient, newest first, with their procedure notes for the clinical history
   * (the same text its encounter closes with). Each one is audited as read.
   */
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
      ({ treatmentVersion, procedureNotes, cancellationReason: _reason, ...session }) => ({
        ...session,
        procedureNotes: procedureNotes ? this.crypto.decrypt(tenantId, procedureNotes) : null,
        treatment: { ...treatmentVersion.treatment, version: treatmentVersion.version },
      }),
    );
  }

  /**
   * Opens one session per treatment (the current version of each) in one encounter: a new
   * PROCEDURE encounter, or an open encounter of the caller when `encounterId` comes. Everything
   * is validated before anything is written, and all of it commits or none. Each session starts
   * waiting for the form, or ready for the consent, or already consented when an earlier consent
   * of the same treatment still applies. Answers one session for `treatmentId` and a list, in
   * the order of `treatmentIds`, for `treatmentIds`.
   */
  async create(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateTreatmentSessionDto,
  ): Promise<SessionDetail | SessionDetail[]> {
    // A JSON null counts as absent: the validators skip it with @IsOptional.
    const single = dto.treatmentId != null;
    if (single === (dto.treatmentIds != null)) {
      throw new BadRequestException('Indica treatmentId o treatmentIds, pero no ambos.');
    }
    if (dto.encounterId && (dto.encounterType != null || dto.reason != null)) {
      throw new BadRequestException(
        'El tipo y el motivo solo se indican al abrir una atención nueva.',
      );
    }
    const treatmentIds = single ? [dto.treatmentId as string] : (dto.treatmentIds as string[]);

    const details = await runSerializableTransaction(
      this.prisma,
      tenantId,
      actor.userId,
      async (tx) => {
        const versions: VersionWithTreatment[] = [];
        for (const treatmentId of treatmentIds) {
          const version = await this.treatments.currentVersionFor(tx, tenantId, treatmentId);
          const { treatment } = version;
          if (treatment.specialtyId && treatment.specialtyId !== actor.specialtyId) {
            throw new ForbiddenException({
              statusCode: 403,
              code: 'TREATMENT_SPECIALTY_MISMATCH',
              message: 'El tratamiento pertenece a otra especialidad.',
            });
          }
          versions.push(version);
        }

        const encounter = dto.encounterId
          ? await this.openEncounterOf(tx, tenantId, patientId, actor, dto, treatmentIds)
          : await this.encounters.openEncounter(tx, tenantId, patientId, actor, {
              encounterType: dto.encounterType ?? 'PROCEDURE',
              reason:
                dto.reason ??
                versions
                  .map(({ treatment }) => treatment.name)
                  .join(', ')
                  .slice(0, MAX_REASON_LENGTH),
              appointmentId: dto.appointmentId ?? undefined,
              branchId: dto.branchId ?? undefined,
            });

        // Every session exists before any detail is built, so each detail lists all its siblings.
        const created: OpenedSession[] = [];
        for (const version of versions) {
          created.push(
            await this.openSessionIn(tx, tenantId, patientId, encounter, version, actor),
          );
        }
        const opened: SessionDetail[] = [];
        for (const { session, version, policy } of created) {
          opened.push(await this.detail(tx, session, version, policy, actor));
        }
        return opened;
      },
    );
    return single ? details[0] : details;
  }

  /**
   * An open encounter of the caller, held open until the transaction ends so a close running
   * now waits for it. A given appointment or branch must be the encounter's own.
   */
  private async openEncounterOf(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateTreatmentSessionDto,
    treatmentIds: string[],
  ): Promise<Pick<Encounter, 'id' | 'appointmentId' | 'branchId'>> {
    const encounterId = dto.encounterId as string;
    await assertOpenEncounter(tx, tenantId, patientId, encounterId, actor);
    if (!(await lockOpenEncounter(tx, tenantId, encounterId))) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ENCOUNTER_CLOSED',
        message: 'La atención ya está cerrada.',
      });
    }
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId, tenantId, patientId, deletedAt: null },
      select: { id: true, appointmentId: true, branchId: true },
    });
    if (!encounter) throw clinicalRecordNotFound('Atención no encontrada');
    if (dto.appointmentId != null && dto.appointmentId !== encounter.appointmentId) {
      throw new BadRequestException('La cita no corresponde a la atención indicada.');
    }
    if (dto.branchId != null && dto.branchId !== encounter.branchId) {
      throw new BadRequestException('La sede no corresponde a la atención indicada.');
    }

    // The cap and the no-repeat rule hold for the whole encounter, not only for this request.
    // Cancelled and missed sessions do not count, so a cancelled treatment can be added again.
    const live = await tx.treatmentSession.findMany({
      where: { tenantId, encounterId, status: { notIn: [...NO_SHOW_IGNORED_STATUSES] } },
      select: { treatmentVersion: { select: { treatmentId: true } } },
    });
    if (live.length + treatmentIds.length > MAX_TREATMENTS_PER_ENCOUNTER) {
      throw new BadRequestException(
        `Una atención admite como máximo ${MAX_TREATMENTS_PER_ENCOUNTER} tratamientos activos.`,
      );
    }
    const liveTreatmentIds = new Set(live.map((row) => row.treatmentVersion.treatmentId));
    const repeated = treatmentIds.find((id) => liveTreatmentIds.has(id));
    if (repeated) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TREATMENT_ALREADY_IN_ENCOUNTER',
        message: 'La atención ya tiene una sesión activa de ese tratamiento.',
        treatmentId: repeated,
      });
    }
    return encounter;
  }

  /** One session of the version inside the encounter, audited, with its intake status. */
  private async openSessionIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    encounter: Pick<Encounter, 'id' | 'appointmentId' | 'branchId'>,
    version: VersionWithTreatment,
    actor: ClinicalActor,
  ): Promise<OpenedSession> {
    const policy = parseTreatmentRequirements(version.requirements);
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

    return { session, version, policy };
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
        actor,
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

      return this.detail(tx, current, version, policy, actor);
    });
  }

  /**
   * Whether the session meets its treatment's requirements, without clinical content: what is
   * missing to start it until it has started, and to complete it afterwards. A clinically
   * complete session was checked when it closed, so later changes (a deleted photo) do not
   * reopen what it misses.
   */
  async compliance(
    tenantId: string,
    sessionId: string,
  ): Promise<{ status: TreatmentSessionStatus; missing: MissingRequirement[] }> {
    return this.transaction(async (tx) => {
      const { session, version } = await this.findSession(tx, tenantId, sessionId);
      if (
        session.status === 'CLINICAL_COMPLETE' ||
        BILLING_SESSION_STATUSES.includes(session.status)
      ) {
        return { status: session.status, missing: [] };
      }
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
      return this.detail(tx, started, version, policy, actor);
    });
  }

  /**
   * Completes the procedure when the complete requirements are met, with the notes of the
   * request or, without them, the stored ones. The encounter stays open for its other
   * treatments; with `closeEncounter` it also closes, in the same transaction, with the
   * `encounterSummary` given (the caller has verified the password: closing signs it). The
   * close fails, and the completion with it, while another session of the encounter is
   * unfinished.
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

      const invoice = !policy.billingGate.requireClinicalCompletion
        ? await tx.invoiceRequest.findFirst({
            where: {
              tenantId,
              order: { items: { some: { treatmentSessionId: sessionId, releasedAt: null } } },
              status: { in: ['REQUESTED', 'PROCESSING', 'AUTHORIZED'] },
            },
            orderBy: { requestedAt: 'desc' },
          })
        : null;
      if (invoice) {
        // Fiscal finalization takes this lock before updating completed sessions. Lock in the
        // same order so it sees this completion, or Serializable retries our stale invoice read.
        await tx.$queryRaw`SELECT "id" FROM "InvoiceRequest" WHERE "id"=${invoice.id} AND "tenantId"=${tenantId} FOR UPDATE`;
      }
      const completed = await this.transition(tx, session, {
        status: statusAfterClinicalCompletion(invoice?.status),
        completedAt: new Date(),
        ...(notes !== session.procedureNotes
          ? { procedureNotes: notes ? this.crypto.encrypt(tenantId, notes) : null }
          : {}),
      });
      // After the transition: this session no longer counts among the unfinished ones.
      if (dto.closeEncounter === true) {
        await this.encounters.closeEncounter(
          tx,
          tenantId,
          session.encounterId,
          actor,
          dto.encounterSummary,
        );
      }
      await this.auditTransition(tx, actor, session, completed);
      return this.detail(tx, completed, version, policy, actor);
    });
  }

  /**
   * Keeps the notes typed during the procedure, encrypted, so that leaving the page does not
   * lose them. Only while the procedure is in progress; completing takes the stored notes when
   * it brings none. Notes that did not change are not written; the detail returned is then
   * audited as read.
   */
  async saveNotes(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    dto: SaveProcedureNotesDto,
  ): Promise<SessionDetail> {
    const notes = dto.procedureNotes.trim() || null;
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const { session, version, policy } = await this.loadForCommand(
        tx,
        tenantId,
        sessionId,
        actor,
        'SAVE_NOTES',
      );
      if (notes === (session.procedureNotes?.trim() || null)) {
        // Nothing to write, but the detail returned discloses clinical content: audited as read.
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
        return this.detail(tx, session, version, policy, actor);
      }
      const saved = await this.transition(tx, session, {
        procedureNotes: notes ? this.crypto.encrypt(tenantId, notes) : null,
      });
      await this.auditTransition(tx, actor, session, saved);
      return this.detail(tx, saved, version, policy, actor);
    });
  }

  /**
   * Cancels the session with a reason, stored encrypted. Its encounter stays open for its other
   * treatments, and its appointment is left to the close of the encounter.
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
      await this.auditTransition(tx, actor, session, cancelled, reason);
      return this.detail(tx, cancelled, version, policy, actor);
    });
  }

  /**
   * Records that the patient did not come to the session: the no-show is of its whole
   * encounter (see noShowEncounter), and this returns the session as it ended.
   */
  async noShow(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail> {
    const found = await this.transaction(async (tx) => {
      const { session, version } = await this.findSession(tx, tenantId, sessionId);
      if (session.professionalId !== actor.userId) {
        throw clinicalRecordForbidden('Solo el profesional de la atención puede registrar en ella');
      }
      // A session that cannot take a no-show is refused as such, before the encounter is looked at.
      assertCommandAllowed(
        session.status,
        'NO_SHOW',
        parseTreatmentRequirements(version.requirements),
      );
      return session;
    });
    const missed = await this.noShowEncounter(tenantId, found.patientId, found.encounterId, actor);
    const own = missed.find((row) => row.id === sessionId);
    if (!own) throw sessionNotFound();
    return own;
  }

  /**
   * Records that the patient did not come to the encounter: every treatment still waiting ends
   * as NO_SHOW, its appointment (if still unattended or in progress) too, and the encounter
   * closes. It does not apply once anything was done with the patient: a treatment started or
   * finished, a record of its own, a note or an order (409 ENCOUNTER_HAS_ACTIVITY). Sessions
   * already cancelled or missed do not count as activity, unless they were started before being
   * cancelled: the patient was attended then.
   */
  async noShowEncounter(
    tenantId: string,
    patientId: string,
    encounterId: string,
    actor: ClinicalActor,
  ): Promise<SessionDetail[]> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      // Exclusive, as closing it is: a concurrent close or no-show waits here and finds it closed.
      await assertOpenEncounter(tx, tenantId, patientId, encounterId, actor);
      if (!(await lockOpenEncounterForUpdate(tx, tenantId, encounterId))) {
        throw activityConflict('ENCOUNTER_CLOSED', 'La atención ya está cerrada.');
      }
      const all = await tx.treatmentSession.findMany({
        where: { tenantId, encounterId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, formRecordId: true, startedAt: true },
      });
      if (all.length === 0) {
        throw activityConflict(
          'ENCOUNTER_HAS_NO_TREATMENTS',
          'Esta atención no tiene tratamientos.',
        );
      }
      const waiting = all.filter((row) => NO_SHOW_ELIGIBLE_STATUSES.includes(row.status));
      // A treatment cancelled after it started keeps its startedAt: the patient was attended.
      if (
        all.some(
          (row) =>
            row.startedAt !== null ||
            (!NO_SHOW_IGNORED_STATUSES.includes(row.status) && !waiting.includes(row)),
        )
      ) {
        throw activityConflict(
          'ENCOUNTER_HAS_ACTIVITY',
          'La atención ya tiene actividad con el paciente: no se puede marcar como no asistió.',
        );
      }
      if (waiting.length === 0) {
        throw activityConflict(
          'ENCOUNTER_HAS_NO_TREATMENTS',
          'Esta atención no tiene tratamientos pendientes.',
        );
      }
      // What the encounter holds besides the medical forms its treatments keep.
      const formRecordIds = all.flatMap((row) => (row.formRecordId ? [row.formRecordId] : []));
      const [records, notes, orders] = await Promise.all([
        tx.specialtyRecord.count({
          where: { tenantId, encounterId, deletedAt: null, id: { notIn: formRecordIds } },
        }),
        tx.clinicalNote.count({ where: { tenantId, encounterId, deletedAt: null } }),
        tx.clinicalOrder.count({ where: { tenantId, encounterId } }),
      ]);
      if (records + notes + orders > 0) {
        throw activityConflict(
          'ENCOUNTER_HAS_ACTIVITY',
          'La atención ya tiene registros, notas u órdenes: no se puede marcar como no asistió.',
        );
      }

      const ended: {
        after: TreatmentSession;
        version: VersionWithTreatment;
        policy: TreatmentRequirements;
      }[] = [];
      const appointmentIds = new Set<string>();
      for (const { id } of waiting) {
        const { session, version, policy } = await this.loadForCommand(
          tx,
          tenantId,
          id,
          actor,
          'NO_SHOW',
        );
        if (session.appointmentId) appointmentIds.add(session.appointmentId);
        const after = await this.transition(tx, session, {
          status: 'NO_SHOW',
          cancelledAt: new Date(),
        });
        await this.auditTransition(tx, actor, session, after);
        ended.push({ after, version, policy });
      }
      // Before the encounter closes, which would otherwise complete the appointment.
      for (const id of appointmentIds) {
        await tx.appointment.updateMany({
          where: { id, tenantId, status: { in: [...OPEN_APPOINTMENT_STATUSES] } },
          data: { status: 'NO_SHOW' },
        });
      }
      await this.encounters.closeEncounter(tx, tenantId, encounterId, actor);
      const missed: SessionDetail[] = [];
      for (const { after, version, policy } of ended) {
        missed.push(await this.detail(tx, after, version, policy, actor));
      }
      return missed;
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
    if (
      !policy.billingGate.requireClinicalCompletion &&
      ['CANCEL', 'NO_SHOW', 'REVOKE_CONSENT'].includes(command) &&
      (await tx.invoiceRequest.findFirst({
        where: {
          tenantId,
          order: { items: { some: { treatmentSessionId: sessionId, releasedAt: null } } },
          status: { in: ['REQUESTED', 'PROCESSING', 'AUTHORIZED'] },
        },
      }))
    ) {
      throw invalidTransition(
        session.status,
        'La atención tiene una factura pendiente o autorizada.',
      );
    }
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
    actor: ClinicalActor,
  ): Promise<SessionDetail> {
    const { tenantId } = session;
    const patient = await tx.patient.findFirst({
      where: { id: session.patientId, tenantId },
      select: patientSelect,
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const professional = await tx.user.findFirst({
      where: { id: session.professionalId, tenantId },
      select: professionalSelect,
    });

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
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: { select: { timezone: true } } },
    });
    const media = await tx.patientFile.findMany({
      where: { tenantId, treatmentSessionId: session.id, deletedAt: null },
      select: mediaSelect,
      orderBy: { createdAt: 'asc' },
    });
    const encounter = await tx.encounter.findFirst({
      where: { id: session.encounterId, tenantId },
      select: { status: true },
    });
    if (!encounter) throw clinicalRecordNotFound('Atención no encontrada');
    const siblings = await tx.treatmentSession.findMany({
      where: { tenantId, encounterId: session.encounterId, id: { not: session.id } },
      select: {
        id: true,
        status: true,
        treatmentVersion: { select: { treatment: { select: { name: true } } } },
      },
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
      professional,
      treatment: {
        id: version.treatment.id,
        name: version.treatment.name,
        version: version.version,
      },
      policy,
      form,
      consentDocuments: documents.map(({ signature, ...document }) => ({
        ...document,
        title: this.crypto.decrypt(tenantId, document.title),
        signature: signature ? consentSignerView(this.crypto, tenantId, signature) : null,
      })),
      timezone: tenant?.settings?.timezone ?? DEFAULT_CLINIC_TIMEZONE,
      media: media.map((file) => this.crypto.decryptFields(tenantId, file, ENCRYPTED_FILE_FIELDS)),
      requirements: evaluateSession(policy, facts),
      allowedCommands: commandsForActor(session, policy, actor),
      encounterStatus: encounter.status,
      encounterSessions: siblings.map(({ id, status, treatmentVersion }) => ({
        id,
        status,
        treatmentName: treatmentVersion.treatment.name,
      })),
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
