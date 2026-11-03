import { InvoiceRequest, InvoiceRequestStatus, Prisma } from '@prisma/client';
/** Where a signed voucher stands at the SRI; stored in `externalState`. */
export type SriStage = 'SIGNED' | 'RECEIVED' | 'AUTHORIZED' | 'RETURNED' | 'NOT_AUTHORIZED';
export function nextInvoiceStatus(
  current: InvoiceRequestStatus,
  stage: SriStage,
): InvoiceRequestStatus {
  if (current === 'AUTHORIZED' || current === 'REJECTED') return current;
  if (stage === 'AUTHORIZED') return 'AUTHORIZED';
  if (stage === 'RETURNED' || stage === 'NOT_AUTHORIZED') return 'REJECTED';
  return 'PROCESSING';
}
export function retryDelay(attempt: number, after = 0): number {
  return Math.max(Math.min(30000 * 2 ** Math.min(attempt - 1, 20), 1800000), after);
}
function orderSessions(row: InvoiceRequest): Prisma.TreatmentSessionWhereInput {
  return {
    tenantId: row.tenantId,
    completedAt: { not: null },
    orderItems: { some: { orderId: row.orderId, releasedAt: null } },
  };
}
/** The order can be invoiced again: it goes back to PAID and its sessions to BILLING_FAILED. */
export async function releaseOrder(tx: Prisma.TransactionClient, row: InvoiceRequest) {
  await tx.order.update({
    where: { id: row.orderId },
    data: { status: 'PAID', version: { increment: 1 } },
  });
  await tx.treatmentSession.updateMany({
    where: orderSessions(row),
    data: { status: 'BILLING_FAILED', version: { increment: 1 } },
  });
}
export async function billSessions(tx: Prisma.TransactionClient, row: InvoiceRequest) {
  await tx.treatmentSession.updateMany({
    where: orderSessions(row),
    data: { status: 'BILLED', version: { increment: 1 } },
  });
}
