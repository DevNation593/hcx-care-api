import { Prisma } from '@prisma/client';
import { DEFAULT_REQUIREMENTS, TreatmentRequirements } from '../treatments/treatment-requirements';
import {
  BILLING_CODE_ORDER,
  FINAL_CONSUMER_LIMIT,
  OrderBillingFacts,
  SessionBillingFacts,
  billingBlocked,
  evaluateBillingEligibility,
} from './billing-eligibility';

const D = (value: string) => new Prisma.Decimal(value);

const strictPolicy: TreatmentRequirements = {
  ...DEFAULT_REQUIREMENTS,
  medicalForm: { required: true },
  informedConsent: { required: true, validityDays: null },
};

const session = (overrides: Partial<SessionBillingFacts> = {}): SessionBillingFacts => ({
  itemId: 'item-1',
  patientName: 'Ana Pérez',
  status: 'CLINICAL_COMPLETE',
  policy: strictPolicy,
  hasForm: true,
  hasApplicableConsent: true,
  completed: true,
  ...overrides,
});

const facts = (overrides: Partial<OrderBillingFacts> = {}): OrderBillingFacts => ({
  sessions: [session()],
  itemCount: 1,
  total: D('100.00'),
  paidTotal: D('100.00'),
  profile: { isActive: true, idType: '05' },
  invoicingConfigured: null,
  ...overrides,
});

