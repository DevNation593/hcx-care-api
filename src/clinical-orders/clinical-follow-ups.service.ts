import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicalFollowUp, Prisma } from '@prisma/client';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { clinicalRecordNotFound } from '../clinical-access/clinical-errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertAssignableProfessional,
  cleanText,
  decryptFollowUp,
  decryptResult,
  ENCRYPTED_FOLLOW_UP_FIELDS,
  followUpInclude,
  inboxThresholds,
  personSelect,
  resultInclude,
  snapshotFollowUp,
} from './clinical-order-view';
import {
  CloseClinicalFollowUpDto,
  CreateClinicalFollowUpDto,
  InboxScope,
  ListFollowUpsQueryDto,
  UpdateClinicalFollowUpDto,
} from './dto/clinical-orders.dto';
import {
  addDays,
  AWAITING_RESULT,
  clinicalFollowUpVersionConflict,
  resultDeadline,
} from './order-state';

type Tx = Prisma.TransactionClient;

const followUpNotFound = () => clinicalRecordNotFound('Seguimiento no encontrado');

/** How many items each list of the inbox returns at most, the oldest first. */
const INBOX_LIMIT = 200;

const patientSelect = { id: true, firstName: true, lastName: true } as const;

/** The encrypted fields of an order that the inbox shows. */
const INBOX_ORDER_FIELDS = ['studyName', 'provider', 'externalReference'] as const;

/**
 * Clinical follow-ups and the inbox of pending clinical work. A follow-up is closed only by a
 * professional, with what was done: nothing else (an appointment cancelled, completed or moved)
 * closes it.
 */
