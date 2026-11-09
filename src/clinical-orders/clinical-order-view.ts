import { BadRequestException } from '@nestjs/common';
import { ClinicalFollowUp, ClinicalOrder, ClinicalResult, Prisma } from '@prisma/client';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { isHealthSpecialty } from '../clinical-modules/clinical-module-registry';

/** Stored encrypted; everything outside this module works with the decrypted values. */
export const ENCRYPTED_ORDER_FIELDS = [
  'studyName',
  'indication',
  'provider',
  'externalReference',
  'sampleNotes',
  'completionNote',
  'cancellationReason',
] as const;
export const ENCRYPTED_RESULT_FIELDS = [
  'issuedBy',
  'content',
  'reviewNote',
  'communicationNote',
] as const;
export const ENCRYPTED_FOLLOW_UP_FIELDS = ['title', 'description', 'closureNote'] as const;

export const personSelect = { id: true, firstName: true, lastName: true } as const;

export const followUpInclude = {
  assignedTo: { select: personSelect },
  createdBy: { select: personSelect },
  patient: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ClinicalFollowUpInclude;

export const resultInclude = {
  enteredBy: { select: personSelect },
  reviewedBy: { select: personSelect },
  file: {
    select: {
      id: true,
      fileName: true,
      category: true,
      mimeType: true,
      sizeBytes: true,
      deletedAt: true,
    },
  },
  record: { select: { id: true, moduleKey: true, recordDate: true } },
} satisfies Prisma.ClinicalResultInclude;

export const orderInclude = {
  orderedBy: { select: personSelect },
  encounter: { select: { id: true, status: true, startedAt: true } },
  results: { include: resultInclude, orderBy: { version: 'asc' } },
  followUps: { include: followUpInclude, orderBy: { dueDate: 'asc' } },
} satisfies Prisma.ClinicalOrderInclude;

export type StoredOrder = Prisma.ClinicalOrderGetPayload<{ include: typeof orderInclude }>;
export type StoredResult = Prisma.ClinicalResultGetPayload<{ include: typeof resultInclude }>;
export type StoredFollowUp = Prisma.ClinicalFollowUpGetPayload<{
  include: typeof followUpInclude;
}>;

export function decryptResult(cipher: ClinicalCipher, tenantId: string, result: StoredResult) {
  const plain = cipher.decryptFields(tenantId, result, ENCRYPTED_RESULT_FIELDS);
  return {
    ...plain,
    file: result.file
      ? { ...result.file, fileName: cipher.decrypt(tenantId, result.file.fileName) }
      : null,
  };
}

export function decryptFollowUp<T extends ClinicalFollowUp>(
  cipher: ClinicalCipher,
  tenantId: string,
  followUp: T,
): T {
  return cipher.decryptFields(tenantId, followUp, ENCRYPTED_FOLLOW_UP_FIELDS);
}

/**
 * The order as the clients see it: decrypted, with its results oldest first and `currentResult`,
 * the last version, which is the one reviewed and communicated.
 */
export function toOrderView(cipher: ClinicalCipher, tenantId: string, stored: StoredOrder) {
  const order = cipher.decryptFields(tenantId, stored, ENCRYPTED_ORDER_FIELDS);
  const results = stored.results.map((result) => decryptResult(cipher, tenantId, result));
  return {
    ...order,
    results,
    currentResult: results.at(-1) ?? null,
    followUps: stored.followUps.map((followUp) => decryptFollowUp(cipher, tenantId, followUp)),
  };
}

/** The clinical state of an order, stored in the audit log with every change. */
export function snapshotOrder(order: ClinicalOrder) {
  return {
    version: order.version,
    patientId: order.patientId,
    orderedById: order.orderedById,
    encounterId: order.encounterId,
    orderType: order.orderType,
    priority: order.priority,
    studyName: order.studyName,
    indication: order.indication,
    provider: order.provider,
    externalReference: order.externalReference,
    status: order.status,
    orderedAt: order.orderedAt,
    resultDueAt: order.resultDueAt,
    sampleCollectedAt: order.sampleCollectedAt,
    sampleNotes: order.sampleNotes,
    sentAt: order.sentAt,
    completedAt: order.completedAt,
    completedById: order.completedById,
    completionNote: order.completionNote,
    cancelledAt: order.cancelledAt,
    cancelledById: order.cancelledById,
    cancellationReason: order.cancellationReason,
    signedAt: order.signedAt,
    contentHash: order.contentHash,
  };
}

export function snapshotResult(result: ClinicalResult) {
  return {
    orderId: result.orderId,
    version: result.version,
    enteredById: result.enteredById,
    receivedAt: result.receivedAt,
    studyDate: result.studyDate,
    issuedBy: result.issuedBy,
    content: result.content,
    fileId: result.fileId,
    recordId: result.recordId,
    contentHash: result.contentHash,
    status: result.status,
    reviewedAt: result.reviewedAt,
    reviewedById: result.reviewedById,
    reviewDecision: result.reviewDecision,
    reviewNote: result.reviewNote,
    appointmentNeeded: result.appointmentNeeded,
    communicatedAt: result.communicatedAt,
    communicatedById: result.communicatedById,
    communicationChannel: result.communicationChannel,
    communicationNote: result.communicationNote,
  };
}

export function snapshotFollowUp(followUp: ClinicalFollowUp) {
  return {
    version: followUp.version,
    patientId: followUp.patientId,
    orderId: followUp.orderId,
    resultId: followUp.resultId,
    title: followUp.title,
    description: followUp.description,
    assignedToId: followUp.assignedToId,
    createdById: followUp.createdById,
    dueDate: followUp.dueDate,
    status: followUp.status,
    closedAt: followUp.closedAt,
    closedById: followUp.closedById,
    closureNote: followUp.closureNote,
  };
}

/** Trims a free text and turns an empty one into null. */
export const cleanText = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

type Db = Prisma.TransactionClient;

/**
 * A follow-up is assigned to a professional of the clinic who can open it: an active profile of a
 * health specialty, as the routes of the clinical inbox require (not Estética).
 */
export async function assertAssignableProfessional(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<void> {
  const profile = await db.professionalProfile.findFirst({
    where: { userId, isActive: true, user: { tenantId, isActive: true } },
    select: { userId: true, specialty: { select: { code: true } } },
  });
  if (!profile || !isHealthSpecialty(profile.specialty?.code)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'FOLLOW_UP_ASSIGNEE_INVALID',
      message: 'El responsable debe ser un profesional activo del consultorio.',
    });
  }
}

/** The thresholds of the clinical inbox; the defaults of the schema when the clinic has no row. */
export async function inboxThresholds(db: Pick<Db, 'tenantSettings'>, tenantId: string) {
  const settings = await db.tenantSettings.findUnique({
    where: { tenantId },
    select: { resultReviewAlertDays: true, orderResultAlertDays: true },
  });
  return {
    resultReviewAlertDays: settings?.resultReviewAlertDays ?? 3,
    orderResultAlertDays: settings?.orderResultAlertDays ?? 15,
  };
}
