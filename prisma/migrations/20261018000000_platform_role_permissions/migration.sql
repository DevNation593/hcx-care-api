CREATE TABLE "TenantRolePermission" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "permission" TEXT NOT NULL,
  "granted" BOOLEAN NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantRolePermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantRolePermission_tenantId_role_permission_key"
  ON "TenantRolePermission"("tenantId", "role", "permission");
CREATE INDEX "TenantRolePermission_tenantId_idx" ON "TenantRolePermission"("tenantId");
ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the most restrictive old setting for each clinic role. Personal grants are deliberately
-- not promoted to every member of the role; the platform administrator can grant them explicitly.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "role", "permission", "granted", "createdAt")
SELECT 'legacy-' || md5(up."tenantId" || ':' || u."role"::text || ':' || up."permission"),
       up."tenantId", u."role", up."permission", FALSE, CURRENT_TIMESTAMP
FROM "UserPermission" up
JOIN "User" u ON u."id" = up."userId" AND u."tenantId" = up."tenantId"
WHERE up."granted" = FALSE AND u."role" IN ('MASTER', 'PROFESIONAL', 'ASISTENTE')
GROUP BY up."tenantId", u."role", up."permission";
