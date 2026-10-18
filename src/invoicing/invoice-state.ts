import { InvoiceRequestStatus } from '@prisma/client';
export function nextInvoiceStatus(
  current: InvoiceRequestStatus,
  external: string,
): InvoiceRequestStatus {
  if (current === 'AUTHORIZED' || current === 'REJECTED') return current;
  if (external === 'AUTHORIZED') return 'AUTHORIZED';
  if (['RETURNED', 'NOT_AUTHORIZED', 'XSD_INVALID'].includes(external)) return 'REJECTED';
  return 'PROCESSING';
}
export function retryDelay(attempt: number, after = 0): number {
  return Math.max(Math.min(30000 * 2 ** Math.min(attempt - 1, 20), 1800000), after);
}
