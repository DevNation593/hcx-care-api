-- The orthodontic modules join dentistry, so the same professional keeps the odontogram and the
-- orthodontic records of a patient. No clinic uses the platform yet, so no TenantModule rows are
-- needed: a clinic that enables dentistry gets them like any other module of the specialty.

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
