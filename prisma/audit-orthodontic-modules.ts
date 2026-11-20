import { PrismaClient } from '@prisma/client';

/** The modules migration 20261119000000_orthodontics_modules adds to dentistry. */
export const ORTHODONTIC_MODULE_KEYS = [
  'dentistry.ortho-assessment',
  'dentistry.ortho-cephalometry',
  'dentistry.ortho-treatment-plan',
  'dentistry.ortho-control',
] as const;

export interface OrthodonticModulesAudit {
  dentistryInCatalog: boolean;
  /** Orthodontic modules dentistry does not own in SpecialtyModule. */
  missingSpecialtyModules: string[];
  /** Clinics with dentistry that have no TenantModule row for an orthodontic module. */
  missingTenantModules: { tenantId: string; moduleKey: string }[];
}

/**
 * Read-only: what the orthodontic modules migration should have left in place. A clinic that
 * later turned a module off keeps its row with `enabled = false`, which is not a gap.
 */
export async function auditOrthodonticModules(
  client: PrismaClient,
): Promise<OrthodonticModulesAudit> {
  const keys = [...ORTHODONTIC_MODULE_KEYS];
  const dentistry = await client.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Specialty" WHERE "code" = 'DENTISTRY'
  `;
  const missingSpecialtyModules = await client.$queryRaw<{ moduleKey: string }[]>`
    SELECT k."moduleKey"
    FROM unnest(${keys}::text[]) AS k("moduleKey")
    WHERE NOT EXISTS (
      SELECT 1 FROM "SpecialtyModule" sm
      JOIN "Specialty" s ON s."id" = sm."specialtyId"
      WHERE s."code" = 'DENTISTRY' AND sm."moduleKey" = k."moduleKey"
    )
    ORDER BY k."moduleKey"
  `;
  const missingTenantModules = await client.$queryRaw<{ tenantId: string; moduleKey: string }[]>`
    SELECT ts."tenantId", k."moduleKey"
    FROM "TenantSpecialty" ts
    JOIN "Specialty" s ON s."id" = ts."specialtyId" AND s."code" = 'DENTISTRY'
    CROSS JOIN unnest(${keys}::text[]) AS k("moduleKey")
    WHERE NOT EXISTS (
      SELECT 1 FROM "TenantModule" tm
      WHERE tm."tenantId" = ts."tenantId" AND tm."moduleKey" = k."moduleKey"
    )
    ORDER BY ts."tenantId", k."moduleKey"
  `;

  return {
    dentistryInCatalog: dentistry.length > 0,
    missingSpecialtyModules: missingSpecialtyModules.map(({ moduleKey }) => moduleKey),
    missingTenantModules,
  };
}

export function hasGaps(audit: OrthodonticModulesAudit): boolean {
  return (
    !audit.dentistryInCatalog ||
    audit.missingSpecialtyModules.length > 0 ||
    audit.missingTenantModules.length > 0
  );
}

if (require.main === module) {
  const client = new PrismaClient();
  auditOrthodonticModules(client)
    .then((audit) => {
      console.log(JSON.stringify(audit, null, 2));
      if (hasGaps(audit)) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => client.$disconnect());
}
