import { PaymentMethod } from '@prisma/client';
import { computeCashCount } from './cash-count';

describe('computeCashCount', () => {
  it('computes expected cash and per-method totals', () => {
    const count = computeCashCount(
      '20.00',
      [
        { method: PaymentMethod.CASH, amount: '15.00' },
        { method: PaymentMethod.CASH, amount: '5.00' },
        { method: PaymentMethod.CREDIT_CARD, amount: '30.00' },
      ],
      [{ method: PaymentMethod.CASH, amount: '5.00' }],
    );
    expect(count.expectedCash.toFixed(2)).toBe('35.00');
    expect(count.byMethod.CASH.received.toFixed(2)).toBe('20.00');
    expect(count.byMethod.CASH.refunded.toFixed(2)).toBe('5.00');
    expect(count.byMethod.CREDIT_CARD.received.toFixed(2)).toBe('30.00');
    expect(count.byMethod.TRANSFER.received.toFixed(2)).toBe('0.00');
    expect(count.byMethod.TRANSFER.refunded.toFixed(2)).toBe('0.00');
    expect(Object.keys(count.byMethod).sort()).toEqual(Object.values(PaymentMethod).sort());
  });
});
