import { TenantType } from '@prisma/client';
import { SECTION_KEYS, SectionKey } from '../common/sections/section-catalog';

/**
 * The plans a fresh database starts with. Migrations 20261025000000_editable_plans and
 * 20261028000000_plan_ladder insert the same values; after that the platform administrator owns
 * them. 999 seats, 999999 patients and 999 specialties read as "no practical limit"; a base
 * price of 0 is agreed with sales. Prices are USD a month before VAT.
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
  maxBranches: number;
  trialDays: number;
  modules: SectionKey[];
  /** Replaced by the plan ladder: clinics on it keep it, new ones cannot get it. */
  archived?: boolean;
}

/** A personal practice has no team to manage. */
const PERSONAL_MODULES = SECTION_KEYS.filter((key) => key !== 'core.admin.team');
const CLINIC_MODULES = [...SECTION_KEYS];

export const DEFAULT_TRIAL_DAYS = 14;

export const DEFAULT_PLANS: readonly DefaultPlan[] = [
  {
    code: 'ESENCIAL',
    name: 'Esencial',
    description: 'Consultorios independientes.',
    tenantType: 'PERSONAL',
    sortOrder: 60,
    basePrice: 24.9,
    pricePerSeat: 0,
    specialtyPrice: 10,
    seatsIncluded: 1,
    maxActivePatients: 100,
    storageGB: 3,
    monthlyElectronicInvoicesLimit: 30,
    includedSpecialties: 1,
    maxBranches: 1,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: PERSONAL_MODULES,
  },
  {
    code: 'PROFESIONAL',
    name: 'Profesional',
    description: 'Consultorios con equipo.',
    tenantType: 'CLINIC',
    sortOrder: 70,
    basePrice: 44.9,
    pricePerSeat: 14,
    specialtyPrice: 10,
    seatsIncluded: 3,
    maxActivePatients: 300,
    storageGB: 10,
    monthlyElectronicInvoicesLimit: 100,
    includedSpecialties: 2,
    maxBranches: 1,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
  },
  {
    code: 'CENTRO',
    name: 'Centro',
    description: 'Centros multiespecialidad.',
    tenantType: 'CLINIC',
    sortOrder: 80,
    basePrice: 79.9,
    pricePerSeat: 12,
    specialtyPrice: 10,
    seatsIncluded: 6,
    maxActivePatients: 600,
    storageGB: 25,
    monthlyElectronicInvoicesLimit: 300,
    includedSpecialties: 3,
    maxBranches: 2,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
  },
  {
    code: 'CLINICA',
    name: 'Clínica',
    description: 'Clínicas pequeñas y medianas.',
    tenantType: 'CLINIC',
    sortOrder: 90,
    basePrice: 149.9,
    pricePerSeat: 10,
    specialtyPrice: 10,
    seatsIncluded: 15,
    maxActivePatients: 1500,
    storageGB: 60,
    monthlyElectronicInvoicesLimit: 1000,
    includedSpecialties: 5,
    maxBranches: 5,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
  },
  {
    code: 'CLINIC_ENTERPRISE',
    name: 'Personalizado',
    description: 'Redes de clínicas con necesidades a medida.',
    tenantType: 'CLINIC',
    sortOrder: 100,
    basePrice: 0,
    pricePerSeat: 0,
    specialtyPrice: 15,
    seatsIncluded: 999,
    maxActivePatients: 999999,
    storageGB: 100,
    monthlyElectronicInvoicesLimit: 3000,
    includedSpecialties: 999,
    maxBranches: 50,
    trialDays: 0,
    modules: CLINIC_MODULES,
  },
  // The first catalog. Clinics already on these plans keep them as they are.
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
    maxBranches: 1,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: PERSONAL_MODULES,
    archived: true,
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
    maxBranches: 1,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: PERSONAL_MODULES,
    archived: true,
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
    maxBranches: 50,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
    archived: true,
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
    maxBranches: 50,
    trialDays: DEFAULT_TRIAL_DAYS,
    modules: CLINIC_MODULES,
    archived: true,
  },
];

/** The id the migrations give a default plan, and the columns to create it with. */
export function defaultPlanRow({ modules: _modules, archived, ...plan }: DefaultPlan) {
  return {
    id: `plan_${plan.code.toLowerCase()}`,
    ...plan,
    // Any past date reads as archived; the migration stamps the day it ran.
    archivedAt: archived ? new Date('2026-10-28T00:00:00Z') : null,
  };
}
