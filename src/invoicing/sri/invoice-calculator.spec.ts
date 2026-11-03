import { calculateInvoice } from './invoice-calculator';
import { ivaRateCode } from './tax-catalog';
import { DocumentLineInput } from './sri-types';

const lines: DocumentLineInput[] = [
  {
    localId: 'a',
    code: 'PSI-01',
    name: 'Sesión de psicoterapia',
    quantity: '1.000000',
    unitPrice: '40.00',
    discount: '0.00',
    taxRatePercent: '0.00',
  },
  {
    localId: 'b',
    code: 'PRD-7',
    name: 'Cuaderno <A5>',
    quantity: '2.000000',
    unitPrice: '3.50',
    discount: '0.50',
    taxRatePercent: '15.00',
  },
];

describe('calculateInvoice', () => {
  it('rounds each line and taxes per rate like InvoiceCalculator.java', () => {
    expect(calculateInvoice(lines)).toEqual({
      lines: [
        { subtotal: '40.00', taxAmount: '0.00', rateCode: '0', rate: '0.00' },
        { subtotal: '6.50', taxAmount: '0.98', rateCode: '4', rate: '15.00' },
      ],
      subtotal: '46.50',
      totalDiscount: '0.50',
      taxes: [
        { rateCode: '0', rate: '0.00', base: '40.00', amount: '0.00' },
        { rateCode: '4', rate: '15.00', base: '6.50', amount: '0.98' },
      ],
      totalTax: '0.98',
      total: '47.48',
    });
  });

  it('taxes the rate base, not the sum of rounded line taxes', () => {
    // three lines of 0.10 at 15 %: each line 0.02 (0.015 -> 0.02), base 0.30 -> IVA 0.05 (0.045 -> 0.05)
    const t = calculateInvoice(
      [1, 2, 3].map((i) => ({
        ...lines[1],
        localId: String(i),
        quantity: '1',
        unitPrice: '0.10',
        discount: '0.00',
      })),
    );
    expect(t.lines.map((l) => l.taxAmount)).toEqual(['0.02', '0.02', '0.02']);
    expect(t.taxes).toEqual([{ rateCode: '4', rate: '15.00', base: '0.30', amount: '0.05' }]);
  });

  it('sorts taxes by numeric rate code', () => {
    const t = calculateInvoice([
      { ...lines[1], localId: 'x', discount: '0.00' },
      { ...lines[0], localId: 'y', taxRatePercent: '12.00' },
      { ...lines[0], localId: 'z' },
    ]);
    expect(t.taxes.map((x) => x.rateCode)).toEqual(['0', '2', '4']);
  });

  it.each([
    ['quantity', { quantity: '0' }],
    ['negative price', { unitPrice: '-1' }],
    ['negative discount', { discount: '-0.01' }],
    ['discount above gross', { discount: '7.01' }],
  ])('rejects invalid line: %s', (_name, patch) => {
    expect(() => calculateInvoice([{ ...lines[1], ...patch }])).toThrow(
      expect.objectContaining({ kind: 'data', code: 'INVOICE_LINE_INVALID' }),
    );
  });

  it('rejects an empty invoice', () => {
    expect(() => calculateInvoice([])).toThrow(
      expect.objectContaining({ kind: 'data', code: 'INVOICE_LINE_INVALID' }),
    );
  });
});

describe('ivaRateCode', () => {
  it('maps SRI IVA rate codes', () => {
    expect(['0', '5', '12', '13', '14', '15'].map((p) => ivaRateCode(p + '.00'))).toEqual([
      '0',
      '5',
      '2',
      '10',
      '3',
      '4',
    ]);
    expect(() => ivaRateCode('7.00')).toThrow(
      expect.objectContaining({ kind: 'data', code: 'TAX_RATE_UNSUPPORTED' }),
    );
  });
});
