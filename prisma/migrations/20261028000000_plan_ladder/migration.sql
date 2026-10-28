-- The plan ladder: Esencial, Profesional, Centro and Clínica replace the first four plans, and a
-- plan now sets how many branches a clinic can have active. Clinics on the first plans keep them
-- as they are, with the same branch allowance they had (one for a personal practice, 50 for a
-- clinic); those plans are archived so new clinics get the ladder.

ALTER TABLE "Plan" ADD COLUMN "maxBranches" INTEGER NOT NULL DEFAULT 1;
UPDATE "Plan" SET "maxBranches" = 50 WHERE "tenantType" = 'CLINIC';
ALTER TABLE "Plan" ALTER COLUMN "maxBranches" DROP DEFAULT;

ALTER TABLE "TenantSubscription" ADD COLUMN "maxBranches" INTEGER NOT NULL DEFAULT 1;
UPDATE "TenantSubscription" s
SET "maxBranches" = p."maxBranches"
FROM "Plan" p
WHERE p."id" = s."planId";

UPDATE "Plan"
SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN ('plan_personal_basic', 'plan_personal_pro', 'plan_clinic_basic', 'plan_clinic_pro')
  AND "archivedAt" IS NULL;

-- The custom plan closes the ladder: it keeps its code and clinics, and allows at least as many
-- invoices as the plan below it. A name or limit the administrator already changed is kept.
UPDATE "Plan"
SET "name" = 'Personalizado', "description" = 'Redes de clínicas con necesidades a medida.'
WHERE "id" = 'plan_clinic_enterprise' AND "name" = 'Clínica Personalizado';

UPDATE "Plan"
SET "monthlyElectronicInvoicesLimit" = 3000, "sortOrder" = 100, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'plan_clinic_enterprise' AND "monthlyElectronicInvoicesLimit" < 3000;

UPDATE "TenantSubscription" s
SET "monthlyElectronicInvoicesLimit" = p."monthlyElectronicInvoicesLimit"
FROM "Plan" p
WHERE p."id" = s."planId"
  AND p."id" = 'plan_clinic_enterprise'
  AND NOT ('monthlyElectronicInvoicesLimit' = ANY(s."overriddenFields"));

-- USD a month before VAT (src/plans/default-plans.ts keeps the same values). A code the
-- administrator already used is left alone.
INSERT INTO "Plan" ("id", "code", "name", "description", "tenantType", "sortOrder",
                    "basePrice", "pricePerSeat", "specialtyPrice", "seatsIncluded", "maxActivePatients",
                    "storageGB", "monthlyElectronicInvoicesLimit", "includedSpecialties", "maxBranches",
                    "trialDays", "updatedAt")
VALUES
  ('plan_esencial', 'ESENCIAL', 'Esencial', 'Consultorios independientes.', 'PERSONAL', 60, 24.90, 0, 10, 1, 100, 3, 30, 1, 1, 14, CURRENT_TIMESTAMP),
  ('plan_profesional', 'PROFESIONAL', 'Profesional', 'Consultorios con equipo.', 'CLINIC', 70, 44.90, 14, 10, 3, 300, 10, 100, 2, 1, 14, CURRENT_TIMESTAMP),
  ('plan_centro', 'CENTRO', 'Centro', 'Centros multiespecialidad.', 'CLINIC', 80, 79.90, 12, 10, 6, 600, 25, 300, 3, 2, 14, CURRENT_TIMESTAMP),
  ('plan_clinica', 'CLINICA', 'Clínica', 'Clínicas pequeñas y medianas.', 'CLINIC', 90, 149.90, 10, 10, 15, 1500, 60, 1000, 5, 5, 14, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

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
                   ('core.billing.inventory'), ('core.admin'), ('core.admin.team'),
                   ('core.admin.branches'), ('core.admin.reports')) AS k("key")
WHERE p."id" IN ('plan_esencial', 'plan_profesional', 'plan_centro', 'plan_clinica')
  AND NOT (p."tenantType" = 'PERSONAL' AND k."key" = 'core.admin.team')
ON CONFLICT DO NOTHING;
