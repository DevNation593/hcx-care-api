-- The main code (código principal) a treatment carries on its invoice lines.
ALTER TABLE "Treatment" ADD COLUMN "code" TEXT;

-- Existing treatments get TRAT-001, TRAT-002... per clinic in creation order; the clinic can
-- replace them from the catalog.
UPDATE "Treatment" t
SET "code" = 'TRAT-' || lpad(s.n::text, greatest(3, length(s.n::text)), '0')
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS n
  FROM "Treatment"
) s
WHERE s."id" = t."id";

ALTER TABLE "Treatment" ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX "Treatment_tenantId_code_key" ON "Treatment"("tenantId", "code");
