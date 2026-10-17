// Legacy billing columns stay in the database (billing profiles migrate from them) but are
// never part of an HTTP response.
export const LEGACY_BILLING_OMIT = {
  billingName: true,
  billingTaxIdType: true,
  billingTaxId: true,
  billingEmail: true,
  billingAddress: true,
} as const;
