import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicalOrder, ClinicalResult, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import {
  ClinicalAuditEntry,
  ClinicalAuditService,
} from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { clinicalRecordNotFound } from '../clinical-access/clinical-errors';
import {
  isRecordSigned,
  orderContentHash,
  resultContentHash,
} from '../clinical-access/clinical-signature';
import { assertOpenEncounter, lockOpenEncounter } from '../encounters/encounters.service';
import { lockPatientFileRow } from '../patient-files/patient-files.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertAssignableProfessional,
  cleanText,
  ENCRYPTED_FOLLOW_UP_FIELDS,
  ENCRYPTED_ORDER_FIELDS,
  ENCRYPTED_RESULT_FIELDS,
  inboxThresholds,
  orderInclude,
  snapshotFollowUp,
  snapshotOrder,
  snapshotResult,
  StoredOrder,
  toOrderView,
} from './clinical-order-view';
import {
  AddClinicalResultDto,
  CancelClinicalOrderDto,
  CollectSampleDto,
  CompleteClinicalOrderDto,
  CreateClinicalOrderDto,
  RecordCommunicationDto,
  ReviewClinicalResultDto,
  SendToLabDto,
} from './dto/clinical-orders.dto';
import { addDays, assertCanRun, clinicalOrderVersionConflict, OrderCommand } from './order-state';

type Tx = Prisma.TransactionClient;

const orderNotFound = () => clinicalRecordNotFound('Orden no encontrada');
const resultNotFound = () => clinicalRecordNotFound('Resultado no encontrado');

const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, code, message });

/**
 * Clinical orders and their results. Any professional of the clinic with an active profile reads
 * and moves them along (the clinical record is shared within the clinic); every read and change
 * is audited, and every free text is stored encrypted. The request of an order is signed with its
 * encounter, or when it is saved outside one.
 */
