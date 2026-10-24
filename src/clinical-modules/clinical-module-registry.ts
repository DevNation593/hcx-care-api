import { clinicalRecordInvalid, validateFormData } from '../clinical-forms/form-schema';
import { DENTISTRY_MODULES } from './definitions/dentistry';
import { GENERAL_MODULES } from './definitions/general';
import { NUTRITION_MODULES } from './definitions/nutrition';
import { PHYSIOTHERAPY_MODULES } from './definitions/physiotherapy';
import { PSYCHOLOGY_MODULES } from './definitions/psychology';
import { ClinicalModuleDefinition } from './module-builders';

/** Every version of every clinical module the platform defines. Versions are never edited. */
export const CLINICAL_MODULES: readonly ClinicalModuleDefinition[] = [
  ...GENERAL_MODULES,
  ...PSYCHOLOGY_MODULES,
  ...NUTRITION_MODULES,
  ...PHYSIOTHERAPY_MODULES,
  ...DENTISTRY_MODULES,
];

/** Answers to a tenant-defined form are stored under `custom.<formDefinitionId>`. */
export const CUSTOM_MODULE_PREFIX = 'custom.';

/**
 * Modules whose records each describe a standing fact of the patient, so all of them raise
 * alerts. For every other module only the most recent record does.
 */
export const STANDING_ALERT_MODULES: readonly string[] = ['general.allergies'];

/** Specialties that are not health care: they never get the health-only modules. */
export const AESTHETIC_SPECIALTY_CODES = ['AESTHETICS'] as const;

/** Whether a specialty is health care. Unknown or missing codes count as health. */
export function isHealthSpecialty(code: string | null | undefined): boolean {
  return !(AESTHETIC_SPECIALTY_CODES as readonly string[]).includes(code ?? '');
}

export function clinicalModuleVersions(moduleKey: string): ClinicalModuleDefinition[] {
  return CLINICAL_MODULES.filter((definition) => definition.moduleKey === moduleKey).sort(
    (a, b) => a.schemaVersion - b.schemaVersion,
  );
}

export function latestClinicalModule(moduleKey: string): ClinicalModuleDefinition | undefined {
  return clinicalModuleVersions(moduleKey).at(-1);
}

export function findClinicalModule(
  moduleKey: string,
  schemaVersion: number,
): ClinicalModuleDefinition | undefined {
  return CLINICAL_MODULES.find(
    (definition) =>
      definition.moduleKey === moduleKey && definition.schemaVersion === schemaVersion,
  );
}

/**
 * The version a write is checked against. A request that names no version comes from a
 * client older than the definitions: it gets the legacy version when the module has one.
 */
export function resolveWriteVersion(
  moduleKey: string,
  schemaVersion?: number,
): ClinicalModuleDefinition | undefined {
  if (schemaVersion !== undefined) return findClinicalModule(moduleKey, schemaVersion);
  const versions = clinicalModuleVersions(moduleKey);
  return versions.find((definition) => definition.legacy) ?? versions.at(-1);
}

/** Module keys each specialty of the catalog owns, as stored in SpecialtyModule. */
export function specialtyModuleKeys(specialtyCode: string): string[] {
  return [
    ...new Set(
      CLINICAL_MODULES.filter((definition) => definition.specialtyCode === specialtyCode).map(
        (definition) => definition.moduleKey,
      ),
    ),
  ];
}

/** Returns the data to store, or throws CLINICAL_RECORD_INVALID (422). */
export function validateModuleData(
  definition: Pick<ClinicalModuleDefinition, 'legacy' | 'schema'>,
  data: unknown,
): Record<string, unknown> {
  if (!definition.legacy) return validateFormData(definition.schema, data);

  const record = (data ?? {}) as Record<string, unknown>;
  const missing = definition.schema.sections
    .flatMap((section) => section.fields)
    .filter(({ key }) => record[key] === undefined || record[key] === null || record[key] === '');
  if (missing.length > 0) {
    throw clinicalRecordInvalid(
      missing.map(({ key }) => ({ field: key, message: 'Este campo es obligatorio' })),
    );
  }
  return record;
}
