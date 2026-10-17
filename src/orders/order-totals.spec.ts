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

  it('never yields a negative lineTax (largest remainder)', () => {
    const t = computeOrderTotals(Array.from({ length: 10 }, () => line('1', '0.10', '0', 15)));
    expect(t.taxTotal.toFixed(2)).toBe('0.15');
    const taxes = t.lines.map((l) => l.lineTax.toFixed(2));
    expect(taxes).toEqual([...Array(5).fill('0.02'), ...Array(5).fill('0.01')]);
    expect(t.lines.every((l) => l.lineTax.gte(0))).toBe(true);
    expect(t.lines.reduce((a, l) => a.add(l.lineTax), t.taxTotal.mul(0)).toFixed(2)).toBe('0.15');
  });

  it('computes each rate separately', () => {
    const t = computeOrderTotals([
      line('1', '10.00', '0', 15),
      line('1', '10.00', '0', 5),
      line('1', '0.10', '0', 15),
    ]);
    // 15%: 10.10 * 0.15 = 1.515 -> 1.52 ; 5%: 0.50
    expect(t.taxTotal.toFixed(2)).toBe('2.02');
    expect(t.lines.map((l) => l.lineTax.toFixed(2))).toEqual(['1.50', '0.50', '0.02']);
  });

  it('rejects a negative unit price', () => {
    expect(() => computeOrderTotals([line('1', '-1.00', '0', 15)])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ORDER_LINE_INVALID' }),
      }),
    );
  });

  it('rejects a negative discount', () => {
    expect(() => computeOrderTotals([line('1', '5.00', '-0.50', 15)])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ORDER_LINE_INVALID' }),
      }),
    );
  });

  it('accepts a discount equal to the gross amount', () => {
    const t = computeOrderTotals([line('2', '5.00', '10.00', 15)]);
    expect(t.lines[0].lineSubtotal.toFixed(2)).toBe('0.00');
    expect(t.total.toFixed(2)).toBe('0.00');
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
