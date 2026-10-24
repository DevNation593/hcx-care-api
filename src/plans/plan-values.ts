import { Plan, Prisma } from '@prisma/client';
import { isHealthSpecialty } from '../clinical-modules/clinical-module-registry';
import { SECTION_CATALOG, SectionKey } from '../common/sections/section-catalog';

/**
 * Subscription columns that follow the plan, and the plan column each one copies. A column the
 * platform set for one clinic (TenantSubscription.overriddenFields) keeps its own value.
 */
export const PLAN_VALUE_FIELDS = {
  basePrice: 'basePrice',
  pricePerSeat: 'pricePerSeat',
  specialtyPrice: 'specialtyPrice',
  currency: 'currency',
  seatsPsychologistsMax: 'seatsIncluded',
  maxActivePatients: 'maxActivePatients',
  storageGB: 'storageGB',
  monthlyElectronicInvoicesLimit: 'monthlyElectronicInvoicesLimit',
  includedSpecialties: 'includedSpecialties',
} as const satisfies Record<string, keyof Plan>;

export type PlanValueField = keyof typeof PLAN_VALUE_FIELDS;
export const PLAN_VALUE_FIELD_NAMES = Object.keys(PLAN_VALUE_FIELDS) as PlanValueField[];

export function isPlanValueField(value: string): value is PlanValueField {
  return value in PLAN_VALUE_FIELDS;
}

type PlanValues = Pick<Plan, (typeof PLAN_VALUE_FIELDS)[PlanValueField]>;

/** Subscription columns with the types of the plan columns they copy. */
export type PlanValueData = {
  [Field in PlanValueField]?: Plan[(typeof PLAN_VALUE_FIELDS)[Field]];
};

/** The subscription columns the plan gives, leaving out the ones overridden for the clinic. */
export function subscriptionValuesFromPlan(
  plan: PlanValues,
  overridden: readonly string[] = [],
): PlanValueData {
  const data: Record<string, unknown> = {};
  for (const field of PLAN_VALUE_FIELD_NAMES) {
    if (!overridden.includes(field)) data[field] = plan[PLAN_VALUE_FIELDS[field]];
  }
  return data as PlanValueData;
}

/** What the clinic pays a month: its base price plus the specialties beyond those included. */
export function monthlyTotal(
  subscription: {
    basePrice: Prisma.Decimal | number;
    includedSpecialties: number;
    specialtyPrice: Prisma.Decimal | number;
  },
  specialtyCount: number,
): number {
  const extraSpecialties = Math.max(0, specialtyCount - subscription.includedSpecialties);
  const total =
    Number(subscription.basePrice) + extraSpecialties * Number(subscription.specialtyPrice);
  return Math.round(total * 100) / 100;
}

/**
 * The module keys a plan turns on for a clinic. A clinic whose specialties are all non-health
 * gets the health-only submodules off, whatever the plan includes.
 */
export function planModuleDefaults(
  planModuleKeys: readonly string[],
  specialtyCodes: readonly string[],
): Set<SectionKey> {
  const healthCare =
    specialtyCodes.length === 0 || specialtyCodes.some((code) => isHealthSpecialty(code));
  const included = new Set(planModuleKeys);
  return new Set(
    SECTION_CATALOG.filter(
      (section) => included.has(section.key) && (healthCare || !section.healthOnly),
    ).map((section) => section.key),
  );
}
