import { Prisma, PaymentMethod } from '@prisma/client';
import { invoiceError } from './invoice-errors';
import {
  CustomerProfile,
  DocumentLineInput,
  InvoiceDocument,
  IssuerSnapshot,
  Payment,
  SriEnvironment,
} from './sri/sri-types';
/** Fiscal data frozen when the invoice is requested; the XML is built only from it. */
export interface FiscalSnapshot {
  customer: CustomerProfile;
  issuerId: string;
  issuer: IssuerSnapshot;
  environment: SriEnvironment;
  establishmentCode: string;
  emissionPointCode: string;
  establishmentAddress: string;
  /** YYYY-MM-DD in Ecuador (UTC-5). */
  issueDate: string;
  lines: DocumentLineInput[];
  payments: Payment[];
}
export function toInvoiceDocument(
  s: FiscalSnapshot,
  sequential: number,
  accessKey: string,
): InvoiceDocument {
  return {
    environment: s.environment,
    issuer: s.issuer,
    establishmentCode: s.establishmentCode,
    emissionPointCode: s.emissionPointCode,
    establishmentAddress: s.establishmentAddress,
    sequential,
    accessKey,
    issueDate: s.issueDate,
    customer: s.customer,
    lines: s.lines,
    payments: s.payments,
  };
}
export function groupedPayments(
  payments: { method: PaymentMethod; amount: Prisma.Decimal | string }[],
  total: Prisma.Decimal | string,
): Payment[] {
  const codes: Record<PaymentMethod, string> = {
    CASH: '01',
    DEBIT_CARD: '16',
    CREDIT_CARD: '19',
    TRANSFER: '20',
    OTHER: '20',
  };
  const groups = new Map<string, Prisma.Decimal>();
  for (const p of payments) {
    const code = codes[p.method];
    if (!code || new Prisma.Decimal(p.amount).lte(0))
      throw invoiceError('PAYMENT_TOTAL_MISMATCH', 422);
    groups.set(code, (groups.get(code) ?? new Prisma.Decimal(0)).plus(p.amount));
  }
  if (![...groups.values()].reduce((a, b) => a.plus(b), new Prisma.Decimal(0)).equals(total))
    throw invoiceError('PAYMENT_TOTAL_MISMATCH', 422);
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([methodCode, amount]) => ({ methodCode, amount: amount.toFixed(2) }));
}
