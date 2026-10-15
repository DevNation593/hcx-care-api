import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConsentDocument, ConsentDocumentStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import {
  ClinicalAuditEntry,
  ClinicalAuditService,
} from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { clinicalRecordForbidden } from '../clinical-access/clinical-errors';
import { MAX_SIGNATURE_CHARS, PNG_MAGIC, SIGNATURE_PREFIX } from '../clinical-forms/form-schema';
import { formatLongDateInZone } from '../common/utils/timezone';
import { renderConsentPdf } from '../consents/consent-pdf';
import { consentChecksum, renderConsentText } from '../consents/consent-text';
import { EncountersService } from '../encounters/encounters.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { ADULT_AGE, ageInYears } from '../patients/patient-identity';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { parseTreatmentRequirements } from '../treatments/treatment-requirements';
import { ConsentReasonDto, SignConsentDto } from './dto/consent-document.dto';
import { assertCommandAllowed } from './session-state';
import {
  ConsentSignerView,
  consentSignerView,
  snapshotTreatmentSession,
  TreatmentSessionsService,
} from './treatment-sessions.service';

/** A consent document as the API returns it: decrypted title, never the storage key; the body only where asked. */
export type ConsentDocumentView = Omit<ConsentDocument, 'pdfStorageKey' | 'body'> & {
  body?: string;
  /** Who signed; only the sign response carries it, with the same shape as the session detail. */
  signature?: ConsentSignerView | null;
};

/** The state of a document stored in the audit log; no text, signature or storage key. */
function snapshotConsentDocument(document: ConsentDocument) {
  return {
    treatmentSessionId: document.treatmentSessionId,
    templateVersionId: document.templateVersionId,
    checksum: document.checksum,
    status: document.status,
    presentedAt: document.presentedAt,
    signedAt: document.signedAt,
    refusedAt: document.refusedAt,
    revokedAt: document.revokedAt,
    pdfChecksum: document.pdfChecksum,
  };
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const fullName = (person: { firstName: string; lastName: string }) =>
  `${person.firstName} ${person.lastName}`.trim();

const documentNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'CONSENT_DOCUMENT_NOT_FOUND',
    message: 'Documento de consentimiento no encontrado.',
  });

const invalidState = (status?: ConsentDocumentStatus) =>
  new ConflictException({
    statusCode: 409,
    code: 'CONSENT_DOCUMENT_INVALID_STATE',
    message: 'El documento de consentimiento no admite esta acción en su estado actual.',
    ...(status ? { status } : {}),
  });

const invalidSignature = () =>
  new BadRequestException({
    statusCode: 400,
    code: 'CONSENT_SIGNATURE_INVALID',
    message: 'La firma debe ser una imagen PNG.',
  });

/** The PNG bytes of a signature data URL, checked by what they are, not by what they say. */
function parseSignature(raw: string): Buffer {
  if (typeof raw !== 'string' || !raw.startsWith(SIGNATURE_PREFIX)) throw invalidSignature();
  if (raw.length > MAX_SIGNATURE_CHARS) throw invalidSignature();
  const encoded = raw.slice(SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalidSignature();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length <= PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw invalidSignature();
  }
  return bytes;
}

/**
 * The informed consent of a treatment session: presented with the text of the pinned
 * template version, then signed (with an immutable, encrypted PDF), refused or revoked.
 * Every time is the server's, and every action is audited.
 */
