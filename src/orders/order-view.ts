import {
  BillingProfileKind,
  OrderItemKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

export interface OrderView {
  id: string;
  number: number;
  status: OrderStatus;
  branchId: string;
  version: number;
  billingProfile: {
    id: string;
    kind: BillingProfileKind;
    idType: string;
    idNumber: string;
    legalName: string;
    email: string | null;
  } | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  balance: string;
  items: {
    id: string;
    kind: OrderItemKind;
    treatmentSessionId: string | null;
    patient: { id: string; firstName: string; lastName: string } | null;
    description: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    taxRatePercent: string;
    lineSubtotal: string;
    lineTax: string;
  }[];
  payments: {
    id: string;
    method: PaymentMethod;
    amount: string;
    reference: string | null;
    status: PaymentStatus;
    receivedAt: string;
    receivedBy: { id: string; firstName: string; lastName: string };
    refundedAt: string | null;
    refundReason: string | null;
  }[];
  createdAt: string;
}

const personSelect = { select: { id: true, firstName: true, lastName: true } } as const;

export const orderInclude = {
  items: { orderBy: { createdAt: 'asc' }, include: { patient: personSelect } },
  payments: { orderBy: { receivedAt: 'asc' }, include: { receivedBy: personSelect } },
  billingProfile: true,
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

const money = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value).toFixed(2);

/** The only shape the API returns for an order. */
export function toOrderView(order: OrderWithRelations): OrderView {
  const profile = order.billingProfile;
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    branchId: order.branchId,
    version: order.version,
    billingProfile: profile
      ? {
          id: profile.id,
          kind: profile.kind,
          idType: profile.idType,
          idNumber: profile.idNumber,
          legalName: profile.legalName,
          email: profile.email,
        }
      : null,
    subtotal: money(order.subtotal),
    discountTotal: money(order.discountTotal),
    taxTotal: money(order.taxTotal),
    total: money(order.total),
    paidTotal: money(order.paidTotal),
    balance: money(new Prisma.Decimal(order.total).sub(order.paidTotal)),
    items: order.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      treatmentSessionId: item.treatmentSessionId,
      patient: item.patient
        ? {
            id: item.patient.id,
            firstName: item.patient.firstName,
            lastName: item.patient.lastName,
          }
        : null,
      description: item.description,
      quantity: new Prisma.Decimal(item.quantity).toString(),
      unitPrice: money(item.unitPrice),
      discount: money(item.discount),
      taxRatePercent: money(item.taxRatePercent),
      lineSubtotal: money(item.lineSubtotal),
      lineTax: money(item.lineTax),
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amount: money(payment.amount),
      reference: payment.reference,
      status: payment.status,
      receivedAt: payment.receivedAt.toISOString(),
      receivedBy: {
        id: payment.receivedBy.id,
        firstName: payment.receivedBy.firstName,
        lastName: payment.receivedBy.lastName,
      },
      refundedAt: payment.refundedAt ? payment.refundedAt.toISOString() : null,
      refundReason: payment.refundReason,
    })),
    createdAt: order.createdAt.toISOString(),
  };
}
