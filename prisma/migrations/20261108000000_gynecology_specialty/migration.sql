-- Ginecología joins the specialty catalog with its clinical modules. Every plan offers any
-- active specialty, so it is available to new and existing clinics as soon as this runs; no
-- clinic has it yet, so no TenantModule rows are needed.

INSERT INTO "Specialty" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'specialty-gynecology',
  'GYNECOLOGY',
  'Ginecología',
  'Consulta ginecológica, antecedentes gineco-obstétricos, anticoncepción, tamizaje y procedimientos.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "SpecialtyModule" ("id", "specialtyId", "moduleKey", "createdAt")
SELECT 'sm_' || md5(s."id" || ':' || m.module_key), s."id", m.module_key, CURRENT_TIMESTAMP
FROM (VALUES
    ('GYNECOLOGY', 'gynecology.consultation'),
    ('GYNECOLOGY', 'gynecology.menstrual-history'),
    ('GYNECOLOGY', 'gynecology.gynecologic-history'),
    ('GYNECOLOGY', 'gynecology.obstetric-history'),
    ('GYNECOLOGY', 'gynecology.contraception'),
    ('GYNECOLOGY', 'gynecology.iud-procedure'),
    ('GYNECOLOGY', 'gynecology.cytology-hpv'),
    ('GYNECOLOGY', 'gynecology.colposcopy'),
    ('GYNECOLOGY', 'gynecology.ultrasound'),
    ('GYNECOLOGY', 'gynecology.biopsy'),
    ('GYNECOLOGY', 'gynecology.menopause'),
    ('GYNECOLOGY', 'gynecology.fertility')
) AS m(specialty_code, module_key)
JOIN "Specialty" s ON s."code" = m.specialty_code
ON CONFLICT ("specialtyId", "moduleKey") DO NOTHING;
