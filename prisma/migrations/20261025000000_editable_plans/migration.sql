-- Plans move from code to the database, where the platform administrator edits them. Every
-- clinic keeps what it has today: whatever differs from its plan becomes an override.

CREATE TYPE "ModuleSource" AS ENUM ('PLAN', 'OVERRIDE');

-- Plan edits are audited on the platform tenant.
ALTER TYPE "AuditEntity" ADD VALUE 'PLAN' BEFORE 'CLINICAL_NOTE';

CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tenantType" "TenantType" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "basePrice" DECIMAL(10,2) NOT NULL,
    "pricePerSeat" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "specialtyPrice" DECIMAL(10,2) NOT NULL DEFAULT 15,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "seatsIncluded" INTEGER NOT NULL,
    "maxActivePatients" INTEGER NOT NULL,
    "storageGB" INTEGER NOT NULL,
    "monthlyElectronicInvoicesLimit" INTEGER NOT NULL,
    "includedSpecialties" INTEGER NOT NULL,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanModule" (
    "planId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,

    CONSTRAINT "PlanModule_pkey" PRIMARY KEY ("planId","moduleKey")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
CREATE INDEX "Plan_tenantType_archivedAt_idx" ON "Plan"("tenantType", "archivedAt");
ALTER TABLE "PlanModule" ADD CONSTRAINT "PlanModule_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The plans the code defined until now (src/plans/default-plans.ts keeps the same values).
INSERT INTO "Plan" ("id", "code", "name", "description", "tenantType", "sortOrder",
                    "basePrice", "pricePerSeat", "specialtyPrice", "seatsIncluded", "maxActivePatients",
                    "storageGB", "monthlyElectronicInvoicesLimit", "includedSpecialties", "trialDays", "updatedAt")
VALUES
  ('plan_personal_basic', 'PERSONAL_BASIC', 'Personal Básico', 'Para un profesional independiente.', 'PERSONAL', 10, 29, 0, 15, 1, 50, 2, 50, 1, 14, CURRENT_TIMESTAMP),
  ('plan_personal_pro', 'PERSONAL_PRO', 'Personal Pro', 'Para una consulta individual en crecimiento.', 'PERSONAL', 20, 59, 0, 15, 1, 200, 5, 50, 2, 14, CURRENT_TIMESTAMP),
  ('plan_clinic_basic', 'CLINIC_BASIC', 'Clínica Básico', 'Para equipos pequeños.', 'CLINIC', 30, 99, 15, 15, 3, 150, 10, 50, 2, 14, CURRENT_TIMESTAMP),
  ('plan_clinic_pro', 'CLINIC_PRO', 'Clínica Pro', 'Para clínicas con varias especialidades.', 'CLINIC', 40, 199, 12, 15, 10, 500, 25, 50, 3, 14, CURRENT_TIMESTAMP),
  ('plan_clinic_enterprise', 'CLINIC_ENTERPRISE', 'Clínica Personalizado', 'Para redes de clínicas con necesidades a medida.', 'CLINIC', 50, 0, 0, 15, 999, 999999, 100, 50, 999, 0, CURRENT_TIMESTAMP);

-- Every module of the catalog; a personal practice has no team to manage.
INSERT INTO "PlanModule" ("planId", "moduleKey")
SELECT p."id", k."key"
FROM "Plan" p
CROSS JOIN (VALUES ('core.agenda'), ('core.agenda.calendar'), ('core.agenda.tasks'),
                   ('core.agenda.notifications'), ('core.patients'), ('core.patients.records'),
                   ('core.patients.team'), ('core.patients.files'), ('core.clinical'),
                   ('core.clinical.notes'), ('core.clinical.nextSession'), ('core.clinical.timeline'),
                   ('core.clinical.specialties'), ('core.clinical.forms'), ('core.clinical.templates'),
                   ('core.treatments'), ('core.treatments.catalog'), ('core.treatments.sessions'),
                   ('core.treatments.consents'), ('core.billing'), ('core.billing.profiles'),
                   ('core.billing.orders'), ('core.billing.cash'), ('core.billing.invoicing'),
                   ('core.admin'), ('core.admin.team'), ('core.admin.branches'),
                   ('core.admin.reports')) AS k("key")
WHERE NOT (p."tenantType" = 'PERSONAL' AND k."key" = 'core.admin.team');

-- Subscriptions point at their plan. A trial becomes days of trial on the basic plan of its type.
ALTER TABLE "TenantSubscription" ADD COLUMN "planId" TEXT,
ADD COLUMN "overriddenFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "TenantSubscription" s
SET "planId" = CASE
  WHEN s."planType" = 'TRIAL' THEN
    CASE t."tenantType" WHEN 'CLINIC' THEN 'plan_clinic_basic' ELSE 'plan_personal_basic' END
  ELSE 'plan_' || lower(s."planType"::text)
END
FROM "Tenant" t
WHERE t."id" = s."tenantId";

-- basePrice held the monthly total: plan, add-ons bought and extra specialties. It now holds the
-- plan price alone; extra specialties are added when charging, so the total does not change.
UPDATE "TenantSubscription" s
SET "basePrice" = GREATEST(0, s."basePrice" - GREATEST(0, (
  SELECT count(*) FROM "TenantSpecialty" ts WHERE ts."tenantId" = s."tenantId"
) - s."includedSpecialties") * s."specialtyPrice")
WHERE s."planType" <> 'TRIAL';

