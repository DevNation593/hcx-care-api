import { invoiceError } from './invoice-errors';
describe('controlled fiscal error messages', () => {
  it('gives a useful Spanish correction without revealing upstream content', () => {
    expect(invoiceError('CUSTOMER_SYNC_REQUIRED', 422).getResponse()).toMatchObject({
      code: 'CUSTOMER_SYNC_REQUIRED',
      message: expect.stringContaining('emite-facil'),
    });
  });
  it('uses a controlled fallback for an unknown provider code', () => {
    expect(invoiceError('NEW_PROVIDER_CODE', 503).getResponse()).toMatchObject({
      code: 'NEW_PROVIDER_CODE',
      message: 'No se pudo completar la operación de facturación. Intenta nuevamente.',
    });
  });
});
