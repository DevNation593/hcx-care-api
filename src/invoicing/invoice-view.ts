import { InvoiceRequest, InvoiceRequestEvent } from '@prisma/client';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { invoiceMessage } from './invoice-errors';
export function invoiceView(
  row: InvoiceRequest & {
    events?: InvoiceRequestEvent[];
    order?: { number: number; branchId: string };
  },
  crypto: ClinicalCryptoService,
  options: { includeError?: boolean } = {},
) {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? null,
    branchId: row.order?.branchId ?? null,
    billingProfileId: row.billingProfileId,
    status: row.status,
    replacesInvoiceRequestId: row.replacesInvoiceRequestId,
    externalState: row.externalState,
    number: row.number,
    sequential: row.sequential,
    accessKey: row.accessKey,
    authorizationNumber: row.authorizationNumber,
    authorizedAt: row.authorizedAt,
    artifacts: { xml: !!row.xmlStorageKey, ride: !!row.rideStorageKey },
    emailedAt: row.emailedAt,
    attempts: row.attempts,
    lastError:
      options.includeError !== false && row.lastErrorEncrypted ? publicError(row, crypto) : null,
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
