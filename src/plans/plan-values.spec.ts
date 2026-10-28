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
  maxBranches: 2,
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
      maxBranches: 2,
    });
  });

  it('leaves out the values overridden for the clinic', () => {
    const values = subscriptionValuesFromPlan(plan, ['basePrice', 'maxActivePatients']);
    expect(values).not.toHaveProperty('basePrice');
    expect(values).not.toHaveProperty('maxActivePatients');
    expect(values).toHaveProperty('storageGB', 25);
  });

  it('knows which names are plan values', () => {
    expect(PLAN_VALUE_FIELD_NAMES).toHaveLength(10);
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

  const offered = DEFAULT_PLANS.filter((p) => !p.archived && p.basePrice > 0).sort(
    (a, b) => a.basePrice - b.basePrice,
  );

  it('give every plan a finite storage quota that grows with the price', () => {
    for (const [index, current] of offered.entries()) {
      expect(current.storageGB).toBeGreaterThan(0);
      if (index > 0) expect(current.storageGB).toBeGreaterThan(offered[index - 1].storageGB);
    }
  });

  it('offer the ladder with more invoices, professionals and branches on each step', () => {
    expect(offered.map((p) => [p.code, p.basePrice, p.monthlyElectronicInvoicesLimit])).toEqual([
      ['ESENCIAL', 24.9, 30],
      ['PROFESIONAL', 44.9, 100],
      ['CENTRO', 79.9, 300],
      ['CLINICA', 149.9, 1000],
    ]);
    expect(offered.map((p) => [p.seatsIncluded, p.maxBranches])).toEqual([
      [1, 1],
      [3, 1],
      [6, 2],
      [15, 5],
    ]);
  });

  it('make filling a plan with extra professionals cost more than the next step', () => {
    for (const [index, current] of offered.entries()) {
      const next = offered[index + 1];
      if (!next || current.pricePerSeat === 0) continue;
      const filled =
        current.basePrice + (next.seatsIncluded - current.seatsIncluded) * current.pricePerSeat;
      expect(filled).toBeGreaterThan(next.basePrice);
    }
  });

  it('keep the replaced plans archived with the branches clinics had on them', () => {
    const archived = DEFAULT_PLANS.filter((p) => p.archived);
    expect(archived.map((p) => p.code)).toEqual([
      'PERSONAL_BASIC',
      'PERSONAL_PRO',
      'CLINIC_BASIC',
      'CLINIC_PRO',
    ]);
    for (const p of archived) expect(p.maxBranches).toBe(p.tenantType === 'CLINIC' ? 50 : 1);
  });
});
