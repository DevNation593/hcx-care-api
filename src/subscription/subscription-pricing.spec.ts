import { TenantSubscription } from '@prisma/client';
import {
  MODULE_PRICING,
  calculateSubscriptionPrice,
  getPlanFeatureFlags,
  getPlanIncludedModules,
  getPlanLimits,
  getSelectedModules,
} from './subscription-pricing';

describe('plan storage quotas', () => {
  it('gives every plan a finite quota that grows with the tier', () => {
    const tiers = [
      'TRIAL',
      'PERSONAL_BASIC',
      'PERSONAL_PRO',
      'CLINIC_BASIC',
      'CLINIC_PRO',
      'CLINIC_ENTERPRISE',
    ] as const;

    expect(tiers.map((plan) => getPlanLimits(plan).storageGB)).toEqual([1, 2, 5, 10, 25, 100]);
  });
});

describe('calculateSubscriptionPrice', () => {
  it('preserves commercial add-ons while charging specialties above the included count', () => {
    expect(
      calculateSubscriptionPrice({
        planType: 'CLINIC_BASIC',
        selectedModules: ['clinicalNotes', 'attachments', 'advancedAnalytics'],
        specialtyCount: 4,
        specialtyUnitPrice: 15,
      }),
    ).toEqual({
      basePlanPrice: 99,
      featureAddonsPrice: 10,
      specialtyAddonsPrice: 30,
      totalMonthly: 139,
      includedSpecialties: 2,
      selectedSpecialties: 4,
      billableSpecialties: 2,
      specialtyUnitPrice: 15,
    });
  });

  it('returns the same total every time for the same input', () => {
    const input = {
      planType: 'TRIAL' as const,
      selectedModules: ['clinicalNotes'] as const,
      specialtyCount: 2,
      specialtyUnitPrice: 15,
    };
    expect(calculateSubscriptionPrice(input)).toEqual({
      basePlanPrice: 0,
      featureAddonsPrice: 0,
      specialtyAddonsPrice: 15,
      totalMonthly: 15,
      includedSpecialties: 1,
      selectedSpecialties: 2,
      billableSpecialties: 1,
      specialtyUnitPrice: 15,
    });
  });
});

describe('clinical encryption', () => {
  const plans = [
    'TRIAL',
    'PERSONAL_BASIC',
    'PERSONAL_PRO',
    'CLINIC_BASIC',
    'CLINIC_PRO',
    'CLINIC_ENTERPRISE',
  ] as const;

  it.each(plans)('is part of %s and never an extra charge', (planType) => {
    expect(getPlanIncludedModules(planType)).toContain('clinicalNotesEncryption');
    expect(MODULE_PRICING.clinicalNotesEncryption).toBe(0);
    expect(
      calculateSubscriptionPrice({
        planType,
        selectedModules: ['clinicalNotes', 'clinicalNotesEncryption'],
        specialtyCount: 1,
      }).featureAddonsPrice,
    ).toBe(0);
  });
});

describe('subscription module flags', () => {
  it('reads persisted clinical notes and acronym module add-ons', () => {
    const subscription = {
      featureClinicalNotes: true,
      featureFCMPush: true,
      featureAPIAccess: true,
      featureSSO: true,
    } as TenantSubscription;

    expect(getSelectedModules(subscription)).toEqual([
      'clinicalNotes',
      'fcmPush',
      'apiAccess',
      'sso',
    ]);
    expect(getPlanFeatureFlags('CLINIC_PRO')).toMatchObject({
      featureFCMPush: true,
      featureAPIAccess: true,
      featureSSO: false,
    });
  });

  it('does not let callers mutate the canonical included modules', () => {
    const included = getPlanIncludedModules('CLINIC_BASIC');
    included.push('sso');
    try {
      expect(getPlanIncludedModules('CLINIC_BASIC')).not.toContain('sso');
      expect(
        calculateSubscriptionPrice({
          planType: 'CLINIC_BASIC',
          selectedModules: ['clinicalNotes', 'sso'],
          specialtyCount: 2,
        }).totalMonthly,
      ).toBe(119);
    } finally {
      included.pop();
    }
  });
});
