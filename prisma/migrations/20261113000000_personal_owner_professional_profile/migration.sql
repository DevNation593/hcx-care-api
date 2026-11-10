-- In a personal practice the master is the professional who attends. Practices created before
-- this change gave the master no professional profile, and a personal plan has no team section
-- to add one. Give each of those masters an active profile with a specialty of the practice: the
-- one the master already had as primary, if the practice still has it, or else the oldest one.
WITH owner AS (
  SELECT
    u."id" AS "userId",
    COALESCE(
      (
        SELECT ps."specialtyId"
        FROM "ProfessionalSpecialty" ps
        JOIN "TenantSpecialty" ts
          ON ts."tenantId" = u."tenantId" AND ts."specialtyId" = ps."specialtyId"
        WHERE ps."userId" = u."id"
        ORDER BY ps."isPrimary" DESC, ps."createdAt", ps."specialtyId"
        LIMIT 1
      ),
      (
        SELECT ts."specialtyId"
        FROM "TenantSpecialty" ts
        WHERE ts."tenantId" = u."tenantId"
        ORDER BY ts."createdAt", ts."specialtyId"
        LIMIT 1
      )
    ) AS "specialtyId"
  FROM "User" u
  JOIN "Tenant" t ON t."id" = u."tenantId"
  WHERE u."role" = 'MASTER'
    AND t."tenantType" = 'PERSONAL'
    AND t."isPlatform" = false
    AND NOT EXISTS (SELECT 1 FROM "ProfessionalProfile" p WHERE p."userId" = u."id")
),
created AS (
  INSERT INTO "ProfessionalProfile" ("userId", "specialtyId", "isActive", "createdAt", "updatedAt")
  SELECT "userId", "specialtyId", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM owner
  WHERE "specialtyId" IS NOT NULL
  RETURNING "userId", "specialtyId"
),
demoted AS (
  -- The profile's specialty becomes the only primary one, as UsersService keeps it.
  UPDATE "ProfessionalSpecialty" ps
  SET "isPrimary" = false
  FROM created c
  WHERE ps."userId" = c."userId" AND ps."specialtyId" <> c."specialtyId" AND ps."isPrimary"
  RETURNING ps."userId"
)
INSERT INTO "ProfessionalSpecialty" ("userId", "specialtyId", "isPrimary", "createdAt")
SELECT "userId", "specialtyId", true, CURRENT_TIMESTAMP
FROM created
ON CONFLICT ("userId", "specialtyId") DO UPDATE SET "isPrimary" = true;

-- The stored seat count follows the active profiles, as ProfessionalProfilesService counts them.
UPDATE "TenantSubscription" s
SET "seatsPsychologistsUsed" = (
  SELECT COUNT(*)::int
  FROM "ProfessionalProfile" p
  JOIN "User" u ON u."id" = p."userId"
  WHERE u."tenantId" = s."tenantId" AND p."isActive"
)
FROM "Tenant" t
WHERE t."id" = s."tenantId" AND t."tenantType" = 'PERSONAL' AND t."isPlatform" = false;
