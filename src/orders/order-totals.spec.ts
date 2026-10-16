import { computeOrderTotals } from './order-totals';

const line = (quantity: string, unitPrice: string, discount: string, taxRatePercent: number) => ({
  quantity,
  unitPrice,
  discount,
  taxRatePercent,
});

describe('computeOrderTotals', () => {
  it('computes a single taxed line', () => {
    const t = computeOrderTotals([line('2', '10.00', '0', 15)]);
    expect(t.subtotal.toFixed(2)).toBe('20.00');
    expect(t.taxTotal.toFixed(2)).toBe('3.00');
    expect(t.total.toFixed(2)).toBe('23.00');
  });

  it('computes tax on the sum per rate and distributes the difference', () => {
    const t = computeOrderTotals([
      line('1', '0.10', '0', 15),
      line('1', '0.10', '0', 15),
      line('1', '0.10', '0', 15),
    ]);
    expect(t.taxTotal.toFixed(2)).toBe('0.05');
    expect(t.lines.map((l) => l.lineTax.toFixed(2))).toEqual(['0.02', '0.02', '0.01']);
    expect(t.total.toFixed(2)).toBe('0.35');
  });

  it('handles discounts and mixed rates with half-up rounding', () => {
    const t = computeOrderTotals([line('2', '10.00', '1.50', 15), line('1', '5.00', '0', 0)]);
    expect(t.subtotal.toFixed(2)).toBe('23.50');
    expect(t.discountTotal.toFixed(2)).toBe('1.50');
    expect(t.taxTotal.toFixed(2)).toBe('2.78');
    expect(t.total.toFixed(2)).toBe('26.28');
  });

  it('rejects a discount greater than the gross amount', () => {
    expect(() => computeOrderTotals([line('1', '5.00', '5.01', 15)])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ORDER_LINE_INVALID' }),
      }),
    );
  });

  it('rejects a zero quantity', () => {
    expect(() => computeOrderTotals([line('0', '5.00', '0', 15)])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ORDER_LINE_INVALID' }),
      }),
    );
  });

  it('returns zeros for an empty list', () => {
    const t = computeOrderTotals([]);
    expect(t.total.toFixed(2)).toBe('0.00');
    expect(t.subtotal.toFixed(2)).toBe('0.00');
    expect(t.discountTotal.toFixed(2)).toBe('0.00');
    expect(t.taxTotal.toFixed(2)).toBe('0.00');
    expect(t.lines).toEqual([]);
  });
});
