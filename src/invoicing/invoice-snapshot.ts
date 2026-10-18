import { Prisma, PaymentMethod } from '@prisma/client';
import { CustomerProfile, Payment } from './provider/invoicing-provider';
import { invoiceError } from './invoice-errors';
export interface FiscalSnapshot {
  customer: CustomerProfile;
  taxpayerId: string;
  environment: string;
  establishmentCode: string;
  emissionPointCode: string;
  issueDate: string;
  replacesDocumentId?: string;
  lines: {
    localId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    taxRatePercent: string;
  }[];
  payments: Payment[];
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