-- A trial runs on its plan as it is.
UPDATE "TenantSubscription" s
SET "basePrice" = p."basePrice",
    "pricePerSeat" = p."pricePerSeat",
    "specialtyPrice" = p."specialtyPrice",
    "currency" = p."currency",
    "seatsPsychologistsMax" = p."seatsIncluded",
    "maxActivePatients" = p."maxActivePatients",
    "storageGB" = p."storageGB",
    "monthlyElectronicInvoicesLimit" = p."monthlyElectronicInvoicesLimit",
    "includedSpecialties" = p."includedSpecialties"
FROM "Plan" p
WHERE p."id" = s."planId" AND s."planType" = 'TRIAL';

-- What a clinic has apart from its plan (custom limits, add-ons in the price) stays as an override.
UPDATE "TenantSubscription" s
SET "overriddenFields" = array_remove(ARRAY[
  CASE WHEN s."basePrice" <> p."basePrice" THEN 'basePrice' END,
  CASE WHEN s."pricePerSeat" <> p."pricePerSeat" THEN 'pricePerSeat' END,
  CASE WHEN s."specialtyPrice" <> p."specialtyPrice" THEN 'specialtyPrice' END,
  CASE WHEN s."currency" <> p."currency" THEN 'currency' END,
  CASE WHEN s."seatsPsychologistsMax" <> p."seatsIncluded" THEN 'seatsPsychologistsMax' END,
  CASE WHEN s."maxActivePatients" <> p."maxActivePatients" THEN 'maxActivePatients' END,
  CASE WHEN s."storageGB" <> p."storageGB" THEN 'storageGB' END,
  CASE WHEN s."monthlyElectronicInvoicesLimit" <> p."monthlyElectronicInvoicesLimit" THEN 'monthlyElectronicInvoicesLimit' END,
  CASE WHEN s."includedSpecialties" <> p."includedSpecialties" THEN 'includedSpecialties' END
]::TEXT[], NULL)
FROM "Plan" p
WHERE p."id" = s."planId";

ALTER TABLE "TenantSubscription" ALTER COLUMN "planId" SET NOT NULL;
CREATE INDEX "TenantSubscription_planId_idx" ON "TenantSubscription"("planId");
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A clinic's module row follows its plan unless it differs from what the plan gives it. Clinics
-- whose specialties are all aesthetic get the health-only submodules off from their plan.
ALTER TABLE "TenantModule" ADD COLUMN "source" "ModuleSource" NOT NULL DEFAULT 'PLAN';

UPDATE "TenantModule" m
SET "source" = 'OVERRIDE'
FROM "TenantSubscription" s
WHERE s."tenantId" = m."tenantId"
  AND m."moduleKey" LIKE 'core.%'
  AND m."enabled" <> (
    EXISTS (SELECT 1 FROM "PlanModule" pm WHERE pm."planId" = s."planId" AND pm."moduleKey" = m."moduleKey")
    AND (
      m."moduleKey" NOT IN ('core.clinical.notes', 'core.clinical.nextSession', 'core.clinical.timeline')
      OR NOT EXISTS (SELECT 1 FROM "TenantSpecialty" ts WHERE ts."tenantId" = m."tenantId")
      OR EXISTS (
        SELECT 1 FROM "TenantSpecialty" ts JOIN "Specialty" sp ON sp."id" = ts."specialtyId"
        WHERE ts."tenantId" = m."tenantId" AND sp."code" <> 'AESTHETICS'
      )
    )
  );

-- Payments name the plan they charged for, as it was called then.
ALTER TABLE "SubscriptionPayment" ADD COLUMN "planId" TEXT,
ADD COLUMN "planName" TEXT;

UPDATE "SubscriptionPayment" sp
SET "planId" = p."id", "planName" = p."name"
FROM "Plan" p
WHERE p."code" = sp."targetPlan"::text;

UPDATE "SubscriptionPayment" SET "planName" = 'Prueba' WHERE "planName" IS NULL;

-- Clinics no longer upgrade themselves: a request still waiting for payment cannot be applied.
UPDATE "SubscriptionPayment"
SET "status" = 'CANCELED', "resolvedAt" = CURRENT_TIMESTAMP,
    "resolutionNote" = 'Los planes ahora los asigna la plataforma'
WHERE "kind" = 'PLAN_UPGRADE' AND "status" = 'PENDING';

ALTER TABLE "SubscriptionPayment" ALTER COLUMN "planName" SET NOT NULL,
DROP COLUMN "targetPlan";
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Events keep the plan codes they recorded.
ALTER TABLE "SubscriptionEvent" ALTER COLUMN "previousPlan" TYPE TEXT USING "previousPlan"::text,
ALTER COLUMN "newPlan" TYPE TEXT USING "newPlan"::text;

-- Feature flags and self-service plan changes are gone: modules come from the plan.
ALTER TABLE "TenantSubscription" DROP COLUMN "featureAPIAccess",
DROP COLUMN "featureAdvancedAnalytics",
DROP COLUMN "featureAttachments",
DROP COLUMN "featureCalendarSync",
DROP COLUMN "featureClinicalNotes",
DROP COLUMN "featureClinicalNotesEncryption",
DROP COLUMN "featureCustomReports",
DROP COLUMN "featureFCMPush",
DROP COLUMN "featureOnlineSchedulingWidget",
DROP COLUMN "featurePsychologicalTests",
DROP COLUMN "featureSSO",
DROP COLUMN "featureTasks",
DROP COLUMN "featureVideoConsultation",
DROP COLUMN "featureWebPush",
DROP COLUMN "featureWhatsAppIntegration",
DROP COLUMN "planType",
DROP COLUMN "scheduledPlanChange",
DROP COLUMN "scheduledPlanChangeAt";

ALTER TABLE "PlanSpecialty" DROP CONSTRAINT "PlanSpecialty_specialtyId_fkey";
DROP TABLE "PlanSpecialty";
DROP TYPE "PlanType";
