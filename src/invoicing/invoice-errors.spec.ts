import { invoiceError, invoiceMessage } from './invoice-errors';
describe('controlled fiscal error messages', () => {
  it('gives a useful Spanish correction without revealing upstream content', () => {
    expect(invoiceError('SRI_REJECTED', 422).getResponse()).toMatchObject({
      code: 'SRI_REJECTED',
      message: expect.stringContaining('corrige los datos y solicita un reemplazo'),
    });
  });
  it.each([
    'INVOICING_API_KEY_REQUIRED',
    'INVOICE_RECONCILIATION_REQUIRED',
    'CUSTOMER_SYNC_REQUIRED',
    'SIGNATURE_FAILED',
    'UNAUTHENTICATED',
    'TRANSPORT_ERROR',
  ])('no longer has a message for the former provider code %s', (code) => {
    expect(invoiceMessage(code)).toBe(
      'No se pudo completar la operación de facturación. Intenta nuevamente.',
    );
  });
  it('uses a controlled fallback for an unknown provider code', () => {
    expect(invoiceError('NEW_PROVIDER_CODE', 503).getResponse()).toMatchObject({
      code: 'NEW_PROVIDER_CODE',
      message: 'No se pudo completar la operación de facturación. Intenta nuevamente.',
    });
  });
});
