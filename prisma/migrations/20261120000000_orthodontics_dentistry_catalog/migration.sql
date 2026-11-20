-- 20261119000000_orthodontics_modules links the orthodontic modules to DENTISTRY through a JOIN,
-- so on a catalog without dentistry it finished without linking anything. Dentistry joins the
-- catalog here when it is not there yet (an existing row is left as it is, inactive included),
-- owning every dentistry module, the general ones included: a clinic that selects it gets only
-- the modules linked here, and could not turn the others on by hand. The links of the earlier
-- migration are made again for the clinics that already have dentistry. Every insert is
-- idempotent: on a database where everything was already linked, nothing changes.

INSERT INTO "Specialty" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'specialty-dentistry',
  'DENTISTRY',
  'Odontología',
  'Prevención y atención odontológica.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "SpecialtyModule" ("id", "specialtyId", "moduleKey", "createdAt")
SELECT 'sm_' || md5(s."id" || ':' || m.module_key), s."id", m.module_key, CURRENT_TIMESTAMP
FROM (VALUES
    ('DENTISTRY', 'dentistry.odontogram'),
    ('DENTISTRY', 'dentistry.treatments'),
    ('DENTISTRY', 'dentistry.evolution'),
    ('DENTISTRY', 'dentistry.ortho-assessment'),
    ('DENTISTRY', 'dentistry.ortho-cephalometry'),
    ('DENTISTRY', 'dentistry.ortho-treatment-plan'),
    ('DENTISTRY', 'dentistry.ortho-control')
) AS m(specialty_code, module_key)
JOIN "Specialty" s ON s."code" = m.specialty_code
ON CONFLICT ("specialtyId", "moduleKey") DO NOTHING;

INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "enabled", "createdAt", "updatedAt")
SELECT 'tm_' || md5(ts."tenantId" || ':' || sm."moduleKey"), ts."tenantId", sm."moduleKey", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "TenantSpecialty" ts
JOIN "SpecialtyModule" sm ON sm."specialtyId" = ts."specialtyId"
WHERE sm."moduleKey" IN (
    'dentistry.ortho-assessment',
    'dentistry.ortho-cephalometry',
    'dentistry.ortho-treatment-plan',
    'dentistry.ortho-control'
)
ON CONFLICT ("tenantId", "moduleKey") DO NOTHING;