@Injectable()
export class ConsentDocumentsService {
  private readonly logger = new Logger(ConsentDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
    private readonly sessions: TreatmentSessionsService,
    private readonly encounters: EncountersService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /**
   * Presents the consent the session's treatment version pins (even if since retired), filled
   * with the patient, treatment, professional and the clinic's date. A document already
   * presented in the session is returned instead of a new one. Includes the title and body.
   */
  async present(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
  ): Promise<ConsentDocumentView> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      // As loadForCommand, but a treatment without consent is told apart from a wrong moment.
      const { session, version } = await this.sessions.findSession(tx, tenantId, sessionId);
      if (session.professionalId !== actor.userId) {
        throw clinicalRecordForbidden('Solo el profesional de la atención puede registrar en ella');
      }
      const policy = parseTreatmentRequirements(version.requirements);
      if (!policy.informedConsent.required) {
        throw new ConflictException({
          statusCode: 409,
          code: 'CONSENT_NOT_REQUIRED',
          message: 'Este tratamiento no requiere consentimiento informado.',
        });
      }
      assertCommandAllowed(session.status, 'PRESENT_CONSENT', policy);

      const existing = await tx.consentDocument.findFirst({
        where: { tenantId, treatmentSessionId: session.id, status: 'PRESENTED' },
      });
      if (existing) {
        await this.audit.record(
          tenantId,
          actor,
          [
            {
              action: 'READ',
              entity: 'CONSENT_DOCUMENT',
              entityId: existing.id,
              patientId: existing.patientId,
            },
          ],
          tx,
        );
        return this.view(existing, true);
      }

      const template = version.consentTemplateVersionId
        ? await tx.consentTemplateVersion.findFirst({
            where: { id: version.consentTemplateVersionId, tenantId },
          })
        : null;
      if (!template) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TREATMENT_SESSION_INVALID_TRANSITION',
          message: 'El tratamiento no tiene un consentimiento para presentar.',
          status: session.status,
          command: 'PRESENT_CONSENT',
        });
      }

      const patient = await tx.patient.findFirst({
        where: { id: session.patientId, tenantId },
        select: { firstName: true, lastName: true, identificationNumber: true },
      });
      if (!patient) throw new NotFoundException('Paciente no encontrado');
      const professional = await tx.user.findFirst({
        where: { id: session.professionalId, tenantId },
        select: { firstName: true, lastName: true },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: { select: { timezone: true } } },
      });

      const now = new Date();
      const values = {
        paciente: fullName(patient),
        identificacion: patient.identificationNumber ?? '',
        tratamiento: version.treatment.name,
        profesional: professional ? fullName(professional) : '',
        fecha: formatLongDateInZone(now, tenant?.settings?.timezone),
      };
      const title = renderConsentText(template.title, values);
      const body = renderConsentText(template.body, values);

      const created = await tx.consentDocument.create({
        data: {
          tenantId,
          patientId: session.patientId,
          treatmentSessionId: session.id,
          templateVersionId: template.id,
          title: this.crypto.encrypt(tenantId, title),
          body: this.crypto.encrypt(tenantId, body),
          checksum: consentChecksum(title, body),
          presentedAt: now,
        },
      });
      await tx.consentEvent.create({
        data: { tenantId, documentId: created.id, type: 'PRESENTED', actorId: actor.userId },
      });
      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'CONSENT_DOCUMENT',
            entityId: created.id,
            patientId: created.patientId,
            after: snapshotConsentDocument(created),
          },
        ],
        tx,
      );

      return this.view(created, true);
    });
  }

  /**
   * Signs a presented document: the signature PNG and the generated PDF are stored encrypted
   * before the transaction (and removed if it fails); inside it the document is claimed with
   * a guarded update, so a second signature answers 409 and writes nothing.
   */
  async sign(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
    dto: SignConsentDto,
  ): Promise<ConsentDocumentView> {
    const png = parseSignature(dto.signature);
    const relationship = dto.signerRole === 'REPRESENTATIVE' ? dto.relationship?.trim() : null;
    if (dto.signerRole === 'REPRESENTATIVE' && !relationship) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'CONSENT_RELATIONSHIP_REQUIRED',
        message: 'Indica la relación del representante con el paciente.',
      });
    }
    if (dto.understood !== true || dto.questionsAnswered !== true) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'CONSENT_DECLARATIONS_REQUIRED',
        message:
          'El firmante debe declarar que comprendió el texto y que se respondieron sus preguntas.',
      });
    }
    const signer = {
      signerRole: dto.signerRole,
      signerName: dto.signerName.trim(),
      signerIdentification: dto.signerIdentification?.trim() || null,
      relationship: relationship || null,
      understood: true,
      questionsAnswered: true,
      marketingPhotos: dto.marketingPhotos === true,
    };

    // Everything the PDF prints, read before anything is written.
    const prepared = await this.transaction(async (tx) => {
      const document = await this.findDocument(tx, tenantId, documentId);
      if (document.status !== 'PRESENTED') throw invalidState(document.status);
      const { version } = await this.sessions.loadForCommand(
        tx,
        tenantId,
        document.treatmentSessionId,
        actor,
        'SIGN_CONSENT',
      );

      const patient = await tx.patient.findFirst({
        where: { id: document.patientId, tenantId },
        select: { firstName: true, lastName: true, dateOfBirth: true, identificationNumber: true },
      });
      if (!patient) throw new NotFoundException('Paciente no encontrado');
      if (
        signer.signerRole === 'PATIENT' &&
        patient.dateOfBirth &&
        ageInYears(patient.dateOfBirth, new Date()) < ADULT_AGE
      ) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'CONSENT_REPRESENTATIVE_REQUIRED',
          message: 'El paciente es menor de edad: debe firmar su representante.',
        });
      }

      const template = await tx.consentTemplateVersion.findFirst({
        where: { id: document.templateVersionId, tenantId },
        select: { version: true, checksum: true },
      });
      if (!template) throw documentNotFound();
      const operator = await tx.user.findFirst({
        where: { id: actor.userId, tenantId },
        select: { firstName: true, lastName: true },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, address: true, settings: { select: { timezone: true } } },
      });
      return { document, version, patient, template, operator, tenant };
    });

    const { document, version, patient, template, operator, tenant } = prepared;
    const signedAt = new Date();
    const pdf = await renderConsentPdf({
      clinic: { name: tenant?.name ?? '', address: tenant?.address },
      patient: { name: fullName(patient), identification: patient.identificationNumber },
      treatment: { name: version.treatment.name, version: version.version },
      templateVersion: { version: template.version, checksum: template.checksum },
      title: this.crypto.decrypt(tenantId, document.title),
      body: this.crypto.decrypt(tenantId, document.body),
      checksum: document.checksum,
      signature: { png, ...signer },
      operatorName: operator ? fullName(operator) : actor.userId,
      signedAt,
      timezone: tenant?.settings?.timezone ?? 'UTC',
    });
    const pdfChecksum = sha256(pdf);

    // Each attempt writes its own objects, so a losing double submit never touches the winner's.
    const attempt = randomUUID();
    const signatureKey = `${tenantId}/consents/${documentId}/signature/${attempt}`;
    const pdfKey = `${tenantId}/consents/${documentId}/pdf/${attempt}`;
    const written: string[] = [];

    try {
      await this.storage.put(signatureKey, this.crypto.encryptBuffer(tenantId, png));
      written.push(signatureKey);
      await this.storage.put(pdfKey, this.crypto.encryptBuffer(tenantId, pdf));
      written.push(pdfKey);

      return await runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
        // Claimed first: a second signature answers for the document, not for its session.
        await this.claim(tx, tenantId, documentId, 'PRESENTED', {
          status: 'SIGNED',
          signedAt,
          pdfStorageKey: pdfKey,
          pdfChecksum,
        });
        const { session } = await this.sessions.loadForCommand(
          tx,
          tenantId,
          document.treatmentSessionId,
          actor,
          'SIGN_CONSENT',
        );

        const stored = await tx.consentSignature.create({
          data: {
            tenantId,
            documentId,
            signerRole: signer.signerRole,
            signerName: this.crypto.encrypt(tenantId, signer.signerName),
            signerIdentification: this.crypto.encrypt(tenantId, signer.signerIdentification ?? ''),
            relationship: signer.relationship
              ? this.crypto.encrypt(tenantId, signer.relationship)
              : null,
            understood: signer.understood,
            questionsAnswered: signer.questionsAnswered,
            marketingPhotos: signer.marketingPhotos,
            signatureStorageKey: signatureKey,
            operatorId: actor.userId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            signedAt,
          },
        });
        const consented = await this.sessions.transition(tx, session, {
          status: 'CONSENTED',
          consentDocument: { connect: { id: documentId } },
        });
        await tx.consentEvent.create({
          data: { tenantId, documentId, type: 'SIGNED', actorId: actor.userId },
        });

        const signed = await this.findDocument(tx, tenantId, documentId);
        await this.audit.record(
          tenantId,
          actor,
          [
            {
              action: 'UPDATE',
              entity: 'CONSENT_DOCUMENT',
              entityId: documentId,
              patientId: document.patientId,
              before: snapshotConsentDocument(document),
              after: snapshotConsentDocument(signed),
            },
            {
              action: 'UPDATE',
              entity: 'TREATMENT_SESSION',
              entityId: session.id,
              patientId: session.patientId,
              before: snapshotTreatmentSession(session),
              after: snapshotTreatmentSession(consented),
            },
          ],
          tx,
        );
        return {
          ...this.view(signed),
          signature: consentSignerView(this.crypto, tenantId, stored),
        };
      });
    } catch (error) {
      // Nothing refers to these objects once the signature could not be recorded.
      await Promise.all(written.map((key) => this.storage.remove(key).catch(() => undefined)));
      throw error;
    }
  }

  /** Refuses a presented document: the session ends as CONSENT_REFUSED and its encounter closes. */
  async refuse(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
    dto: ConsentReasonDto,
  ): Promise<ConsentDocumentView> {
    const reason = dto.reason.trim();
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const document = await this.findDocument(tx, tenantId, documentId);
      if (document.status !== 'PRESENTED') throw invalidState(document.status);
      const { session } = await this.sessions.loadForCommand(
        tx,
        tenantId,
        document.treatmentSessionId,
        actor,
        'REFUSE_CONSENT',
      );

      await this.claim(tx, tenantId, documentId, 'PRESENTED', {
        status: 'REFUSED',
        refusedAt: new Date(),
      });
      const refusedSession = await this.sessions.transition(tx, session, {
        status: 'CONSENT_REFUSED',
      });
      await this.encounters.closeEncounter(tx, tenantId, session.encounterId, actor);
      await tx.consentEvent.create({
        data: {
          tenantId,
          documentId,
          type: 'REFUSED',
          reason: this.crypto.encrypt(tenantId, reason),
          actorId: actor.userId,
        },
      });

      const refused = await this.findDocument(tx, tenantId, documentId);
      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'CONSENT_DOCUMENT',
            entityId: documentId,
            patientId: document.patientId,
            before: snapshotConsentDocument(document),
            after: snapshotConsentDocument(refused),
            reason,
          },
          {
            action: 'UPDATE',
            entity: 'TREATMENT_SESSION',
            entityId: session.id,
            patientId: session.patientId,
            before: snapshotTreatmentSession(session),
            after: snapshotTreatmentSession(refusedSession),
          },
        ],
        tx,
      );
      return this.view(refused);
    });
  }

  /**
   * Revokes a signed document, by the session's professional or the tenant MASTER. Its own
   * session ends as CONSENT_REVOKED (closing its encounter) only while it is CONSENTED; a
   * session in any other state is left alone. Other sessions that reused it and are still
   * CONSENTED go back to READY_FOR_CONSENT without it.
   */
  async revoke(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
    dto: ConsentReasonDto,
  ): Promise<ConsentDocumentView> {
    const reason = dto.reason.trim();
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const document = await this.findDocument(tx, tenantId, documentId);
      if (document.status !== 'SIGNED') throw invalidState(document.status);
      const { session, version } = await this.sessions.findSession(
        tx,
        tenantId,
        document.treatmentSessionId,
      );
      if (session.professionalId !== actor.userId && actor.role !== 'MASTER') {
        throw clinicalRecordForbidden(
          'Solo el profesional de la atención o el titular de la cuenta pueden revocar el consentimiento',
        );
      }

      await this.claim(tx, tenantId, documentId, 'SIGNED', {
        status: 'REVOKED',
        revokedAt: new Date(),
      });

      const sessionEntries: ClinicalAuditEntry[] = [];
      if (session.status === 'CONSENTED') {
        assertCommandAllowed(
          session.status,
          'REVOKE_CONSENT',
          parseTreatmentRequirements(version.requirements),
        );
        const revokedSession = await this.sessions.transition(tx, session, {
          status: 'CONSENT_REVOKED',
        });
        await this.encounters.closeEncounter(tx, tenantId, session.encounterId, actor, undefined, {
          anyAuthor: true,
        });
        sessionEntries.push({
          action: 'UPDATE',
          entity: 'TREATMENT_SESSION',
          entityId: session.id,
          patientId: session.patientId,
          before: snapshotTreatmentSession(session),
          after: snapshotTreatmentSession(revokedSession),
        });
      }

      // Later sessions that reused this consent and have not started go back to the consent step.
      const reusing = await tx.treatmentSession.findMany({
        where: {
          tenantId,
          consentDocumentId: documentId,
          status: 'CONSENTED',
          id: { not: session.id },
        },
        select: { id: true },
      });
      for (const { id } of reusing) {
        const { session: reused } = await this.sessions.findSession(tx, tenantId, id);
        const returned = await this.sessions.transition(tx, reused, {
          status: 'READY_FOR_CONSENT',
          consentDocument: { disconnect: true },
        });
        sessionEntries.push({
          action: 'UPDATE',
          entity: 'TREATMENT_SESSION',
          entityId: reused.id,
          patientId: reused.patientId,
          before: snapshotTreatmentSession(reused),
          after: snapshotTreatmentSession(returned),
          reason: 'Consentimiento revocado',
        });
      }

      await tx.consentEvent.create({
        data: {
          tenantId,
          documentId,
          type: 'REVOKED',
          reason: this.crypto.encrypt(tenantId, reason),
          actorId: actor.userId,
        },
      });

      const revoked = await this.findDocument(tx, tenantId, documentId);
      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'CONSENT_DOCUMENT',
            entityId: documentId,
            patientId: document.patientId,
            before: snapshotConsentDocument(document),
            after: snapshotConsentDocument(revoked),
            reason,
          },
          ...sessionEntries,
        ],
        tx,
      );
      return this.view(revoked);
    });
  }

  /** The signed PDF, checked against the checksum kept on signing. The download is audited. */
  async pdf(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
  ): Promise<{ fileName: string; data: Buffer }> {
    const document = await this.findDocument(this.prisma, tenantId, documentId);
    if (!document.pdfStorageKey || !document.pdfChecksum) throw invalidState(document.status);

    const stored = await this.storage.get(document.pdfStorageKey);
    let data: Buffer | null = null;
    try {
      data = this.crypto.decryptBuffer(tenantId, stored);
    } catch {
      // An altered ciphertext fails its authentication tag: the same breach as altered bytes.
    }
    if (!data || sha256(data) !== document.pdfChecksum) {
      this.logger.error(`Consent PDF integrity check failed for document ${documentId}`);
      throw new InternalServerErrorException({
        statusCode: 500,
        code: 'CONSENT_PDF_INTEGRITY',
        message: 'El PDF del consentimiento no coincide con el que se firmó.',
      });
    }

    await this.audit.record(tenantId, actor, [
      {
        action: 'READ',
        entity: 'CONSENT_DOCUMENT',
        entityId: documentId,
        patientId: document.patientId,
      },
    ]);
    return { fileName: `consentimiento-${document.id}.pdf`, data };
  }

  /** Moves the document out of `from`; 409 when another request already moved it. */
  private async claim(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentId: string,
    from: ConsentDocumentStatus,
    data: Prisma.ConsentDocumentUpdateManyMutationInput,
  ): Promise<void> {
    const claimed = await tx.consentDocument.updateMany({
      where: { id: documentId, tenantId, status: from },
      data,
    });
    if (claimed.count === 0) throw invalidState();
  }

  private async findDocument(
    db: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    documentId: string,
  ): Promise<ConsentDocument> {
    const document = await db.consentDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!document) throw documentNotFound();
    return document;
  }

  private view(document: ConsentDocument, withBody = false): ConsentDocumentView {
    const { pdfStorageKey: _key, body, ...rest } = document;
    const { tenantId } = document;
    return {
      ...rest,
      title: this.crypto.decrypt(tenantId, document.title),
      ...(withBody ? { body: this.crypto.decrypt(tenantId, body) } : {}),
    };
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
