import { Prisma } from '@prisma/client';
import { SECTION_KEYS, validateSections } from '../common/sections/section-catalog';
import { DEFAULT_PLANS } from './default-plans';
import {
  PLAN_VALUE_FIELD_NAMES,
  isPlanValueField,
  monthlyTotal,
  planModuleDefaults,
  subscriptionValuesFromPlan,
} from './plan-values';

const plan = {
  basePrice: new Prisma.Decimal(199),
  pricePerSeat: new Prisma.Decimal(12),
  specialtyPrice: new Prisma.Decimal(15),
  currency: 'USD',
  seatsIncluded: 10,
  maxActivePatients: 500,
  storageGB: 25,
  monthlyElectronicInvoicesLimit: 50,
  includedSpecialties: 3,
};

describe('plan values', () => {
  it('copies every plan value to its subscription column', () => {
    expect(subscriptionValuesFromPlan(plan)).toEqual({
      basePrice: plan.basePrice,
      pricePerSeat: plan.pricePerSeat,
      specialtyPrice: plan.specialtyPrice,
      currency: 'USD',
      seatsPsychologistsMax: 10,
      maxActivePatients: 500,
      storageGB: 25,
      monthlyElectronicInvoicesLimit: 50,
      includedSpecialties: 3,
    });
  });

  it('leaves out the values overridden for the clinic', () => {
    const values = subscriptionValuesFromPlan(plan, ['basePrice', 'maxActivePatients']);
    expect(values).not.toHaveProperty('basePrice');
    expect(values).not.toHaveProperty('maxActivePatients');
    expect(values).toHaveProperty('storageGB', 25);
  });

  it('knows which names are plan values', () => {
    expect(PLAN_VALUE_FIELD_NAMES).toHaveLength(9);
    expect(isPlanValueField('seatsPsychologistsMax')).toBe(true);
    expect(isPlanValueField('status')).toBe(false);
  });

  it('adds the specialties beyond the included ones to the monthly total', () => {
    const subscription = { basePrice: 99, includedSpecialties: 2, specialtyPrice: 15 };
    expect(monthlyTotal(subscription, 1)).toBe(99);
    expect(monthlyTotal(subscription, 2)).toBe(99);
    expect(monthlyTotal(subscription, 4)).toBe(129);
    expect(
      monthlyTotal(
        {
          basePrice: new Prisma.Decimal('29.90'),
          includedSpecialties: 1,
          specialtyPrice: new Prisma.Decimal('15.05'),
        },
        3,
      ),
    ).toBe(60);
  });
});

describe('plan module defaults', () => {
  it('turns on what the plan includes for a health clinic', () => {
    expect([...planModuleDefaults([...SECTION_KEYS], ['PSYCHOLOGY'])]).toEqual([...SECTION_KEYS]);
    expect([...planModuleDefaults(['core.billing', 'core.nope'], [])]).toEqual(['core.billing']);
  });

  it('leaves the health-only submodules off only when every specialty is non-health', () => {
    const aesthetic = planModuleDefaults([...SECTION_KEYS], ['AESTHETICS']);
    expect(aesthetic.has('core.clinical.notes')).toBe(false);
    expect(aesthetic.has('core.clinical.nextSession')).toBe(false);
    expect(aesthetic.has('core.clinical.timeline')).toBe(false);
    expect(aesthetic.has('core.clinical.specialties')).toBe(true);
    expect(planModuleDefaults([...SECTION_KEYS], ['AESTHETICS', 'GENERAL_MEDICINE'])).toContain(
      'core.clinical.notes',
    );
  });
});

describe('default plans', () => {
  it('have unique codes and names', () => {
    expect(new Set(DEFAULT_PLANS.map((p) => p.code)).size).toBe(DEFAULT_PLANS.length);
    expect(new Set(DEFAULT_PLANS.map((p) => p.name)).size).toBe(DEFAULT_PLANS.length);
  });

  it('include a valid module selection, with a team only for clinics', () => {
    for (const defaultPlan of DEFAULT_PLANS) {
      expect(validateSections(defaultPlan.modules)).toEqual(defaultPlan.modules);
      expect(defaultPlan.modules.includes('core.admin.team')).toBe(
        defaultPlan.tenantType === 'CLINIC',
      );
    }
  });

  it('give every plan a finite storage quota that grows with the price', () => {
    const paid = DEFAULT_PLANS.filter((p) => p.basePrice > 0).sort(
      (a, b) => a.basePrice - b.basePrice,
    );
    for (const [index, current] of paid.entries()) {
      expect(current.storageGB).toBeGreaterThan(0);
      if (index > 0) expect(current.storageGB).toBeGreaterThan(paid[index - 1].storageGB);
    }
  });
});
