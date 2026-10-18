import { groupedPayments } from './invoice-snapshot';
import { nextInvoiceStatus, retryDelay } from './invoice-state';

describe('durable invoice rules', () => {
  it('groups exact decimal payments using SRI codes', () => {
    expect(
      groupedPayments(
        [
          { method: 'TRANSFER', amount: '0.10' },
          { method: 'OTHER', amount: '0.20' },
          { method: 'CASH', amount: '1.00' },
        ] as any,
        '1.30',
      ),
    ).toEqual([
      { methodCode: '01', amount: '1.00' },
      { methodCode: '20', amount: '0.30' },
    ]);
  });
  it('refuses a payment total different from the invoice', () => {
    expect(() => groupedPayments([{ method: 'CASH', amount: '1.00' }] as any, '1.01')).toThrow();
  });
  it('keeps unknown provider states processing and final states monotonic', () => {
    expect(nextInvoiceStatus('PROCESSING', 'FUTURE_STATE')).toBe('PROCESSING');
    expect(nextInvoiceStatus('PROCESSING', 'SIGNATURE_FAILED')).toBe('PROCESSING');
    expect(nextInvoiceStatus('AUTHORIZED', 'RETURNED')).toBe('AUTHORIZED');
    expect(nextInvoiceStatus('REJECTED', 'AUTHORIZED')).toBe('REJECTED');
    expect(nextInvoiceStatus('PROCESSING', 'AUTHORIZED')).toBe('AUTHORIZED');
  });
  it('backs off with a 30 minute exponential cap and honors Retry-After', () => {
    expect(retryDelay(1)).toBe(30000);
    expect(retryDelay(20)).toBe(1800000);
    expect(retryDelay(1, 60000)).toBe(60000);
  });
});
