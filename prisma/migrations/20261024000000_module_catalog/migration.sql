-- The eight sections become six modules with submodules. Each clinic keeps what it sees today:
-- every new key takes the state of the section that used to cover it.
WITH old AS (
  SELECT t."id" AS "tenantId",
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.calendar'), false) AS calendar,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.patients'), false) AS patients,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.tasks'), false) AS tasks,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.clinicalNotes'), false) AS notes,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.specialties'), false) AS specialties,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.billing'), false) AS billing,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.team'), false) AS team,
         COALESCE(bool_or(m."enabled") FILTER (WHERE m."moduleKey" = 'core.storage'), false) AS storage
  FROM "Tenant" t
  LEFT JOIN "TenantModule" m ON m."tenantId" = t."id" AND m."moduleKey" LIKE 'core.%'
  WHERE t."isPlatform" = false
  GROUP BY t."id"
),
mapped AS (
  SELECT o."tenantId", k."key",
         CASE k."key"
           WHEN 'core.agenda' THEN o.calendar OR o.tasks
           WHEN 'core.agenda.calendar' THEN o.calendar
           WHEN 'core.agenda.tasks' THEN o.tasks
           WHEN 'core.agenda.notifications' THEN true
           WHEN 'core.patients.records' THEN o.patients
           WHEN 'core.patients.team' THEN o.patients
           WHEN 'core.patients.files' THEN o.storage
           WHEN 'core.clinical' THEN o.notes OR o.specialties
           WHEN 'core.clinical.notes' THEN o.notes
           WHEN 'core.clinical.nextSession' THEN o.notes
           WHEN 'core.clinical.timeline' THEN o.notes
           WHEN 'core.clinical.specialties' THEN o.specialties
           WHEN 'core.clinical.forms' THEN o.specialties
           WHEN 'core.clinical.templates' THEN o.specialties
           WHEN 'core.treatments' THEN o.specialties
           WHEN 'core.treatments.catalog' THEN o.specialties
           WHEN 'core.treatments.sessions' THEN o.specialties
           WHEN 'core.treatments.consents' THEN o.specialties
           WHEN 'core.billing.profiles' THEN o.billing
           WHEN 'core.billing.orders' THEN o.billing
           WHEN 'core.billing.cash' THEN o.billing
           WHEN 'core.billing.invoicing' THEN o.billing
           WHEN 'core.admin' THEN true
           WHEN 'core.admin.team' THEN o.team
           -- Branches had no section: every clinic could manage them.
           WHEN 'core.admin.branches' THEN true
           -- Reports used to follow the calendar section.
           WHEN 'core.admin.reports' THEN o.calendar
         END AS "enabled"
  FROM old o
  CROSS JOIN (VALUES ('core.agenda'), ('core.agenda.calendar'), ('core.agenda.tasks'),
                     ('core.agenda.notifications'), ('core.patients.records'), ('core.patients.team'),
                     ('core.patients.files'), ('core.clinical'), ('core.clinical.notes'),
                     ('core.clinical.nextSession'), ('core.clinical.timeline'),
                     ('core.clinical.specialties'), ('core.clinical.forms'), ('core.clinical.templates'),
                     ('core.treatments'), ('core.treatments.catalog'), ('core.treatments.sessions'),
                     ('core.treatments.consents'), ('core.billing.profiles'), ('core.billing.orders'),
                     ('core.billing.cash'), ('core.billing.invoicing'), ('core.admin'),
                     ('core.admin.team'), ('core.admin.branches'), ('core.admin.reports')) AS k("key")
)
INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "enabled", "createdAt", "updatedAt")
SELECT 'section_' || md5("tenantId" || ':' || "key"), "tenantId", "key", "enabled",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM mapped
ON CONFLICT ("tenantId", "moduleKey") DO NOTHING;

-- core.patients and core.billing keep their rows: they are now the modules of the same name.
DELETE FROM "TenantModule"
WHERE "moduleKey" IN ('core.calendar', 'core.tasks', 'core.clinicalNotes', 'core.specialties',
                      'core.team', 'core.storage');
