import { PlanType, TenantSubscription, TenantType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ModuleName } from './dto/customize-features.dto';

// Pricing per module (USD/month)
export const MODULE_PRICING: Record<ModuleName, number> = {
  clinicalNotes: 0, // included in all plans
  // Clinical data is always encrypted (SRS RNF-05); the module stays only as a legacy flag.
  clinicalNotesEncryption: 0,
  attachments: 3,
  tasks: 3,
  psychologicalTests: 8,
  webPush: 2,
  fcmPush: 2,
  advancedAnalytics: 10,
  videoConsultation: 12,
  calendarSync: 4,
  onlineSchedulingWidget: 5,
  customReports: 8,
  apiAccess: 15,
  whatsAppIntegration: 10,
  sso: 20,
};

// Modules included free in each plan (no extra charge)
const PLAN_INCLUDED_MODULES: Record<PlanType, ModuleName[]> = {
  TRIAL: ['clinicalNotes', 'clinicalNotesEncryption'],
  PERSONAL_BASIC: [
    'clinicalNotes',
    'clinicalNotesEncryption',
    'attachments',
    'tasks',
    'fcmPush',
    'onlineSchedulingWidget',
  ],
  PERSONAL_PRO: [
    'clinicalNotes',
    'clinicalNotesEncryption',
    'attachments',
    'tasks',
    'psychologicalTests',
    'webPush',
    'fcmPush',
    'advancedAnalytics',
    'videoConsultation',
    'calendarSync',
    'onlineSchedulingWidget',
    'customReports',
  ],
  CLINIC_BASIC: [
    'clinicalNotes',
    'clinicalNotesEncryption',
    'attachments',
    'tasks',
    'fcmPush',
    'onlineSchedulingWidget',
  ],
  CLINIC_PRO: [
    'clinicalNotes',
    'clinicalNotesEncryption',
    'attachments',
    'tasks',
    'psychologicalTests',
    'webPush',
    'fcmPush',
    'advancedAnalytics',
    'videoConsultation',
    'calendarSync',
    'onlineSchedulingWidget',
    'customReports',
    'apiAccess',
  ],
  CLINIC_ENTERPRISE: [
    'clinicalNotes',
    'clinicalNotesEncryption',
    'attachments',
    'tasks',
    'psychologicalTests',
    'webPush',
    'fcmPush',
    'advancedAnalytics',
    'videoConsultation',
    'calendarSync',
    'onlineSchedulingWidget',
    'customReports',
    'apiAccess',
    'whatsAppIntegration',
    'sso',
  ],
};

// All available module names matching DB column pattern
export const ALL_MODULES: ModuleName[] = [
  'clinicalNotes',
  'clinicalNotesEncryption',
  'attachments',
  'tasks',
  'psychologicalTests',
  'webPush',
  'fcmPush',
  'advancedAnalytics',
  'videoConsultation',
  'calendarSync',
  'onlineSchedulingWidget',
  'customReports',
  'apiAccess',
  'whatsAppIntegration',
  'sso',
];

export const PLAN_SPECIALTY_LIMITS: Record<PlanType, number> = {
  TRIAL: 1,
  PERSONAL_BASIC: 1,
  PERSONAL_PRO: 2,
  CLINIC_BASIC: 2,
  CLINIC_PRO: 3,
  CLINIC_ENTERPRISE: 999,
};

export const SPECIALTY_PRICE_PER_MONTH = 15;

export function moduleToDbKey(mod: ModuleName): string {
  const acronymKeys: Partial<Record<ModuleName, string>> = {
    fcmPush: 'featureFCMPush',
    apiAccess: 'featureAPIAccess',
    sso: 'featureSSO',
  };
  if (acronymKeys[mod]) return acronymKeys[mod];
  return `feature${mod.charAt(0).toUpperCase()}${mod.slice(1)}`;
}

function resolvePlanKey(planType: PlanType): PlanType {
  const legacyMap: Record<string, PlanType> = {
    BASIC: 'CLINIC_BASIC',
    PRO: 'CLINIC_PRO',
    CUSTOM: 'CLINIC_ENTERPRISE',
  };
  return legacyMap[planType] || planType;
}

export function getPlanIncludedModules(planType: PlanType): ModuleName[] {
  return [...(PLAN_INCLUDED_MODULES[resolvePlanKey(planType)] || [])];
}

export function getPlanFeatureFlags(planType: PlanType): Record<string, boolean> {
  const includedModules = getPlanIncludedModules(planType);
  const features: Record<string, boolean> = {};
  for (const mod of ALL_MODULES) {
    features[moduleToDbKey(mod)] = includedModules.includes(mod);
  }
  return features;
}

