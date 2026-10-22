import { BadRequestException } from '@nestjs/common';
import { PlanType, TenantType } from '@prisma/client';
import { getPlanIncludedModules } from '../../subscription/subscription-pricing';

export const SECTION_KEYS = [
  'core.calendar',
  'core.patients',
  'core.tasks',
  'core.clinicalNotes',
  'core.specialties',
  'core.billing',
  'core.team',
  'core.storage',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export interface SectionDefinition {
  key: SectionKey;
  name: string;
  requires: SectionKey[];
}

export const SECTION_CATALOG: readonly SectionDefinition[] = [
  { key: 'core.calendar', name: 'Calendario', requires: ['core.patients'] },
  { key: 'core.patients', name: 'Pacientes', requires: [] },
  { key: 'core.tasks', name: 'Actividades', requires: ['core.patients'] },
  { key: 'core.clinicalNotes', name: 'Notas clínicas', requires: ['core.patients'] },
  { key: 'core.specialties', name: 'Módulos clínicos', requires: ['core.patients'] },
  { key: 'core.billing', name: 'Facturación', requires: [] },
  { key: 'core.team', name: 'Equipo', requires: [] },
  { key: 'core.storage', name: 'Almacenamiento', requires: [] },
];

const PERSONAL_PLANS: readonly PlanType[] = ['PERSONAL_BASIC', 'PERSONAL_PRO'];
const CLINIC_PLANS: readonly PlanType[] = ['CLINIC_BASIC', 'CLINIC_PRO', 'CLINIC_ENTERPRISE'];

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

export function defaultSections(planType: PlanType, tenantType: TenantType): SectionKey[] {
  const includesTasks = (getPlanIncludedModules(planType) as string[]).includes('tasks');
  return SECTION_KEYS.filter((key) => {
    if (key === 'core.tasks') return includesTasks;
    if (key === 'core.team') return tenantType === 'CLINIC';
    return true;
  });
}

/** Deduplicates; throws BadRequestException SECTION_UNKNOWN { section } or SECTION_DEPENDENCY { section, requires }. */
export function validateSections(keys: string[]): SectionKey[] {
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (!isSectionKey(key)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'SECTION_UNKNOWN',
        message: `Unknown section: ${key}`,
        section: key,
      });
    }
  }
  const selected = new Set<string>(unique);
  for (const key of unique as SectionKey[]) {
    const definition = SECTION_CATALOG.find((s) => s.key === key)!;
    if (definition.requires.some((required) => !selected.has(required))) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'SECTION_DEPENDENCY',
        message: `Section ${key} requires ${definition.requires.join(', ')}`,
        section: key,
        requires: definition.requires,
      });
    }
  }
  return unique as SectionKey[];
}

export function isPlanAllowedForTenantType(planType: PlanType, tenantType: TenantType): boolean {
  if (planType === 'TRIAL') return true;
  return (tenantType === 'PERSONAL' ? PERSONAL_PLANS : CLINIC_PLANS).includes(planType);
}
