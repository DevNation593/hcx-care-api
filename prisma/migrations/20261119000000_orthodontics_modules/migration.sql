-- The orthodontic modules join dentistry, so the same professional keeps the odontogram and the
-- orthodontic records of a patient.

INSERT INTO "SpecialtyModule" ("id", "specialtyId", "moduleKey", "createdAt")
SELECT 'sm_' || md5(s."id" || ':' || m.module_key), s."id", m.module_key, CURRENT_TIMESTAMP
FROM (VALUES
    ('DENTISTRY', 'dentistry.ortho-assessment'),
    ('DENTISTRY', 'dentistry.ortho-cephalometry'),
    ('DENTISTRY', 'dentistry.ortho-treatment-plan'),
    ('DENTISTRY', 'dentistry.ortho-control')
) AS m(specialty_code, module_key)
JOIN "Specialty" s ON s."code" = m.specialty_code
ON CONFLICT ("specialtyId", "moduleKey") DO NOTHING;

-- Enabled for every clinic that already has dentistry, like any module of it.
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
