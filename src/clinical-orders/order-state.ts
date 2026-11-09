import { ConflictException } from '@nestjs/common';
import { ClinicalOrderStatus } from '@prisma/client';

/** The steps of the study itself, before any result arrives. */
export const AWAITING_RESULT: readonly ClinicalOrderStatus[] = [
  'ORDERED',
  'SAMPLE_COLLECTED',
  'SENT_TO_LAB',
];

/** Orders that take no more commands. */
export const CLOSED_ORDER_STATUSES: readonly ClinicalOrderStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NOT_PERFORMED',
];

export type OrderCommand =
  | 'collectSample'
  | 'sendToLab'
  | 'addResult'
  | 'review'
  | 'communicate'
  | 'complete'
  | 'cancel';

/**
 * From which statuses each command is accepted. A result can arrive at any open step, also as a
 * new version after a review. Completing needs a reviewed result: an order never goes from a
 * received result to closed without a recorded decision. Cancelling is only for an order that
 * got no result; one with a result is reviewed and completed instead.
 */
const ALLOWED_FROM: Record<OrderCommand, readonly ClinicalOrderStatus[]> = {
  collectSample: ['ORDERED'],
  sendToLab: ['ORDERED', 'SAMPLE_COLLECTED'],
  addResult: [...AWAITING_RESULT, 'PENDING_REVIEW', 'REVIEWED', 'PATIENT_CONTACTED'],
  review: ['PENDING_REVIEW'],
  communicate: ['REVIEWED'],
  complete: ['REVIEWED', 'PATIENT_CONTACTED'],
  cancel: AWAITING_RESULT,
};

const MESSAGES: Record<OrderCommand, string> = {
  collectSample: 'La toma de muestra solo se registra en una orden recién creada.',
  sendToLab: 'El envío al laboratorio solo se registra antes de recibir un resultado.',
  addResult: 'La orden está cerrada: no admite resultados.',
  review: 'No hay un resultado pendiente de revisión en esta orden.',
  communicate: 'La comunicación se registra una vez por resultado, después de revisarlo.',
  complete:
    'La orden solo se cierra con su último resultado revisado. Si no tuvo resultado, anúlala o márcala como no realizada.',
  cancel: 'La orden ya tiene un resultado: revísalo y ciérrala en lugar de anularla.',
};

export function canRun(command: OrderCommand, status: ClinicalOrderStatus): boolean {
  return ALLOWED_FROM[command].includes(status);
}

/** Throws 409 CLINICAL_ORDER_INVALID_STATE when the command does not apply to the status. */
export function assertCanRun(command: OrderCommand, status: ClinicalOrderStatus): void {
  if (!canRun(command, status)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'CLINICAL_ORDER_INVALID_STATE',
      message: MESSAGES[command],
      status,
    });
  }
}

export const clinicalOrderVersionConflict = (currentVersion: number) =>
  new ConflictException({
    statusCode: 409,
    code: 'CLINICAL_ORDER_VERSION_CONFLICT',
    message: 'Alguien más actualizó esta orden. Vuelve a cargarla antes de continuar.',
    currentVersion,
  });

export const clinicalFollowUpVersionConflict = (currentVersion: number) =>
  new ConflictException({
    statusCode: 409,
    code: 'CLINICAL_FOLLOW_UP_VERSION_CONFLICT',
    message: 'Alguien más actualizó este seguimiento. Vuelve a cargarlo antes de continuar.',
    currentVersion,
  });

const DAY_MS = 24 * 60 * 60 * 1000;

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** When an order without a result shows as overdue: its own date, or the clinic's threshold. */
export function resultDeadline(
  order: { orderedAt: Date; resultDueAt: Date | null },
  orderResultAlertDays: number,
): Date {
  return order.resultDueAt ?? addDays(order.orderedAt, orderResultAlertDays);
}
