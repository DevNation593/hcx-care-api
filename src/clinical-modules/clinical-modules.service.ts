import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FormSchema } from '../clinical-forms/form-schema';
import {
  CLINICAL_MODULES,
  CUSTOM_MODULE_PREFIX,
  isHealthSpecialty,
  latestClinicalModule,
} from './clinical-module-registry';
import { ClinicalModuleRenderer } from './module-builders';

export interface TenantClinicalModule {
  moduleKey: string;
  scope: 'GENERAL' | 'SPECIALTY' | 'CUSTOM';
  specialtyCode: string | null;
  name: string;
  description: string | null;
  category: string | null;
  schemaVersion: number;
  isLatest: boolean;
  renderer: ClinicalModuleRenderer;
  legacy: boolean;
  schema: FormSchema;
  /** The clinic has the module (and its specialty) enabled. */
  enabled: boolean;
  /** The caller may create records of this version: enabled, latest and within their specialty. */
  canRecord: boolean;
}

@Injectable()
export class ClinicalModulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every version of every module and tenant form, so the web can render any stored record.
   * Disabled modules are included for that reason; `enabled` and `canRecord` say what is usable.
   */
  async listForTenant(tenantId: string, userId: string): Promise<TenantClinicalModule[]> {
    const [profile, tenantSpecialties, tenantModules, forms] = await Promise.all([
      this.prisma.professionalProfile.findFirst({
        where: { userId, isActive: true, user: { tenantId, isActive: true } },
        select: { specialtyId: true, specialty: { select: { code: true } } },
      }),
      this.prisma.tenantSpecialty.findMany({
        where: { tenantId, specialty: { isActive: true } },
        select: { specialty: { select: { code: true } } },
      }),
      this.prisma.tenantModule.findMany({
        where: { tenantId, enabled: true },
        select: { moduleKey: true },
      }),
      this.prisma.formDefinition.findMany({
        where: { tenantId },
        include: {
          specialty: { select: { code: true } },
          versions: { orderBy: { version: 'asc' } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const ownCode = profile?.specialty.code ?? null;
    const enabledSpecialties = new Set(tenantSpecialties.map(({ specialty }) => specialty.code));
    const enabledModules = new Set(tenantModules.map(({ moduleKey }) => moduleKey));
    const offersHealthCare = [...enabledSpecialties].some((code) => isHealthSpecialty(code));

    const defined = CLINICAL_MODULES.map((definition): TenantClinicalModule => {
      const isLatest =
        latestClinicalModule(definition.moduleKey)?.schemaVersion === definition.schemaVersion;
      const enabled =
        definition.scope === 'GENERAL'
          ? !definition.healthOnly || offersHealthCare
          : enabledSpecialties.has(definition.specialtyCode!) &&
            enabledModules.has(definition.moduleKey);
      const withinSpecialty =
        definition.scope === 'GENERAL'
          ? (!definition.allowedSpecialtyCodes ||
              definition.allowedSpecialtyCodes.includes(ownCode!)) &&
            (!definition.healthOnly || isHealthSpecialty(ownCode))
          : definition.specialtyCode === ownCode;

      return {
        moduleKey: definition.moduleKey,
        scope: definition.scope,
        specialtyCode: definition.specialtyCode,
        name: definition.name,
        description: definition.description,
        category: null,
        schemaVersion: definition.schemaVersion,
        isLatest,
        renderer: definition.renderer,
        legacy: definition.legacy ?? false,
        schema: definition.schema,
        enabled,
        canRecord: enabled && isLatest && ownCode !== null && withinSpecialty,
      };
    });

    const custom = forms.flatMap((form) =>
      form.versions.map((version): TenantClinicalModule => {
        const isLatest = version.version === form.currentVersion;
        return {
          moduleKey: `${CUSTOM_MODULE_PREFIX}${form.id}`,
          scope: 'CUSTOM',
          specialtyCode: form.specialty?.code ?? null,
          name: form.name,
          description: form.description,
          category: form.category,
          schemaVersion: version.version,
          isLatest,
          renderer: 'FORM',
          legacy: false,
          schema: version.schema as unknown as FormSchema,
          enabled: form.isActive,
          canRecord:
            form.isActive &&
            isLatest &&
            !!profile &&
            (form.specialtyId === null || form.specialtyId === profile.specialtyId),
        };
      }),
    );

    return [...defined, ...custom];
  }
}
