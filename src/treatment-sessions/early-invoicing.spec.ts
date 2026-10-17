import { statusAfterClinicalCompletion } from './session-state';
describe('early invoicing clinical completion', () => {
  it('completes authorized care as BILLED and pending care as BILLING_PENDING', () => {
    expect(statusAfterClinicalCompletion('AUTHORIZED')).toBe('BILLED');
    expect(statusAfterClinicalCompletion('PROCESSING')).toBe('BILLING_PENDING');
    expect(statusAfterClinicalCompletion(undefined)).toBe('CLINICAL_COMPLETE');
  });
});
