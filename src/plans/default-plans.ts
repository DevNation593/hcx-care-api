import { TenantType } from '@prisma/client';
import { SECTION_KEYS, SectionKey } from '../common/sections/section-catalog';

/**
 * The plans a fresh database starts with. Migration 20261025000000_editable_plans inserts the
 * same values; after that the platform administrator owns them. 999 seats, 999999 patients and
 * 999 specialties read as "no practical limit"; a base price of 0 is agreed with sales.
 */
export interface DefaultPlan {
  code: string;
  name: string;
  description: string;
  tenantType: TenantType;
  sortOrder: number;
  basePrice: number;
  pricePerSeat: number;
  specialtyPrice: number;
  seatsIncluded: number;
  maxActivePatients: number;
  storageGB: number;
  monthlyElectronicInvoicesLimit: number;
  includedSpecialties: number;
  trialDays: number;
  modules: SectionKey[];
}

/** A personal practice has no team to manage. */
const PERSONAL_MODULES = SECTION_KEYS.filter((key) => key !== 'core.admin.team');
const CLINIC_MODULES = [...SECTION_KEYS];

export const DEFAULT_TRIAL_DAYS = 14;

export const DEFAULT_PLANS: readonly DefaultPlan[] = [
  {
    code: 'PERSONAL_BASIC',
    name: 'Personal Básico',
    description: 'Para un profesional independiente.',
    tenantType: 'PERSONAL',
    sortOrder: 10,
    basePrice: 29,
    pricePerSeat: 0,
    specialtyPrice: 15,
    seatsIncluded: 1,
    maxActivePatients: 50,
    storageGB: 2,
    monthlyElectronicInvoicesLimit: 50,
    includedSpecialties: 1,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: PERSONAL_MODULES,
  },
  {
    code: 'PERSONAL_PRO',
    name: 'Personal Pro',
    description: 'Para una consulta individual en crecimiento.',
    tenantType: 'PERSONAL',
    sortOrder: 20,
    basePrice: 59,
    pricePerSeat: 0,
    specialtyPrice: 15,
    seatsIncluded: 1,
    maxActivePatients: 200,
    storageGB: 5,
    monthlyElectronicInvoicesLimit: 50,
    includedSpecialties: 2,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: PERSONAL_MODULES,
  },
  {
    code: 'CLINIC_BASIC',
    name: 'Clínica Básico',
    description: 'Para equipos pequeños.',
    tenantType: 'CLINIC',
    sortOrder: 30,
    basePrice: 99,
    pricePerSeat: 15,
    specialtyPrice: 15,
    seatsIncluded: 3,
    maxActivePatients: 150,
    storageGB: 10,
    monthlyElectronicInvoicesLimit: 50,
    includedSpecialties: 2,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
  },
  {
    code: 'CLINIC_PRO',
    name: 'Clínica Pro',
    description: 'Para clínicas con varias especialidades.',
    tenantType: 'CLINIC',
    sortOrder: 40,
    basePrice: 199,
    pricePerSeat: 12,
    specialtyPrice: 15,
    seatsIncluded: 10,
    maxActivePatients: 500,
    storageGB: 25,
    monthlyElectronicInvoicesLimit: 50,
    includedSpecialties: 3,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
  },
  {
    code: 'CLINIC_ENTERPRISE',
    name: 'Clínica Personalizado',
    description: 'Para redes de clínicas con necesidades a medida.',
    tenantType: 'CLINIC',
    sortOrder: 50,
    basePrice: 0,
    pricePerSeat: 0,
    specialtyPrice: 15,
    seatsIncluded: 999,
    maxActivePatients: 999999,
    storageGB: 100,
    monthlyElectronicInvoicesLimit: 50,
    includedSpecialties: 999,
    trialDays: 0,
    modules: CLINIC_MODULES,
  },
];