describe('evaluateBillingEligibility', () => {
  it('is eligible when everything is fulfilled', () => {
    expect(evaluateBillingEligibility(facts())).toEqual({ eligible: true, missing: [], items: [] });
  });

  it('reports a missing medical form', () => {
    const result = evaluateBillingEligibility(facts({ sessions: [session({ hasForm: false })] }));
    expect(result.missing).toEqual(['FINALIZED_MEDICAL_FORM']);
    expect(result.eligible).toBe(false);
  });

  it('reports a missing signed consent', () => {
    const result = evaluateBillingEligibility(
      facts({ sessions: [session({ hasApplicableConsent: false })] }),
    );
    expect(result.missing).toEqual(['SIGNED_APPLICABLE_CONSENT']);
  });

  it('reports a session that is not clinically complete', () => {
    const result = evaluateBillingEligibility(
      facts({ sessions: [session({ status: 'IN_PROGRESS', completed: false })] }),
    );
    expect(result.missing).toEqual(['CLINICAL_COMPLETION']);
  });

  it('skips clinical completion when the treatment does not require it', () => {
    const policy = { ...strictPolicy, billingGate: { requireClinicalCompletion: false } };
    const result = evaluateBillingEligibility(
      facts({ sessions: [session({ policy, completed: false })] }),
    );
    expect(result).toEqual({ eligible: true, missing: [], items: [] });
  });

  it('lists the missing documentation per item', () => {
    const result = evaluateBillingEligibility(
      facts({
        sessions: [
          session({ itemId: 'item-1', patientName: 'Ana', hasForm: false }),
          session({ itemId: 'item-2', patientName: 'Luis', hasApplicableConsent: false }),
          session({ itemId: 'item-3', patientName: 'Eva' }),
        ],
      }),
    );
    expect(result.missing).toEqual(['FINALIZED_MEDICAL_FORM', 'SIGNED_APPLICABLE_CONSENT']);
    expect(result.items).toEqual([
      { itemId: 'item-1', patientName: 'Ana', codes: ['FINALIZED_MEDICAL_FORM'] },
      { itemId: 'item-2', patientName: 'Luis', codes: ['SIGNED_APPLICABLE_CONSENT'] },
    ]);
  });

  it.each([
    'CANCELLED',
    'NO_SHOW',
    'CONSENT_REFUSED',
    'CONSENT_REVOKED',
    'BILLING_PENDING',
    'BILLED',
  ] as const)('reports only SESSION_NOT_BILLABLE for a %s session', (status) => {
    const result = evaluateBillingEligibility(
      facts({ sessions: [session({ status, hasForm: false, completed: false })] }),
    );
    expect(result.missing).toEqual(['SESSION_NOT_BILLABLE']);
    expect(result.items[0].codes).toEqual(['SESSION_NOT_BILLABLE']);
  });

  it('keeps a BILLING_FAILED session eligible', () => {
    const result = evaluateBillingEligibility(
      facts({ sessions: [session({ status: 'BILLING_FAILED' })] }),
    );
    expect(result.eligible).toBe(true);
  });

  it('requires an active billing profile', () => {
    expect(evaluateBillingEligibility(facts({ profile: null })).missing).toEqual([
      'BILLING_PROFILE',
    ]);
    expect(
      evaluateBillingEligibility(facts({ profile: { isActive: false, idType: '05' } })).missing,
    ).toEqual(['BILLING_PROFILE']);
  });

  it('limits a final consumer profile to 50.00', () => {
    const consumer = { isActive: true, idType: '07' };
    expect(FINAL_CONSUMER_LIMIT.equals(D('50.00'))).toBe(true);
    expect(
      evaluateBillingEligibility(
        facts({ profile: consumer, total: D('50.00'), paidTotal: D('50.00') }),
      ).eligible,
    ).toBe(true);
    expect(
      evaluateBillingEligibility(
        facts({ profile: consumer, total: D('50.01'), paidTotal: D('50.01') }),
      ).missing,
    ).toEqual(['BILLING_PROFILE']);
  });

  it('requires items with a total', () => {
    expect(evaluateBillingEligibility(facts({ itemCount: 0, sessions: [] })).missing).toContain(
      'INVOICE_ITEMS',
    );
    expect(
      evaluateBillingEligibility(facts({ total: D('0.00'), paidTotal: D('0.00') })).missing,
    ).toEqual(['INVOICE_ITEMS']);
  });

  it('requires the order to be fully paid', () => {
    expect(evaluateBillingEligibility(facts({ paidTotal: D('99.99') })).missing).toEqual([
      'BALANCE_DUE',
    ]);
  });

  it('never reports INVOICING_NOT_CONFIGURED when it was not evaluated', () => {
    expect(evaluateBillingEligibility(facts({ invoicingConfigured: null })).missing).toEqual([]);
    expect(evaluateBillingEligibility(facts({ invoicingConfigured: true })).missing).toEqual([]);
    expect(evaluateBillingEligibility(facts({ invoicingConfigured: false })).missing).toEqual([
      'INVOICING_NOT_CONFIGURED',
    ]);
  });

  it('orders the codes canonically', () => {
    const result = evaluateBillingEligibility(
      facts({
        profile: null,
        paidTotal: D('0.00'),
        invoicingConfigured: false,
        sessions: [session({ hasForm: false, completed: false })],
      }),
    );
    expect(result.missing).toEqual(
      BILLING_CODE_ORDER.filter((code) => result.missing.includes(code)),
    );
    expect(result.missing).toEqual([
      'FINALIZED_MEDICAL_FORM',
      'CLINICAL_COMPLETION',
      'BILLING_PROFILE',
      'BALANCE_DUE',
      'INVOICING_NOT_CONFIGURED',
    ]);
  });
});

describe('billingBlocked', () => {
  const body = (e: { getResponse(): unknown }) => e.getResponse() as Record<string, unknown>;

  it('picks TREATMENT_DOCUMENTATION_INCOMPLETE when a clinical code is missing', () => {
    const result = evaluateBillingEligibility(
      facts({
        paidTotal: D('0.00'),
        sessions: [session({ completed: false })],
      }),
    );
    const error = billingBlocked(result);
    expect(error.getStatus()).toBe(422);
    expect(body(error)).toEqual({
      statusCode: 422,
      code: 'TREATMENT_DOCUMENTATION_INCOMPLETE',
      message: 'La orden incluye atenciones sin la documentación obligatoria.',
      missing: ['CLINICAL_COMPLETION', 'BALANCE_DUE'],
      items: [{ itemId: 'item-1', patientName: 'Ana Pérez', codes: ['CLINICAL_COMPLETION'] }],
    });
  });

  it('picks ORDER_NOT_BILLABLE otherwise', () => {
    const error = billingBlocked(evaluateBillingEligibility(facts({ paidTotal: D('0.00') })));
    expect(body(error)).toEqual({
      statusCode: 422,
      code: 'ORDER_NOT_BILLABLE',
      message: 'La orden aún no se puede facturar.',
      missing: ['BALANCE_DUE'],
      items: [],
    });
  });
});
