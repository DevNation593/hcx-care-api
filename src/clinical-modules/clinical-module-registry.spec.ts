import * as fs from 'fs';
import * as path from 'path';
import { evaluateFormAlerts, validateFormSchema } from '../clinical-forms/form-schema';
import {
  CLINICAL_MODULES,
  clinicalModuleVersions,
  findClinicalModule,
  isHealthSpecialty,
  latestClinicalModule,
  resolveWriteVersion,
  specialtyModuleKeys,
  validateModuleData,
} from './clinical-module-registry';

const current = (moduleKey: string) => latestClinicalModule(moduleKey)!;

describe('clinical module registry', () => {
  it('marks exactly the health-only general modules, in every version', () => {
    const healthOnly = [
      ...new Set(CLINICAL_MODULES.filter((m) => m.healthOnly).map((m) => m.moduleKey)),
    ].sort();
    expect(healthOnly).toEqual([
      'general.certificates',
      'general.diagnoses',
      'general.orders',
      'general.prescriptions',
      'general.referrals',
      'general.soap-note',
      'general.vital-signs',
    ]);
    for (const definition of CLINICAL_MODULES.filter((m) => healthOnly.includes(m.moduleKey))) {
      expect([definition.moduleKey, definition.schemaVersion, definition.healthOnly]).toEqual([
        definition.moduleKey,
        definition.schemaVersion,
        true,
      ]);
    }
  });

  it('treats only AESTHETICS as a non-health specialty', () => {
    expect(isHealthSpecialty('AESTHETICS')).toBe(false);
    expect(isHealthSpecialty('PSYCHOLOGY')).toBe(true);
    expect(isHealthSpecialty('GENERAL_MEDICINE')).toBe(true);
    expect(isHealthSpecialty(null)).toBe(true);
  });

  it('never defines the same version of a module twice and numbers versions without gaps', () => {
    const keys = [...new Set(CLINICAL_MODULES.map((definition) => definition.moduleKey))];

    for (const moduleKey of keys) {
      expect({
        moduleKey,
        versions: clinicalModuleVersions(moduleKey).map(({ schemaVersion }) => schemaVersion),
      }).toEqual({
        moduleKey,
        versions: clinicalModuleVersions(moduleKey).map((_, index) => index + 1),
      });
    }
  });

  it.each(CLINICAL_MODULES.filter((definition) => !definition.legacy))(
    '$moduleKey v$schemaVersion is a well-formed schema',
    (definition) => {
      expect(validateFormSchema(definition.schema)).toEqual(definition.schema);
    },
  );

  it('keeps a legacy version only as version 1 of a module that has a current one', () => {
    for (const definition of CLINICAL_MODULES.filter(({ legacy }) => legacy)) {
      expect(definition.schemaVersion).toBe(1);
      expect(current(definition.moduleKey).legacy).toBeFalsy();
    }
  });

  it('gives general modules no owner and specialty modules their specialty prefix', () => {
    for (const definition of CLINICAL_MODULES) {
      if (definition.scope === 'GENERAL') {
        expect(definition.specialtyCode).toBeNull();
        expect(definition.moduleKey.startsWith('general.')).toBe(true);
      } else {
        expect(definition.moduleKey.startsWith(`${definition.specialtyCode!.toLowerCase()}.`)).toBe(
          true,
        );
      }
    }
  });

  it('lists the modules each specialty owns', () => {
    expect(specialtyModuleKeys('NUTRITION').sort()).toEqual([
      'nutrition.assessments',
      'nutrition.diet-plans',
      'nutrition.food-history',
    ]);
    expect(specialtyModuleKeys('UNKNOWN')).toEqual([]);
  });

  it('has a migration row for every specialty module added after the first catalog', () => {
    const original = [
      'psychology.session-notes',
      'psychology.assessments',
      'nutrition.assessments',
      'nutrition.diet-plans',
      'physiotherapy.evolution',
      'physiotherapy.exercise-plans',
      'dentistry.treatments',
      'dentistry.odontogram',
    ];
    const migrations = path.join(__dirname, '../../prisma/migrations');
    const sql = fs
      .readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => fs.readFileSync(path.join(migrations, entry.name, 'migration.sql'), 'utf8'))
      .join('\n');

    const added = CLINICAL_MODULES.filter(
      ({ scope, moduleKey }) => scope === 'SPECIALTY' && !original.includes(moduleKey),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const { moduleKey, specialtyCode } of added) {
      expect(sql).toContain(`('${specialtyCode}', '${moduleKey}')`);
    }
  });

  describe('resolveWriteVersion', () => {
    it('gives a client that names no version the legacy one when the module has it', () => {
      expect(resolveWriteVersion('nutrition.assessments')).toMatchObject({
        schemaVersion: 1,
        legacy: true,
      });
      expect(resolveWriteVersion('general.vital-signs')).toBe(current('general.vital-signs'));
    });

    it('returns the named version, or nothing when it does not exist', () => {
      expect(resolveWriteVersion('nutrition.assessments', 2)).toBe(
        findClinicalModule('nutrition.assessments', 2),
      );
      expect(resolveWriteVersion('nutrition.assessments', 9)).toBeUndefined();
      expect(resolveWriteVersion('unknown.module')).toBeUndefined();
    });
  });

  describe('validateModuleData', () => {
    it('checks legacy versions only for the presence of their fields', () => {
      const legacy = findClinicalModule('nutrition.assessments', 1)!;
      const data = { weightKg: '70', heightCm: 170, bmi: 24.2, dietaryGoals: 'extra' };

      expect(validateModuleData(legacy, data)).toBe(data);
      expect(() => validateModuleData(legacy, { weightKg: 70, heightCm: '' })).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'CLINICAL_RECORD_INVALID',
            details: [
              { field: 'heightCm', message: 'Este campo es obligatorio' },
              { field: 'bmi', message: 'Este campo es obligatorio' },
            ],
          }),
        }),
      );
    });

    it('computes the BMI on the server', () => {
      expect(
        validateModuleData(current('nutrition.assessments'), {
          weightKg: 70,
          heightCm: 170,
          bmi: 10,
        }),
      ).toEqual({ weightKg: 70, heightCm: 170, bmi: 24.22 });
    });

    it('rejects nutrition measures outside the agreed limits', () => {
      expect(() =>
        validateModuleData(current('nutrition.assessments'), { weightKg: 501, heightCm: 20 }),
      ).toThrow(expect.objectContaining({ status: 422 }));
    });

    it('totals the PHQ-9 and raises its alerts', () => {
      const phq9 = current('psychology.phq9');
      const answers = { q1: 3, q2: 3, q3: 3, q4: 3, q5: 2, q6: 2, q7: 2, q8: 2, q9: 1 };

      const data = validateModuleData(phq9, answers);

      expect(data.total).toBe(21);
      expect(evaluateFormAlerts(phq9.schema, data)).toEqual([
        expect.objectContaining({ level: 'critical', message: expect.stringContaining('ítem 9') }),
        expect.objectContaining({ level: 'critical', message: expect.stringContaining('≥ 20') }),
      ]);
      expect(
        evaluateFormAlerts(
          phq9.schema,
          validateModuleData(phq9, { ...answers, q1: 0, q2: 0, q3: 0, q4: 0, q9: 0 }),
        ),
      ).toEqual([]);
    });

    it('requires every item of the PHQ-9', () => {
      expect(() => validateModuleData(current('psychology.phq9'), { q1: 1 })).toThrow(
        expect.objectContaining({ status: 422 }),
      );
    });

    it('flags critical vital signs and a severe allergy', () => {
      const vitals = current('general.vital-signs');
      expect(
        evaluateFormAlerts(
          vitals.schema,
          validateModuleData(vitals, { oxygenSaturation: 86, systolic: 185, diastolic: 90 }),
        ).map(({ level }) => level),
      ).toEqual(['critical', 'critical']);

      const allergies = current('general.allergies');
      const allergy = { category: 'MEDICAMENTO', allergen: 'Penicilina', reaction: 'Anafilaxia' };
      expect(
        evaluateFormAlerts(
          allergies.schema,
          validateModuleData(allergies, { ...allergy, severity: 'GRAVE' }),
        ),
      ).toEqual([{ level: 'critical', message: 'Alergia grave registrada.' }]);
      expect(
        evaluateFormAlerts(
          allergies.schema,
          validateModuleData(allergies, { ...allergy, severity: 'LEVE' }),
        ),
      ).toEqual([]);
    });

    it('accepts a coded diagnosis and a prescription, and refuses incomplete rows', () => {
      expect(
        validateModuleData(current('general.diagnoses'), {
          diagnoses: [
            {
              system: 'CIE10',
              code: 'F32.1',
              description: 'Episodio depresivo moderado',
              kind: 'PRINCIPAL',
              certainty: 'PRESUNTIVO',
            },
          ],
        }),
      ).toHaveProperty('diagnoses.0.code', 'F32.1');

      expect(() =>
        validateModuleData(current('general.prescriptions'), {
          items: [{ medication: 'Ibuprofeno', dose: '400 mg' }],
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            details: expect.arrayContaining([
              { field: 'items[0].frequency', message: 'Este campo es obligatorio' },
              { field: 'items[0].route', message: 'Este campo es obligatorio' },
              { field: 'items[0].duration', message: 'Este campo es obligatorio' },
            ]),
          }),
        }),
      );
      expect(() => validateModuleData(current('general.diagnoses'), {})).toThrow(
        expect.objectContaining({ status: 422 }),
      );
    });

    it('accepts odontogram findings in FDI notation only', () => {
      const odontogram = current('dentistry.odontogram');

      expect(odontogram.renderer).toBe('ODONTOGRAM');
      expect(
        validateModuleData(odontogram, {
          dentition: 'PERMANENT',
          findings: [{ tooth: '16', surface: 'O', state: 'CARIES' }],
        }),
      ).toEqual({
        dentition: 'PERMANENT',
        findings: [{ tooth: '16', surface: 'O', state: 'CARIES' }],
      });
      expect(() =>
        validateModuleData(odontogram, {
          dentition: 'PERMANENT',
          findings: [{ tooth: '19', surface: 'O', state: 'CARIES' }],
        }),
      ).toThrow(expect.objectContaining({ status: 422 }));
    });
  });
});
