import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma, TreatmentSessionStatus } from '@prisma/client';
import { TreatmentRequirements } from '../treatments/treatment-requirements';

export type ClinicalBillingCode =
  | 'FINALIZED_MEDICAL_FORM'
  | 'SIGNED_APPLICABLE_CONSENT'
  | 'CLINICAL_COMPLETION'
  | 'SESSION_NOT_BILLABLE';

export type CashBillingCode =
  | 'BILLING_PROFILE'
  | 'INVOICE_ITEMS'
  | 'BALANCE_DUE'
  | 'INVOICING_NOT_CONFIGURED';

export type BillingCode = ClinicalBillingCode | CashBillingCode;

/** Canonical order of the codes in `missing`. */
export const BILLING_CODE_ORDER: readonly BillingCode[] = [
  'FINALIZED_MEDICAL_FORM',
  'SIGNED_APPLICABLE_CONSENT',
  'CLINICAL_COMPLETION',
  'SESSION_NOT_BILLABLE',
  'BILLING_PROFILE',
  'INVOICE_ITEMS',
  'BALANCE_DUE',
  'INVOICING_NOT_CONFIGURED',
];

/** Largest total a final consumer (idType 07) may be invoiced. */
export const FINAL_CONSUMER_LIMIT = new Prisma.Decimal('50.00');

const FINAL_CONSUMER_ID_TYPE = '07';

const NOT_BILLABLE_STATUSES: readonly TreatmentSessionStatus[] = [
  'CANCELLED',
  'NO_SHOW',
  'CONSENT_REFUSED',
  'CONSENT_REVOKED',
  'BILLING_PENDING',
  'BILLED',
];

export interface SessionBillingFacts {
  itemId: string;
  patientName: string;
  status: TreatmentSessionStatus;
  policy: TreatmentRequirements;
  hasForm: boolean;
  hasApplicableConsent: boolean;
  completed: boolean;
}

export interface OrderBillingFacts {
  sessions: SessionBillingFacts[];
  itemCount: number;
  total: Prisma.Decimal;
  paidTotal: Prisma.Decimal;
  profile: { isActive: boolean; idType: string } | null;
  /** null: not evaluated (B1). */
  invoicingConfigured: boolean | null;
}

export interface BillingEligibility {
  eligible: boolean;
  missing: BillingCode[];
  items: { itemId: string; patientName: string; codes: ClinicalBillingCode[] }[];
}

function sessionCodes(session: SessionBillingFacts): ClinicalBillingCode[] {
  if (NOT_BILLABLE_STATUSES.includes(session.status)) return ['SESSION_NOT_BILLABLE'];
  const codes: ClinicalBillingCode[] = [];
  const { policy } = session;
  if (policy.medicalForm.required && !session.hasForm) codes.push('FINALIZED_MEDICAL_FORM');
  if (policy.informedConsent.required && !session.hasApplicableConsent) {
    codes.push('SIGNED_APPLICABLE_CONSENT');
  }
  if (policy.billingGate.requireClinicalCompletion && !session.completed) {
    codes.push('CLINICAL_COMPLETION');
  }
  return codes;
}

/** Pure RN-10 evaluation: what still stands between an order and its invoice. */
export function evaluateBillingEligibility(facts: OrderBillingFacts): BillingEligibility {
  const found = new Set<BillingCode>();
  const items: BillingEligibility['items'] = [];

  for (const session of facts.sessions) {
    const codes = sessionCodes(session);
    if (codes.length === 0) continue;
    items.push({ itemId: session.itemId, patientName: session.patientName, codes });
    codes.forEach((code) => found.add(code));
  }

  const { profile, total } = facts;
  if (
    !profile ||
    !profile.isActive ||
    (profile.idType === FINAL_CONSUMER_ID_TYPE && total.gt(FINAL_CONSUMER_LIMIT))
  ) {
    found.add('BILLING_PROFILE');
  }
  if (facts.itemCount === 0 || total.isZero()) found.add('INVOICE_ITEMS');
  if (facts.paidTotal.lt(total)) found.add('BALANCE_DUE');
  if (facts.invoicingConfigured === false) found.add('INVOICING_NOT_CONFIGURED');

  const missing = BILLING_CODE_ORDER.filter((code) => found.has(code));
  return { eligible: missing.length === 0, missing, items };
}

const CLINICAL_CODES: readonly BillingCode[] = BILLING_CODE_ORDER.slice(0, 4);

/** The 422 for an order that cannot be invoiced yet; returned, not thrown. */
export function billingBlocked(result: BillingEligibility): UnprocessableEntityException {
  const clinical = result.missing.some((code) => CLINICAL_CODES.includes(code));
  return new UnprocessableEntityException({
    statusCode: 422,
    code: clinical ? 'TREATMENT_DOCUMENTATION_INCOMPLETE' : 'ORDER_NOT_BILLABLE',
    message: clinical
      ? 'La orden incluye atenciones sin la documentación obligatoria.'
      : 'La orden aún no se puede facturar.',
    missing: result.missing,
    items: result.items,
  });
}
