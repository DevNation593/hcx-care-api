import { validateFormSchema } from '../../clinical-forms/form-schema';
import {
  isHealthSpecialty,
  latestClinicalModule,
  specialtyModuleKeys,
  validateModuleData,
} from '../clinical-module-registry';
import { PRESCRIBER_SPECIALTY_CODES } from './general';
import { GYNECOLOGY_MODULES } from './gynecology';

const definitionOf = (key: string) => latestClinicalModule(`gynecology.${key}`)!;

/** The issues CLINICAL_RECORD_INVALID reports for a write, or [] when it is accepted. */
function issuesOf(key: string, data: Record<string, unknown>): { field: string }[] {
  try {
    validateModuleData(definitionOf(key), data);
    return [];
  } catch (error) {
    return (error as { response: { details: { field: string }[] } }).response.details;
  }
}

describe('gynecology clinical modules', () => {
  it('belongs to a health specialty that may prescribe', () => {
    expect(isHealthSpecialty('GYNECOLOGY')).toBe(true);
    expect(PRESCRIBER_SPECIALTY_CODES).toContain('GYNECOLOGY');
  });

  it('lists every module the specialty owns', () => {
    expect(specialtyModuleKeys('GYNECOLOGY').sort()).toEqual(
      [
        'gynecology.biopsy',
        'gynecology.colposcopy',
        'gynecology.consultation',
        'gynecology.contraception',
        'gynecology.cytology-hpv',
        'gynecology.fertility',
        'gynecology.gynecologic-history',
        'gynecology.iud-procedure',
        'gynecology.menopause',
        'gynecology.menstrual-history',
        'gynecology.obstetric-history',
        'gynecology.ultrasound',
      ].sort(),
    );
  });

  it('defines valid forms that raise no clinical alert and compute nothing', () => {
    for (const definition of GYNECOLOGY_MODULES) {
      expect(() => validateFormSchema(definition.schema)).not.toThrow();
      expect(definition.schema.alerts ?? []).toEqual([]);
      const fields = definition.schema.sections.flatMap((section) => section.fields);
      expect(fields.filter((field) => field.type === 'calculated')).toEqual([]);
    }
  });

  it('keeps unknown and not applicable answers instead of turning them into a no', () => {
    const data = {
      lmpCertainty: 'DESCONOCIDA',
      cycleRegular: 'DESCONOCIDO',
      intermenstrualBleeding: 'NO_APLICA',
      menopauseStatus: 'NO_EVALUADO',
    };

    expect(validateModuleData(definitionOf('menstrual-history'), data)).toEqual(data);
  });

  it('accepts a menstrual history without a last period date and stores none', () => {
    const stored = validateModuleData(definitionOf('menstrual-history'), { cycleRegular: 'SI' });

    expect(stored).toEqual({ cycleRegular: 'SI' });
    expect(stored).not.toHaveProperty('lastMenstrualPeriodDate');
  });

  it('requires the reason, the assessment and the plan of a consultation', () => {
    expect(issuesOf('consultation', {}).map(({ field }) => field)).toEqual([
      'chiefComplaint',
      'clinicalAssessment',
      'managementPlan',
    ]);
  });

  it('records an exam not performed as such, and refuses a status it does not define', () => {
    const base = {
      chiefComplaint: 'Control',
      clinicalAssessment: 'Sin cambios',
      managementPlan: 'Control',
    };

    expect(
      validateModuleData(definitionOf('consultation'), {
        ...base,
        speculumStatus: 'NO_REALIZADO',
        examNotPerformedReason: 'La paciente prefirió diferirlo',
      }),
    ).toEqual(
      expect.objectContaining({
        speculumStatus: 'NO_REALIZADO',
        examNotPerformedReason: 'La paciente prefirió diferirlo',
      }),
    );
    expect(issuesOf('consultation', { ...base, speculumStatus: 'NORMAL' })).toEqual([
      expect.objectContaining({ field: 'speculumStatus' }),
    ]);
  });

  it('stores one row per previous pregnancy, each with its outcome', () => {
    const data = {
      historyStatus: 'REGISTRADOS',
      pregnancies: [
        { year: 2018, outcome: 'CESAREA', fetuses: 1, liveBirths: 1 },
        { year: 2021, outcome: 'PERDIDA_GESTACIONAL' },
      ],
    };

    expect(validateModuleData(definitionOf('obstetric-history'), data)).toEqual(data);
    expect(issuesOf('obstetric-history', { pregnancies: [{ year: 2020 }] })).toEqual([
      expect.objectContaining({ field: 'pregnancies[0].outcome' }),
    ]);
  });

  it('requires a unit on every ultrasound measurement', () => {
    const base = {
      route: 'TRANSVAGINAL',
      findings: 'Útero en anteversión',
      impression: 'Sin hallazgos',
    };

    expect(
      validateModuleData(definitionOf('ultrasound'), {
        ...base,
        measurements: [{ structure: 'Endometrio', dimension: 'Grosor', value: 6.5, unit: 'MM' }],
      }),
    ).toEqual(expect.objectContaining({ measurements: [expect.objectContaining({ unit: 'MM' })] }));
    expect(
      issuesOf('ultrasound', { ...base, measurements: [{ structure: 'Endometrio', value: 6.5 }] }),
    ).toEqual([expect.objectContaining({ field: 'measurements[0].unit' })]);
  });

  it('keeps a laboratory result as text, with review and communication as separate dates', () => {
    const data = {
      study: 'COTEST',
      sampleDate: '2026-10-01',
      reportReceivedDate: '2026-10-15',
      cytologyResult: 'Texto del reporte tal como lo emite el laboratorio',
    };

    const stored = validateModuleData(definitionOf('cytology-hpv'), data);

    expect(stored).toEqual(data);
    expect(stored).not.toHaveProperty('reviewedOn');
    expect(stored).not.toHaveProperty('patientInformedOn');
  });
});