@Injectable()
export class ClinicalOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  /** Orders of the patient, newest first, with their results and follow-ups. Audited. */
  async list(tenantId: string, patientId: string, actor: ClinicalActor) {
    await this.assertPatient(this.prisma, tenantId, patientId);
    const stored = await this.prisma.clinicalOrder.findMany({
      where: { tenantId, patientId },
      include: orderInclude,
      orderBy: { orderedAt: 'desc' },
    });
    await this.audit.record(
      tenantId,
      actor,
      stored.map((order) => ({
        action: 'READ' as const,
        entity: 'CLINICAL_ORDER' as const,
        entityId: order.id,
        patientId,
      })),
    );
    return stored.map((order) => toOrderView(this.crypto, tenantId, order));
  }

  async findOne(tenantId: string, orderId: string, actor: ClinicalActor) {
    const stored = await this.prisma.clinicalOrder.findFirst({
      where: { id: orderId, tenantId },
      include: orderInclude,
    });
    if (!stored) throw orderNotFound();
    await this.audit.record(tenantId, actor, [
      { action: 'READ', entity: 'CLINICAL_ORDER', entityId: orderId, patientId: stored.patientId },
    ]);
    return toOrderView(this.crypto, tenantId, stored);
  }

  /**
   * Inside an open encounter of the caller the order is signed when the encounter closes;
   * without one it is signed now (the controller has already checked the password).
   */
  async create(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateClinicalOrderDto,
  ) {
    await this.assertPatient(this.prisma, tenantId, patientId);
    if (dto.encounterId) {
      await assertOpenEncounter(this.prisma, tenantId, patientId, dto.encounterId, actor);
    }

    return this.transaction(async (tx) => {
      if (dto.encounterId && !(await lockOpenEncounter(tx, tenantId, dto.encounterId))) {
        throw conflict('ENCOUNTER_CLOSED', 'La atención ya está cerrada.');
      }
      const { orderResultAlertDays } = await inboxThresholds(tx, tenantId);
      const orderedAt = new Date();
      const plain = {
        studyName: dto.studyName.trim(),
        indication: cleanText(dto.indication),
        provider: cleanText(dto.provider),
      };

      const created = await tx.clinicalOrder.create({
        data: {
          tenantId,
          patientId,
          orderedById: actor.userId,
          encounterId: dto.encounterId ?? null,
          orderType: dto.orderType,
          priority: dto.priority ?? 'ROUTINE',
          orderedAt,
          resultDueAt: dto.resultDueAt
            ? new Date(dto.resultDueAt)
            : addDays(orderedAt, orderResultAlertDays),
          ...this.encrypt(tenantId, plain),
        },
      });

      const stored = dto.encounterId
        ? created
        : await tx.clinicalOrder.update({
            where: { id: created.id },
            data: {
              signedAt: orderedAt,
              contentHash: orderContentHash({ ...created, ...plain }),
            },
          });

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'CLINICAL_ORDER',
            entityId: stored.id,
            patientId,
            after: snapshotOrder({ ...stored, ...plain }),
          },
        ],
        tx,
      );
      return this.view(tx, tenantId, stored.id);
    });
  }

  async collectSample(
    tenantId: string,
    orderId: string,
    actor: ClinicalActor,
    dto: CollectSampleDto,
  ) {
    return this.command(tenantId, orderId, actor, dto.version, 'collectSample', async () => ({
      data: {
        status: 'SAMPLE_COLLECTED',
        sampleCollectedAt: dto.collectedAt ? new Date(dto.collectedAt) : new Date(),
        sampleNotes: this.encryptOptional(tenantId, dto.notes),
      },
      reason: 'Toma de muestra',
    }));
  }

  async sendToLab(tenantId: string, orderId: string, actor: ClinicalActor, dto: SendToLabDto) {
    return this.command(tenantId, orderId, actor, dto.version, 'sendToLab', async () => ({
      data: {
        status: 'SENT_TO_LAB',
        sentAt: dto.sentAt ? new Date(dto.sentAt) : new Date(),
        ...(cleanText(dto.provider)
          ? { provider: this.crypto.encrypt(tenantId, cleanText(dto.provider)!) }
          : {}),
        ...(cleanText(dto.externalReference)
          ? {
              externalReference: this.crypto.encrypt(tenantId, cleanText(dto.externalReference)!),
            }
          : {}),
      },
      reason: 'Envío al laboratorio',
    }));
  }

  /**
   * Records a version of the report. It always waits for a review, and never marks the patient as
   * informed. Earlier versions still waiting for review are kept, marked as superseded.
   */
  async addResult(
    tenantId: string,
    orderId: string,
    actor: ClinicalActor,
    dto: AddClinicalResultDto,
  ) {
    const content = cleanText(dto.content);
    if (!content && !dto.fileId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'CLINICAL_RESULT_EMPTY',
        message: 'Escribe el informe o adjunta el archivo del resultado.',
      });
    }

    return this.command(tenantId, orderId, actor, dto.version, 'addResult', async (tx, current) => {
      // Its author may be removing it right now: whoever takes the row first decides.
      if (dto.fileId) await lockPatientFileRow(tx, tenantId, dto.fileId);
      const file = dto.fileId
        ? await tx.patientFile.findFirst({
            where: { id: dto.fileId, tenantId, patientId: current.patientId, deletedAt: null },
            select: { id: true, contentHash: true, clinicalResult: { select: { id: true } } },
          })
        : null;
      if (dto.fileId && !file) {
        throw new BadRequestException('El archivo no pertenece al paciente');
      }
      if (file?.clinicalResult) {
        throw conflict(
          'CLINICAL_RESULT_FILE_IN_USE',
          'El archivo ya es el informe de otro resultado.',
        );
      }
      if (dto.recordId) {
        const record = await tx.specialtyRecord.findFirst({
          where: { id: dto.recordId, tenantId, patientId: current.patientId, deletedAt: null },
          select: {
            id: true,
            signedAt: true,
            encounterId: true,
            encounter: { select: { status: true } },
            clinicalResult: { select: { id: true } },
          },
        });
        if (!record) throw new BadRequestException('El registro no pertenece al paciente');
        // The result only names the record: it has to be final, or its author could still change
        // or remove the study after it was reviewed. A signed record never changes again.
        if (!isRecordSigned(record)) {
          throw conflict(
            'CLINICAL_RESULT_RECORD_NOT_SIGNED',
            'El registro todavía se puede modificar: cierra su atención antes de vincularlo a un resultado.',
          );
        }
        if (record.clinicalResult) {
          throw conflict(
            'CLINICAL_RESULT_RECORD_IN_USE',
            'El registro ya está vinculado a otro resultado.',
          );
        }
      }

      const last = await tx.clinicalResult.findFirst({
        where: { orderId, tenantId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const plain = { content, issuedBy: cleanText(dto.issuedBy) };
      // Chosen before the row is written so that the hash stored with it covers it.
      const id = randomUUID();
      const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
      const fields = {
        id,
        orderId,
        version: (last?.version ?? 0) + 1,
        enteredById: actor.userId,
        receivedAt,
        studyDate: dto.studyDate ? new Date(dto.studyDate) : null,
        fileId: file?.id ?? null,
        recordId: dto.recordId ?? null,
      };

      const superseded = await tx.clinicalResult.updateMany({
        where: { orderId, tenantId, status: 'PENDING_REVIEW' },
        data: { status: 'SUPERSEDED' },
      });
      const result = await tx.clinicalResult.create({
        data: {
          ...fields,
          tenantId,
          patientId: current.patientId,
          content: plain.content === null ? null : this.crypto.encrypt(tenantId, plain.content),
          issuedBy: plain.issuedBy === null ? null : this.crypto.encrypt(tenantId, plain.issuedBy),
          contentHash: resultContentHash({
            ...fields,
            ...plain,
            fileContentHash: file?.contentHash ?? null,
          }),
        },
      });

      return {
        data: { status: 'PENDING_REVIEW' },
        reason:
          superseded.count > 0
            ? 'Nueva versión del resultado, reemplaza a la pendiente de revisión'
            : 'Resultado recibido',
        extraAudit: [
          {
            action: 'CREATE',
            entity: 'CLINICAL_RESULT',
            entityId: result.id,
            patientId: current.patientId,
            after: snapshotResult({ ...result, ...plain }),
          },
        ],
      };
    });
  }

  /**
   * The review of the last result by a professional: a decision and the conduct, recorded with who
   * and when. A follow-up or a repetition opens a follow-up with a responsible and a date.
   */
  async review(
    tenantId: string,
    resultId: string,
    actor: ClinicalActor,
    dto: ReviewClinicalResultDto,
  ) {
    const needsFollowUp = dto.decision !== 'NO_FURTHER_ACTION';
    if (needsFollowUp && !dto.followUp) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'FOLLOW_UP_REQUIRED',
        message: 'Indica el seguimiento: qué hay que hacer, para cuándo y quién es responsable.',
      });
    }

    const orderId = await this.orderOfResult(tenantId, resultId);
    return this.command(tenantId, orderId, actor, null, 'review', async (tx, current) => {
      const result = await this.currentResult(tx, tenantId, orderId, resultId);
      if (result.status !== 'PENDING_REVIEW') {
        throw conflict('CLINICAL_RESULT_ALREADY_REVIEWED', 'Este resultado ya fue revisado.');
      }
      // Checked before anything is written.
      const assignedToId = dto.followUp?.assignedToId ?? actor.userId;
      if (needsFollowUp) await assertAssignableProfessional(tx, tenantId, assignedToId);

      const reviewNote = dto.note.trim();
      const reviewed = await tx.clinicalResult.update({
        where: { id: resultId },
        data: {
          status: 'REVIEWED',
          reviewedAt: new Date(),
          reviewedById: actor.userId,
          reviewDecision: dto.decision,
          reviewNote: this.crypto.encrypt(tenantId, reviewNote),
          appointmentNeeded: dto.appointmentNeeded ?? false,
        },
      });
      const extraAudit: ClinicalAuditEntry[] = [
        {
          action: 'UPDATE',
          entity: 'CLINICAL_RESULT',
          entityId: resultId,
          patientId: current.patientId,
          before: snapshotResult(this.decryptResultRow(result)),
          after: snapshotResult(this.decryptResultRow({ ...reviewed })),
          reason: 'Revisión del resultado',
        },
      ];

      if (needsFollowUp && dto.followUp) {
        const plain = {
          title: dto.followUp.title.trim(),
          description: cleanText(dto.followUp.description),
          closureNote: null,
        };
        const followUp = await tx.clinicalFollowUp.create({
          data: {
            tenantId,
            patientId: current.patientId,
            orderId,
            resultId,
            assignedToId,
            createdById: actor.userId,
            dueDate: new Date(dto.followUp.dueDate),
            ...this.crypto.encryptFields(tenantId, plain, ENCRYPTED_FOLLOW_UP_FIELDS),
          },
        });
        extraAudit.push({
          action: 'CREATE',
          entity: 'CLINICAL_FOLLOW_UP',
          entityId: followUp.id,
          patientId: current.patientId,
          after: snapshotFollowUp({ ...followUp, ...plain }),
        });
      }

      return { data: { status: 'REVIEWED' }, reason: 'Revisión del resultado', extraAudit };
    });
  }

  /** The patient was told about the reviewed result: how, when and by whom. Once per result. */
  async communicate(
    tenantId: string,
    resultId: string,
    actor: ClinicalActor,
    dto: RecordCommunicationDto,
  ) {
    const orderId = await this.orderOfResult(tenantId, resultId);
    return this.command(tenantId, orderId, actor, null, 'communicate', async (tx, current) => {
      const result = await this.currentResult(tx, tenantId, orderId, resultId);
      if (result.status !== 'REVIEWED' || result.communicatedAt) {
        throw conflict(
          'CLINICAL_RESULT_NOT_COMMUNICABLE',
          'La comunicación se registra una vez por resultado, después de revisarlo.',
        );
      }
      const communicated = await tx.clinicalResult.update({
        where: { id: resultId },
        data: {
          communicatedAt: dto.communicatedAt ? new Date(dto.communicatedAt) : new Date(),
          communicatedById: actor.userId,
          communicationChannel: dto.channel,
          communicationNote: this.encryptOptional(tenantId, dto.note),
        },
      });
      return {
        data: { status: 'PATIENT_CONTACTED' },
        reason: 'Comunicación del resultado al paciente',
        extraAudit: [
          {
            action: 'UPDATE',
            entity: 'CLINICAL_RESULT',
            entityId: resultId,
            patientId: current.patientId,
            before: snapshotResult(this.decryptResultRow(result)),
            after: snapshotResult(this.decryptResultRow(communicated)),
            reason: 'Comunicación del resultado al paciente',
          },
        ],
      };
    });
  }

  /**
   * Closes the order once its last result is reviewed and its follow-ups are closed. Without a
   * recorded contact with the patient, the note explaining why is required.
   */
  async complete(
    tenantId: string,
    orderId: string,
    actor: ClinicalActor,
    dto: CompleteClinicalOrderDto,
  ) {
    return this.command(tenantId, orderId, actor, dto.version, 'complete', async (tx, current) => {
      const note = cleanText(dto.note);
      if (current.status !== 'PATIENT_CONTACTED' && !note) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'CLINICAL_ORDER_COMPLETION_NOTE_REQUIRED',
          message:
            'No hay registro de comunicación con el paciente. Explica por qué se cierra la orden.',
        });
      }
      const open = await tx.clinicalFollowUp.count({
        where: { tenantId, orderId, status: 'OPEN' },
      });
      if (open > 0) {
        throw conflict(
          'CLINICAL_ORDER_FOLLOW_UPS_OPEN',
          'La orden tiene seguimientos abiertos. Ciérralos antes de cerrar la orden.',
        );
      }
      return {
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedById: actor.userId,
          completionNote: note === null ? null : this.crypto.encrypt(tenantId, note),
        },
        reason: 'Cierre de la orden',
      };
    });
  }

  /** Ends an order that got no result: cancelled, or not performed. The reason is required. */
  async cancel(
    tenantId: string,
    orderId: string,
    actor: ClinicalActor,
    dto: CancelClinicalOrderDto,
  ) {
    return this.command(tenantId, orderId, actor, dto.version, 'cancel', async () => ({
      data: {
        status: dto.status,
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        cancellationReason: this.crypto.encrypt(tenantId, dto.reason.trim()),
      },
      reason: dto.reason.trim(),
    }));
  }

  /**
   * Runs one command on an order: takes the row, checks the version the client read (null when
   * the command addresses a result, whose own status guards it) and the status, applies the change
   * returned by `apply`, bumps the version and audits the order and whatever `apply` touched.
   */
  private async command(
    tenantId: string,
    orderId: string,
    actor: ClinicalActor,
    expectedVersion: number | null,
    name: OrderCommand,
    apply: (
      tx: Tx,
      current: ClinicalOrder,
    ) => Promise<{
      data: Prisma.ClinicalOrderUncheckedUpdateInput;
      reason: string;
      extraAudit?: ClinicalAuditEntry[];
    }>,
  ) {
    return this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ClinicalOrder" WHERE "id" = ${orderId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const current = await tx.clinicalOrder.findFirst({ where: { id: orderId, tenantId } });
      if (!current) throw orderNotFound();
      if (expectedVersion !== null && current.version !== expectedVersion) {
        throw clinicalOrderVersionConflict(current.version);
      }
      assertCanRun(name, current.status);

      const { data, reason, extraAudit = [] } = await apply(tx, current);
      const updated = await tx.clinicalOrder.update({
        where: { id: orderId },
        data: { ...data, version: { increment: 1 } },
      });

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'CLINICAL_ORDER',
            entityId: orderId,
            patientId: current.patientId,
            before: snapshotOrder(this.decryptOrderRow(current)),
            after: snapshotOrder(this.decryptOrderRow(updated)),
            reason,
          },
          ...extraAudit,
        ],
        tx,
      );
      return this.view(tx, tenantId, orderId);
    });
  }

  /** The result must be the last version of its order: earlier ones are history. */
  private async currentResult(
    tx: Tx,
    tenantId: string,
    orderId: string,
    resultId: string,
  ): Promise<ClinicalResult> {
    const last = await tx.clinicalResult.findFirst({
      where: { orderId, tenantId },
      orderBy: { version: 'desc' },
    });
    if (!last) throw resultNotFound();
    if (last.id !== resultId) {
      throw conflict(
        'CLINICAL_RESULT_SUPERSEDED',
        'Hay una versión más reciente de este resultado. Revisa la última.',
      );
    }
    return last;
  }

  private async orderOfResult(tenantId: string, resultId: string): Promise<string> {
    const result = await this.prisma.clinicalResult.findFirst({
      where: { id: resultId, tenantId },
      select: { orderId: true },
    });
    if (!result) throw resultNotFound();
    return result.orderId;
  }

  private async view(tx: Tx, tenantId: string, orderId: string) {
    const stored = (await tx.clinicalOrder.findFirst({
      where: { id: orderId, tenantId },
      include: orderInclude,
    })) as StoredOrder;
    return toOrderView(this.crypto, tenantId, stored);
  }

  private encrypt(tenantId: string, plain: Record<string, string | null>) {
    return Object.fromEntries(
      Object.entries(plain).map(([key, value]) => [
        key,
        value === null ? null : this.crypto.encrypt(tenantId, value),
      ]),
    ) as { studyName: string; indication: string | null; provider: string | null };
  }

  private encryptOptional(tenantId: string, value: string | undefined): string | null {
    const text = cleanText(value);
    return text === null ? null : this.crypto.encrypt(tenantId, text);
  }

  private decryptOrderRow(order: ClinicalOrder): ClinicalOrder {
    return this.crypto.decryptFields(order.tenantId, order, ENCRYPTED_ORDER_FIELDS);
  }

  private decryptResultRow(result: ClinicalResult): ClinicalResult {
    return this.crypto.decryptFields(result.tenantId, result, ENCRYPTED_RESULT_FIELDS);
  }

  private async assertPatient(db: PrismaService | Tx, tenantId: string, patientId: string) {
    const patient = await db.patient.findFirst({
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
