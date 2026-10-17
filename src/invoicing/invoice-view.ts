import { InvoiceRequest, InvoiceRequestEvent } from '@prisma/client';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { invoiceMessage } from './invoice-errors';
export function invoiceView(
  row: InvoiceRequest & {
    events?: InvoiceRequestEvent[];
    order?: { number: number; branchId: string };
  },
  crypto: ClinicalCryptoService,
) {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? null,
    branchId: row.order?.branchId ?? null,
    billingProfileId: row.billingProfileId,
    status: row.status,
    requiresReconciliation: row.requiresReconciliation,
    replacesInvoiceRequestId: row.replacesInvoiceRequestId,
    externalDocumentId: row.externalDocumentId,
    externalState: row.externalState,
    number: row.number,
    accessKey: row.accessKey,
    authorizationNumber: row.authorizationNumber,
    authorizedAt: row.authorizedAt,
    artifacts: { xml: !!row.xmlStorageKey, ride: !!row.rideStorageKey },
    attempts: row.attempts,
    lastError: row.lastErrorEncrypted ? publicError(row, crypto) : null,
    requestedAt: row.requestedAt,
    finishedAt: row.finishedAt,
    ...(row.events
      ? {
          events: row.events.map((e) => ({
            id: e.id,
            type: e.type,
            source: e.source,
            detail: e.detail,
            createdAt: e.createdAt,
          })),
        }
      : {}),
  };
}
export type InvoiceRequestView = ReturnType<typeof invoiceView>;
function publicError(row: InvoiceRequest, crypto: ClinicalCryptoService) {
  const error = JSON.parse(crypto.decrypt(row.tenantId, row.lastErrorEncrypted!));
  return { ...error, message: invoiceMessage(error.code) };
}