export function getSelectedModules(subscription: TenantSubscription): ModuleName[] {
  return ALL_MODULES.filter(
    (mod) => subscription[moduleToDbKey(mod) as keyof TenantSubscription] === true,
  );
}

export function getPlanLimits(planType: PlanType) {
  const plans = {
    TRIAL: {
      planType: 'TRIAL' as PlanType,
      tenantType: 'PERSONAL' as TenantType,
      basePrice: new Decimal(0),
      pricePerSeat: new Decimal(0),
      seatsIncluded: 1,
      maxActivePatients: 10,
      storageGB: 1,
      monthlyNotificationsLimit: 100,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.TRIAL,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
    PERSONAL_BASIC: {
      planType: 'PERSONAL_BASIC' as PlanType,
      tenantType: 'PERSONAL' as TenantType,
      basePrice: new Decimal(29),
      pricePerSeat: new Decimal(0),
      seatsIncluded: 1,
      maxActivePatients: 50,
      storageGB: 2,
      monthlyNotificationsLimit: 300,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.PERSONAL_BASIC,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
    PERSONAL_PRO: {
      planType: 'PERSONAL_PRO' as PlanType,
      tenantType: 'PERSONAL' as TenantType,
      basePrice: new Decimal(59),
      pricePerSeat: new Decimal(0),
      seatsIncluded: 1,
      maxActivePatients: 200,
      storageGB: 5,
      monthlyNotificationsLimit: 1000,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.PERSONAL_PRO,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
    CLINIC_BASIC: {
      planType: 'CLINIC_BASIC' as PlanType,
      tenantType: 'CLINIC' as TenantType,
      basePrice: new Decimal(99),
      pricePerSeat: new Decimal(15),
      seatsIncluded: 3,
      maxActivePatients: 150,
      storageGB: 10,
      monthlyNotificationsLimit: 500,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.CLINIC_BASIC,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
    CLINIC_PRO: {
      planType: 'CLINIC_PRO' as PlanType,
      tenantType: 'CLINIC' as TenantType,
      basePrice: new Decimal(199),
      pricePerSeat: new Decimal(12),
      seatsIncluded: 10,
      maxActivePatients: 500,
      storageGB: 25,
      monthlyNotificationsLimit: 2000,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.CLINIC_PRO,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
    CLINIC_ENTERPRISE: {
      planType: 'CLINIC_ENTERPRISE' as PlanType,
      tenantType: 'CLINIC' as TenantType,
      basePrice: new Decimal(0),
      pricePerSeat: new Decimal(0),
      seatsIncluded: 999,
      maxActivePatients: 999999,
      storageGB: 100,
      monthlyNotificationsLimit: 999999,
      includedSpecialties: PLAN_SPECIALTY_LIMITS.CLINIC_ENTERPRISE,
      specialtyPrice: new Decimal(SPECIALTY_PRICE_PER_MONTH),
      monthlyElectronicInvoicesLimit: 50,
    },
  };

  return plans[resolvePlanKey(planType) as keyof typeof plans];
}

export type SubscriptionPriceInput = {
  planType: PlanType;
  selectedModules: readonly ModuleName[];
  specialtyCount: number;
  specialtyUnitPrice?: number;
};

export type SubscriptionPriceBreakdown = {
  basePlanPrice: number;
  featureAddonsPrice: number;
  specialtyAddonsPrice: number;
  totalMonthly: number;
  includedSpecialties: number;
  selectedSpecialties: number;
  billableSpecialties: number;
  specialtyUnitPrice: number;
};

export function calculateSubscriptionPrice(
  input: SubscriptionPriceInput,
): SubscriptionPriceBreakdown {
  const limits = getPlanLimits(input.planType);
  const includedModules = new Set(getPlanIncludedModules(input.planType));
  const featureAddonsPrice = [...new Set(input.selectedModules)]
    .filter((module) => !includedModules.has(module))
    .reduce((total, module) => total + MODULE_PRICING[module], 0);
  const includedSpecialties = limits.includedSpecialties;
  const selectedSpecialties = input.specialtyCount;
  const billableSpecialties = Math.max(0, selectedSpecialties - includedSpecialties);
  const specialtyUnitPrice = input.specialtyUnitPrice ?? SPECIALTY_PRICE_PER_MONTH;
  const specialtyAddonsPrice = billableSpecialties * specialtyUnitPrice;
  const basePlanPrice = Number(limits.basePrice);

  return {
    basePlanPrice,
    featureAddonsPrice,
    specialtyAddonsPrice,
    totalMonthly: basePlanPrice + featureAddonsPrice + specialtyAddonsPrice,
    includedSpecialties,
    selectedSpecialties,
    billableSpecialties,
    specialtyUnitPrice,
  };
}
