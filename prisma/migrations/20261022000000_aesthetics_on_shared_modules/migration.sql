-- Estética becomes a specialty of the catalog and uses the shared modules (patients, appointments,
-- treatments, consents, files). The aesthetic tables and the business kind held no real data.

-- 1. The Estética specialty, offered on every plan.
INSERT INTO "Specialty" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'specialty-aesthetics',
  'AESTHETICS',
  'Estética',
  'Procedimientos estéticos faciales y corporales.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "PlanSpecialty" ("id", "planType", "specialtyId", "createdAt")
SELECT 'plan-aesthetics-' || lower(plan::text), plan, s."id", CURRENT_TIMESTAMP
FROM unnest(enum_range(NULL::"PlanType")) AS plan
CROSS JOIN "Specialty" s
WHERE s."code" = 'AESTHETICS'
ON CONFLICT ("planType", "specialtyId") DO NOTHING;

-- 2. Rows that pointed to the aesthetic section and permissions.
DELETE FROM "TenantModule" WHERE "moduleKey" = 'core.aesthetics';
DELETE FROM "TenantRolePermission" WHERE "permission" LIKE 'aesthetics.%';

-- 3. The aesthetic tables, children first; their row level security policies go with them.
DROP TABLE "AestheticPhoto";
DROP TABLE "AestheticConsent";
DROP TABLE "AestheticSession";
DROP TABLE "AestheticBooking";
DROP TABLE "AestheticService";
DROP TABLE "AestheticClient";
DROP TYPE "AestheticBookingStatus";
DROP TYPE "AestheticPhotoPhase";

-- 4. The business kind.
ALTER TABLE "Tenant" DROP COLUMN "businessKind";
DROP TYPE "TenantBusinessKind";
