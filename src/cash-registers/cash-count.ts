import { PaymentMethod, Prisma } from '@prisma/client';

export interface CashMovement {
  method: PaymentMethod;
  amount: Prisma.Decimal.Value;
}

export interface CashCount {
  expectedCash: Prisma.Decimal;
  byMethod: Record<PaymentMethod, { received: Prisma.Decimal; refunded: Prisma.Decimal }>;
}

export function computeCashCount(
  openingCash: Prisma.Decimal.Value,
  received: CashMovement[],
  refunded: CashMovement[],
): CashCount {
  const zero = () => new Prisma.Decimal(0);
  const byMethod = Object.fromEntries(
    Object.values(PaymentMethod).map((method) => [method, { received: zero(), refunded: zero() }]),
  ) as CashCount['byMethod'];

  for (const movement of received) {
    const entry = byMethod[movement.method];
    entry.received = entry.received.add(movement.amount);
  }
  for (const movement of refunded) {
    const entry = byMethod[movement.method];
    entry.refunded = entry.refunded.add(movement.amount);
  }

  const cash = byMethod[PaymentMethod.CASH];
  return {
    expectedCash: new Prisma.Decimal(openingCash).add(cash.received).sub(cash.refunded),
    byMethod,
  };
}