@Injectable()
export class ClinicalFollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  /** Follow-ups of one patient, every status, nearest date first. Audited. */
  async listForPatient(tenantId: string, patientId: string, actor: ClinicalActor) {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.clinicalFollowUp.findMany({
      where: { tenantId, patientId },
      include: followUpInclude,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
    await this.auditReads(tenantId, actor, stored);
    return stored.map((followUp) => decryptFollowUp(this.crypto, tenantId, followUp));
  }

  /** Follow-ups of the clinic, or the caller's, by status. Audited. */
  async list(tenantId: string, actor: ClinicalActor, query: ListFollowUpsQueryDto) {
    const stored = await this.prisma.clinicalFollowUp.findMany({
      where: {
        tenantId,
        status: query.status ?? 'OPEN',
        ...(this.scope(query.scope) === 'mine' ? { assignedToId: actor.userId } : {}),
      },
      include: followUpInclude,
      orderBy: { dueDate: 'asc' },
      take: INBOX_LIMIT,
    });
    await this.auditReads(tenantId, actor, stored);
    const now = new Date();
    return stored.map((followUp) => ({
      ...decryptFollowUp(this.crypto, tenantId, followUp),
      overdue: followUp.status === 'OPEN' && followUp.dueDate < now,
    }));
  }

  /** A follow-up that comes from no result: a preventive control, a call, a pending study. */
  async create(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    dto: CreateClinicalFollowUpDto,
  ) {
    await this.assertPatient(tenantId, patientId);
    return this.transaction(async (tx) => {
      const assignedToId = dto.assignedToId ?? actor.userId;
      await assertAssignableProfessional(tx, tenantId, assignedToId);
      const plain = {
        title: dto.title.trim(),
        description: cleanText(dto.description),
        closureNote: null,
      };
      const created = await tx.clinicalFollowUp.create({
        data: {
          tenantId,
          patientId,
          assignedToId,
          createdById: actor.userId,
          dueDate: new Date(dto.dueDate),
          ...this.crypto.encryptFields(tenantId, plain, ENCRYPTED_FOLLOW_UP_FIELDS),
        },
        include: followUpInclude,
      });
      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'CREATE',
            entity: 'CLINICAL_FOLLOW_UP',
            entityId: created.id,
            patientId,
            after: snapshotFollowUp({ ...created, ...plain }),
          },
        ],
        tx,
      );
      return decryptFollowUp(this.crypto, tenantId, created);
    });
  }

  /** Changes the date, the responsible or the wording of an open follow-up. */
  async update(
    tenantId: string,
    followUpId: string,
    actor: ClinicalActor,
    dto: UpdateClinicalFollowUpDto,
  ) {
    return this.change(
      tenantId,
      followUpId,
      actor,
      dto.version,
      'Cambio del seguimiento',
      async (tx) => {
        if (dto.assignedToId) await assertAssignableProfessional(tx, tenantId, dto.assignedToId);
        return {
          ...(dto.title ? { title: this.crypto.encrypt(tenantId, dto.title.trim()) } : {}),
          ...(dto.description !== undefined
            ? {
                description: cleanText(dto.description)
                  ? this.crypto.encrypt(tenantId, cleanText(dto.description)!)
                  : null,
              }
            : {}),
          ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}),
          ...(dto.assignedToId ? { assignedToId: dto.assignedToId } : {}),
        };
      },
    );
  }

  /** Done or cancelled, always with what was done or why it is no longer needed. */
  async close(
    tenantId: string,
    followUpId: string,
    actor: ClinicalActor,
    dto: CloseClinicalFollowUpDto,
  ) {
    const reason = dto.status === 'DONE' ? 'Seguimiento realizado' : 'Seguimiento cancelado';
    return this.change(tenantId, followUpId, actor, dto.version, reason, async () => ({
      status: dto.status,
      closedAt: new Date(),
      closedById: actor.userId,
      closureNote: this.crypto.encrypt(tenantId, dto.note.trim()),
    }));
  }

  /**
   * What waits for a professional: results to review, orders without a result, reviewed results
   * the patient was not told about, and open follow-ups. `mine` narrows the first three to the
   * orders the caller placed and the follow-ups to the ones assigned to them. Each item says
   * whether it passed the clinic's threshold; nothing here is a clinical judgement.
   */
  async inbox(tenantId: string, actor: ClinicalActor, scopeQuery?: InboxScope) {
    const scope = this.scope(scopeQuery);
    const mine = scope === 'mine' ? { orderedById: actor.userId } : {};
    const { resultReviewAlertDays, orderResultAlertDays } = await inboxThresholds(
      this.prisma,
      tenantId,
    );
    const orderSelect = {
      id: true,
      patientId: true,
      orderType: true,
      priority: true,
      studyName: true,
      provider: true,
      externalReference: true,
      status: true,
      orderedAt: true,
      resultDueAt: true,
      sentAt: true,
      version: true,
      orderedBy: { select: personSelect },
      patient: { select: patientSelect },
    } as const;

    const [pendingResults, awaiting, toContact, followUps] = await Promise.all([
      this.prisma.clinicalResult.findMany({
        where: { tenantId, status: 'PENDING_REVIEW', order: mine },
        include: { ...resultInclude, order: { select: orderSelect } },
        orderBy: { receivedAt: 'asc' },
        take: INBOX_LIMIT,
      }),
      this.prisma.clinicalOrder.findMany({
        where: { tenantId, status: { in: [...AWAITING_RESULT] }, ...mine },
        select: orderSelect,
        orderBy: { orderedAt: 'asc' },
        take: INBOX_LIMIT,
      }),
      this.prisma.clinicalOrder.findMany({
        where: { tenantId, status: 'REVIEWED', ...mine },
        select: orderSelect,
        orderBy: { updatedAt: 'asc' },
        take: INBOX_LIMIT,
      }),
      this.prisma.clinicalFollowUp.findMany({
        where: {
          tenantId,
          status: 'OPEN',
          ...(scope === 'mine' ? { assignedToId: actor.userId } : {}),
        },
        include: followUpInclude,
        orderBy: { dueDate: 'asc' },
        take: INBOX_LIMIT,
      }),
    ]);

    const orderIds = new Set([
      ...pendingResults.map(({ orderId }) => orderId),
      ...awaiting.map(({ id }) => id),
      ...toContact.map(({ id }) => id),
    ]);
    const patientOf = new Map<string, string>([
      ...pendingResults.map(({ orderId, patientId }) => [orderId, patientId] as [string, string]),
      ...awaiting.map(({ id, patientId }) => [id, patientId] as [string, string]),
      ...toContact.map(({ id, patientId }) => [id, patientId] as [string, string]),
    ]);
    await this.audit.record(tenantId, actor, [
      ...[...orderIds].map((id) => ({
        action: 'READ' as const,
        entity: 'CLINICAL_ORDER' as const,
        entityId: id,
        patientId: patientOf.get(id)!,
      })),
      ...followUps.map((followUp) => ({
        action: 'READ' as const,
        entity: 'CLINICAL_FOLLOW_UP' as const,
        entityId: followUp.id,
        patientId: followUp.patientId,
      })),
    ]);

    const now = new Date();
    const decryptOrder = <
      T extends { studyName: string; provider: string | null; externalReference: string | null },
    >(
      order: T,
    ): T => this.crypto.decryptFields(tenantId, order, INBOX_ORDER_FIELDS);

    return {
      scope,
      thresholds: { resultReviewAlertDays, orderResultAlertDays },
      pendingReview: pendingResults.map(({ order, ...result }) => ({
        ...decryptResult(this.crypto, tenantId, result),
        order: decryptOrder(order),
        overdue: addDays(result.receivedAt, resultReviewAlertDays) < now,
      })),
      awaitingResult: awaiting.map((order) => ({
        ...decryptOrder(order),
        overdue: resultDeadline(order, orderResultAlertDays) < now,
      })),
      toCommunicate: toContact.map((order) => decryptOrder(order)),
      followUps: followUps.map((followUp) => ({
        ...decryptFollowUp(this.crypto, tenantId, followUp),
        overdue: followUp.dueDate < now,
      })),
    };
  }

  private async change(
    tenantId: string,
    followUpId: string,
    actor: ClinicalActor,
    expectedVersion: number,
    reason: string,
    apply: (tx: Tx) => Promise<Prisma.ClinicalFollowUpUncheckedUpdateInput>,
  ) {
    return this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ClinicalFollowUp" WHERE "id" = ${followUpId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const current = await tx.clinicalFollowUp.findFirst({ where: { id: followUpId, tenantId } });
      if (!current) throw followUpNotFound();
      if (current.version !== expectedVersion) {
        throw clinicalFollowUpVersionConflict(current.version);
      }
      if (current.status !== 'OPEN') {
        throw new ConflictException({
          statusCode: 409,
          code: 'CLINICAL_FOLLOW_UP_CLOSED',
          message: 'El seguimiento ya está cerrado.',
        });
      }
      const data = await apply(tx);
      const updated = await tx.clinicalFollowUp.update({
        where: { id: followUpId },
        data: { ...data, version: { increment: 1 } },
        include: followUpInclude,
      });
      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'UPDATE',
            entity: 'CLINICAL_FOLLOW_UP',
            entityId: followUpId,
            patientId: current.patientId,
            before: snapshotFollowUp(this.decrypt(current)),
            after: snapshotFollowUp(this.decrypt(updated)),
            reason,
          },
        ],
        tx,
      );
      return decryptFollowUp(this.crypto, tenantId, updated);
    });
  }

  private decrypt<T extends ClinicalFollowUp>(followUp: T): T {
    return decryptFollowUp(this.crypto, followUp.tenantId, followUp);
  }

  private scope(scope?: InboxScope): InboxScope {
    return scope ?? 'mine';
  }

  private async auditReads(
    tenantId: string,
    actor: ClinicalActor,
    followUps: { id: string; patientId: string }[],
  ) {
    await this.audit.record(
      tenantId,
      actor,
      followUps.map((followUp) => ({
        action: 'READ' as const,
        entity: 'CLINICAL_FOLLOW_UP' as const,
        entityId: followUp.id,
        patientId: followUp.patientId,
      })),
    );
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
