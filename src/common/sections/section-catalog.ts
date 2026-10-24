import { BadRequestException } from '@nestjs/common';

// Modules and their submodules, in the order the platform panel shows them. A key with two
// segments is a module; one with three is a submodule of the module its first two name.
export const SECTION_KEYS = [
  'core.agenda',
  'core.agenda.calendar',
  'core.agenda.tasks',
  'core.agenda.notifications',
  'core.patients',
  'core.patients.records',
  'core.patients.team',
  'core.patients.files',
  'core.clinical',
  'core.clinical.notes',
  'core.clinical.nextSession',
  'core.clinical.timeline',
  'core.clinical.specialties',
  'core.clinical.forms',
  'core.clinical.templates',
  'core.treatments',
  'core.treatments.catalog',
  'core.treatments.sessions',
  'core.treatments.consents',
  'core.billing',
  'core.billing.profiles',
  'core.billing.orders',
  'core.billing.cash',
  'core.billing.invoicing',
  'core.admin',
  'core.admin.team',
  'core.admin.branches',
  'core.admin.reports',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export interface SectionDefinition {
  key: SectionKey;
  name: string;
  /** The module a submodule belongs to; absent on modules. */
  parent?: SectionKey;
  /** Submodules that must also be in effect for this one to work. */
  requires: SectionKey[];
  /** Health care only: off by default in a clinic whose specialties are all non-health. */
  healthOnly?: boolean;
}

const RECORDS: SectionKey[] = ['core.patients.records'];

export const SECTION_CATALOG: readonly SectionDefinition[] = [
  { key: 'core.agenda', name: 'Agenda', requires: [] },
  {
    key: 'core.agenda.calendar',
    name: 'Calendario y citas',
    parent: 'core.agenda',
    requires: RECORDS,
  },
  { key: 'core.agenda.tasks', name: 'Actividades', parent: 'core.agenda', requires: RECORDS },
  {
    key: 'core.agenda.notifications',
    name: 'Notificaciones push',
    parent: 'core.agenda',
    requires: [],
  },
  { key: 'core.patients', name: 'Pacientes', requires: [] },
  {
    key: 'core.patients.records',
    name: 'Fichas de pacientes',
    parent: 'core.patients',
    requires: [],
  },
  {
    key: 'core.patients.team',
    name: 'Equipo tratante',
    parent: 'core.patients',
    requires: RECORDS,
  },
  {
    key: 'core.patients.files',
    name: 'Archivos y documentos',
    parent: 'core.patients',
    requires: RECORDS,
  },
  { key: 'core.clinical', name: 'Clínico', requires: [] },
  {
    key: 'core.clinical.notes',
    name: 'Notas clínicas',
    parent: 'core.clinical',
    requires: RECORDS,
    healthOnly: true,
  },
  {
    key: 'core.clinical.nextSession',
    name: 'Plan de próxima sesión',
    parent: 'core.clinical',
    requires: RECORDS,
    healthOnly: true,
  },
  {
    key: 'core.clinical.timeline',
    name: 'Línea de tiempo',
    parent: 'core.clinical',
    requires: RECORDS,
    healthOnly: true,
  },
  {
    key: 'core.clinical.specialties',
    name: 'Atenciones por especialidad',
    parent: 'core.clinical',
    requires: RECORDS,
  },
  {
    key: 'core.clinical.forms',
    name: 'Formularios',
    parent: 'core.clinical',
    requires: ['core.clinical.specialties'],
  },
  {
    key: 'core.clinical.templates',
    name: 'Plantillas de documentos',
    parent: 'core.clinical',
    requires: ['core.clinical.specialties'],
  },
  { key: 'core.treatments', name: 'Tratamientos', requires: [] },
  {
    key: 'core.treatments.catalog',
    name: 'Catálogo de tratamientos',
    parent: 'core.treatments',
    requires: [],
  },
  {
    key: 'core.treatments.sessions',
    name: 'Sesiones de tratamiento',
    parent: 'core.treatments',
    requires: [...RECORDS, 'core.treatments.catalog'],
  },
  {
    key: 'core.treatments.consents',
    name: 'Consentimientos',
    parent: 'core.treatments',
    requires: ['core.treatments.catalog'],
  },
  { key: 'core.billing', name: 'Facturación', requires: [] },
  {
    key: 'core.billing.profiles',
    name: 'Perfiles de facturación',
    parent: 'core.billing',
    requires: [],
  },
  {
    key: 'core.billing.orders',
    name: 'Órdenes y cobros',
    parent: 'core.billing',
    requires: ['core.billing.profiles'],
  },
  {
    key: 'core.billing.cash',
    name: 'Caja',
    parent: 'core.billing',
    requires: ['core.billing.orders'],
  },
  {
    key: 'core.billing.invoicing',
    name: 'Facturación electrónica',
    parent: 'core.billing',
    requires: ['core.billing.orders'],
  },
  { key: 'core.admin', name: 'Administración', requires: [] },
  { key: 'core.admin.team', name: 'Equipo y usuarios', parent: 'core.admin', requires: [] },
  { key: 'core.admin.branches', name: 'Sucursales', parent: 'core.admin', requires: [] },
  {
    key: 'core.admin.reports',
    name: 'Reportes',
    parent: 'core.admin',
    requires: ['core.agenda.calendar'],
  },
];

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

export function sectionDefinition(key: SectionKey): SectionDefinition {
  return SECTION_CATALOG.find((section) => section.key === key)!;
}

/**
 * Whether a key works with the given rows on: a module needs its own row, a submodule needs
 * its row and its module's. A submodule kept on under a module turned off stays saved but idle.
 */
export function isSectionInEffect(key: SectionKey, enabled: ReadonlySet<string>): boolean {
  const { parent } = sectionDefinition(key);
  return enabled.has(key) && (!parent || enabled.has(parent));
}

/**
 * Deduplicates and keeps catalog order; throws BadRequestException SECTION_UNKNOWN { section }
 * or SECTION_DEPENDENCY { section, requires } when a key in effect needs one that is not.
 */
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
  for (const definition of SECTION_CATALOG) {
    if (!isSectionInEffect(definition.key, selected)) continue;
    if (definition.requires.some((required) => !isSectionInEffect(required, selected))) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'SECTION_DEPENDENCY',
        message: `Section ${definition.key} requires ${definition.requires.join(', ')}`,
        section: definition.key,
        requires: definition.requires,
      });
    }
  }
  return SECTION_KEYS.filter((key) => selected.has(key));
}
