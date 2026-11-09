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
import { randomUUID } from 'crypto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { clinicalRecordForbidden } from '../clinical-access/clinical-errors';
import { DEFAULT_CLINIC_TIMEZONE, formatLongDateInZone } from '../common/utils/timezone';
import { renderConsentPdf } from '../consents/consent-pdf';
import { consentChecksum, renderConsentText } from '../consents/consent-text';
import { assertOpenEncounter, lockOpenEncounter } from '../encounters/encounters.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { ADULT_AGE, ageInYears } from '../patients/patient-identity';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { ConsentReasonDto } from '../treatment-sessions/dto/consent-document.dto';
import {
  documentNotFound,
  fullName,
  invalidState,
  parseSignature,
  sha256,
  snapshotConsentDocument,
} from '../treatment-sessions/consent-documents.service';
import { PresentProcedureConsentDto, SignProcedureConsentDto } from './dto/procedure-consent.dto';

type Tx = Prisma.TransactionClient;

const documentInclude = {
  templateVersion: { select: { id: true, version: true, template: { select: { name: true } } } },
  signature: {
    select: {
      signerRole: true,
      signerName: true,
      relationship: true,
      witnessName: true,
      signedAt: true,
      operatorId: true,
    },
  },
  events: {
    select: { type: true, reason: true, actorId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
  encounter: { select: { id: true, professionalId: true, status: true, startedAt: true } },
} satisfies Prisma.ConsentDocumentInclude;

type StoredDocument = Prisma.ConsentDocumentGetPayload<{ include: typeof documentInclude }>;

/**
 * Informed consents for clinical procedures (an IUD insertion, a colposcopy, a biopsy), taken in a
 * clinical encounter. Same evidence as the consents of treatment sessions: the text of a published
 * template version as the patient saw it, its checksum, the decision (signed or refused), who signed
 * and how, an immutable encrypted PDF with its SHA-256, and every event with its author. A refusal is
 * recorded and nothing else is blocked: whether to proceed is the professional's decision.
 */
@Injectable()
export class ProcedureConsentsService {
  private readonly logger = new Logger(ProcedureConsentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** The consent templates of the clinic that have a published version to present. */
  async templates(tenantId: string) {
    const templates = await this.prisma.consentTemplate.findMany({
      where: { tenantId, isActive: true },
      include: {
        versions: {
          where: { status: 'PUBLISHED' },
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, title: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return templates
      .filter((template) => template.versions.length > 0)
      .map((template) => ({
        templateId: template.id,
        name: template.name,
        versionId: template.versions[0].id,
        version: template.versions[0].version,
        title: template.versions[0].title,
      }));
  }

  /** The procedure consents of the patient, newest first. Every one listed is audited. */
  async list(tenantId: string, patientId: string, actor: ClinicalActor) {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.consentDocument.findMany({
      where: { tenantId, patientId, encounterId: { not: null } },
      include: documentInclude,
      orderBy: { presentedAt: 'desc' },
    });
    await this.audit.record(
      tenantId,
      actor,
      stored.map((document) => ({
        action: 'READ' as const,
        entity: 'CONSENT_DOCUMENT' as const,
        entityId: document.id,
        patientId,
      })),
    );
    return stored.map((document) => this.view(document));
  }

  /**
   * One procedure consent with the text the patient read, to show it again: a document presented
   * and not yet decided is taken up where it was left. The read is audited.
   */
  async findOne(tenantId: string, documentId: string, actor: ClinicalActor) {
    const document = await this.findDocument(this.prisma, tenantId, documentId);
    await this.audit.record(tenantId, actor, [
      {
        action: 'READ',
        entity: 'CONSENT_DOCUMENT',
        entityId: documentId,
        patientId: document.patientId,
      },
    ]);
    return this.view(document, true);
  }

  /**
   * Presents the latest published version of a template in an open encounter of the caller,
   * filled with the patient, the procedure, the professional and the clinic's date. A document of
   * the same template still waiting for its decision in that encounter is returned instead.
   */
  async present(
    tenantId: string,
    patientId: string,
    encounterId: string,
    actor: ClinicalActor,
    dto: PresentProcedureConsentDto,
  ) {
    await assertOpenEncounter(this.prisma, tenantId, patientId, encounterId, actor);
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      if (!(await lockOpenEncounter(tx, tenantId, encounterId))) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ENCOUNTER_CLOSED',
          message: 'La atención ya está cerrada.',
        });
      }
      const template = await tx.consentTemplateVersion.findFirst({
        where: { tenantId, templateId: dto.templateId, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
      });
      if (!template) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'CONSENT_TEMPLATE_NOT_PUBLISHED',
          message: 'La plantilla no existe o no tiene una versión publicada.',
        });
      }

      const pending = await tx.consentDocument.findFirst({
        where: { tenantId, encounterId, templateVersionId: template.id, status: 'PRESENTED' },
        include: documentInclude,
      });
      if (pending) {
        await this.audit.record(
          tenantId,
          actor,
          [{ action: 'READ', entity: 'CONSENT_DOCUMENT', entityId: pending.id, patientId }],
          tx,
        );
        return this.view(pending, true);
      }

      const patient = await tx.patient.findFirst({
        where: { id: patientId, tenantId },
        select: { firstName: true, lastName: true, identificationNumber: true },
      });
      if (!patient) throw new NotFoundException('Paciente no encontrado');
      const professional = await tx.user.findFirst({
        where: { id: actor.userId, tenantId },
        select: { firstName: true, lastName: true },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: { select: { timezone: true } } },
      });

      const now = new Date();
      const procedureName = dto.procedureName.trim();
      const values = {
        paciente: fullName(patient),
        identificacion: patient.identificationNumber ?? '',
        // Templates written for treatments use {{tratamiento}}: it names the procedure here.
        tratamiento: procedureName,
        procedimiento: procedureName,
        profesional: professional ? fullName(professional) : '',
        fecha: formatLongDateInZone(now, tenant?.settings?.timezone ?? DEFAULT_CLINIC_TIMEZONE),
      };
      const title = renderConsentText(template.title, values);
      const body = renderConsentText(template.body, values);

      const created = await tx.consentDocument.create({
        data: {
          tenantId,
          patientId,
          encounterId,
          procedureName: this.crypto.encrypt(tenantId, procedureName),
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
            patientId,
            after: snapshotConsentDocument(created),
          },
        ],
        tx,
      );
      return this.view(await this.findDocument(tx, tenantId, created.id), true);
    });
  }

  /**
   * Signs a presented document, by the professional of its encounter: the signature PNG and the
   * PDF are stored encrypted first (and removed if the signature cannot be recorded); the document
   * is then claimed with a guarded update, so a second signature answers 409 and writes nothing.
   */
  async sign(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
    dto: SignProcedureConsentDto,
  ) {
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
      witnessName: dto.witnessName?.trim() || null,
      understood: true,
      questionsAnswered: true,
      // Procedures take no photos for advertising.
      marketingPhotos: false,
    };

    const prepared = await this.transaction(async (tx) => {
      const document = await this.findDocument(tx, tenantId, documentId);
      if (document.status !== 'PRESENTED') throw invalidState(document.status);
      this.assertProfessional(document, actor);

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
      return { document, patient, template, operator, tenant };
    });

    const { document, patient, template, operator, tenant } = prepared;
    const signedAt = new Date();
    const pdf = await renderConsentPdf({
      clinic: { name: tenant?.name ?? '', address: tenant?.address },
      patient: { name: fullName(patient), identification: patient.identificationNumber },
      treatment: {
        name: this.crypto.decrypt(tenantId, document.procedureName ?? ''),
        version: null,
        label: 'Procedimiento',
      },
      templateVersion: { version: template.version, checksum: template.checksum },
      title: this.crypto.decrypt(tenantId, document.title),
      body: this.crypto.decrypt(tenantId, document.body),
      checksum: document.checksum,
      signature: { png, ...signer },
      showMarketingPhotos: false,
      operatorName: operator ? fullName(operator) : actor.userId,
      signedAt,
      timezone: tenant?.settings?.timezone ?? DEFAULT_CLINIC_TIMEZONE,
    });
    const pdfChecksum = sha256(pdf);

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
        await this.claim(tx, tenantId, documentId, 'PRESENTED', {
          status: 'SIGNED',
          signedAt,
          pdfStorageKey: pdfKey,
          pdfChecksum,
        });
        await tx.consentSignature.create({
          data: {
            tenantId,
            documentId,
            signerRole: signer.signerRole,
            signerName: this.crypto.encrypt(tenantId, signer.signerName),
            signerIdentification: this.crypto.encrypt(tenantId, signer.signerIdentification ?? ''),
            relationship: signer.relationship
              ? this.crypto.encrypt(tenantId, signer.relationship)
              : null,
            witnessName: signer.witnessName
              ? this.crypto.encrypt(tenantId, signer.witnessName)
              : null,
            understood: signer.understood,
            questionsAnswered: signer.questionsAnswered,
            marketingPhotos: false,
            signatureStorageKey: signatureKey,
            operatorId: actor.userId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            signedAt,
          },
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
          ],
          tx,
        );
        return this.view(signed);
      });
    } catch (error) {
      await Promise.all(written.map((key) => this.storage.remove(key).catch(() => undefined)));
      throw error;
    }
  }

  /** The patient or their representative declined. Recorded with the reason; nothing is closed. */
  async refuse(tenantId: string, documentId: string, actor: ClinicalActor, dto: ConsentReasonDto) {
    return this.decide(tenantId, documentId, actor, dto.reason.trim(), 'PRESENTED', 'REFUSED', {
      status: 'REFUSED',
      refusedAt: new Date(),
    });
  }

  /** Withdraws a signed consent, by the professional of the encounter or the account holder. */
  async revoke(tenantId: string, documentId: string, actor: ClinicalActor, dto: ConsentReasonDto) {
    return this.decide(tenantId, documentId, actor, dto.reason.trim(), 'SIGNED', 'REVOKED', {
      status: 'REVOKED',
      revokedAt: new Date(),
    });
  }

  /** The signed PDF, checked against the checksum kept on signing. The download is audited. */
  async pdf(tenantId: string, documentId: string, actor: ClinicalActor) {
    const document = await this.findDocument(this.prisma, tenantId, documentId);
    if (!document.pdfStorageKey || !document.pdfChecksum) throw invalidState(document.status);

    let data: Buffer | null = null;
    try {
      data = this.crypto.decryptBuffer(tenantId, await this.storage.get(document.pdfStorageKey));
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

  private async decide(
    tenantId: string,
    documentId: string,
    actor: ClinicalActor,
    reason: string,
    from: ConsentDocumentStatus,
    event: 'REFUSED' | 'REVOKED',
    data: Prisma.ConsentDocumentUpdateManyMutationInput,
  ) {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const document = await this.findDocument(tx, tenantId, documentId);
      if (document.status !== from) throw invalidState(document.status);
      this.assertProfessional(document, actor, { masterToo: event === 'REVOKED' });

      await this.claim(tx, tenantId, documentId, from, data);
      await tx.consentEvent.create({
        data: {
          tenantId,
          documentId,
          type: event,
          reason: this.crypto.encrypt(tenantId, reason),
          actorId: actor.userId,
        },
      });
      const decided = await this.findDocument(tx, tenantId, documentId);
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
            after: snapshotConsentDocument(decided),
            reason,
          },
        ],
        tx,
      );
      return this.view(decided);
    });
  }

  /** Only the professional attending the encounter acts on its consents (and the MASTER revokes). */
  private assertProfessional(
    document: StoredDocument,
    actor: ClinicalActor,
    options: { masterToo?: boolean } = {},
  ) {
    if (document.encounter?.professionalId === actor.userId) return;
    if (options.masterToo && actor.role === 'MASTER') return;
    throw clinicalRecordForbidden(
      options.masterToo
        ? 'Solo el profesional de la atención o el titular de la cuenta pueden revocar el consentimiento'
        : 'Solo el profesional de la atención puede registrar este consentimiento',
    );
  }

  private async claim(
    tx: Tx,
    tenantId: string,
    documentId: string,
    from: ConsentDocumentStatus,
    data: Prisma.ConsentDocumentUpdateManyMutationInput,
  ) {
    const claimed = await tx.consentDocument.updateMany({
      where: { id: documentId, tenantId, status: from },
      data,
    });
    if (claimed.count === 0) throw invalidState();
  }

  /** A consent of a clinical procedure; the consents of treatment sessions are not found here. */
  private async findDocument(
    db: Tx | PrismaService,
    tenantId: string,
    documentId: string,
  ): Promise<StoredDocument> {
    const document = await db.consentDocument.findFirst({
      where: { id: documentId, tenantId, encounterId: { not: null } },
      include: documentInclude,
    });
    if (!document) throw documentNotFound();
    return document;
  }

  /** Decrypted, without storage keys; the body only where asked; the reason of each event. */
  private view(document: StoredDocument | ConsentDocument, withBody = false) {
    const { tenantId } = document;
    const stored = document as StoredDocument;
    const {
      pdfStorageKey: _key,
      body,
      signature,
      events,
      ...rest
    } = stored as StoredDocument & { pdfStorageKey: string | null };
    return {
      ...rest,
      title: this.crypto.decrypt(tenantId, document.title),
      procedureName: document.procedureName
        ? this.crypto.decrypt(tenantId, document.procedureName)
        : null,
      ...(withBody ? { body: this.crypto.decrypt(tenantId, body) } : {}),
      hasPdf: Boolean(document.pdfStorageKey),
      signature: signature
        ? {
            signerRole: signature.signerRole,
            signerName: this.crypto.decrypt(tenantId, signature.signerName),
            relationship: signature.relationship
              ? this.crypto.decrypt(tenantId, signature.relationship)
              : null,
            witnessName: signature.witnessName
              ? this.crypto.decrypt(tenantId, signature.witnessName)
              : null,
            signedAt: signature.signedAt,
          }
        : null,
      events: (events ?? []).map((event) => ({
        ...event,
        reason: event.reason ? this.crypto.decrypt(tenantId, event.reason) : null,
      })),
    };
  }

  private async assertPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
  }

  private transaction<T>(callback: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
