import { validateFormSchema } from '../../clinical-forms/form-schema';
import {
  latestClinicalModule,
  specialtyModuleKeys,
  validateModuleData,
} from '../clinical-module-registry';
import { ORTHODONTICS_MODULES } from './orthodontics';

const definitionOf = (key: string) => latestClinicalModule(`dentistry.ortho-${key}`)!;

/** The issues CLINICAL_RECORD_INVALID reports for a write, or [] when it is accepted. */
function issuesOf(key: string, data: Record<string, unknown>): { field: string }[] {
  try {
    validateModuleData(definitionOf(key), data);
    return [];
  } catch (error) {
    return (error as { response: { details: { field: string }[] } }).response.details;
  }
}

const fields = (issues: { field: string }[]) => issues.map(({ field }) => field);

describe('orthodontic clinical modules', () => {
  it('lists the orthodontic modules among those dentistry owns', () => {
    expect(specialtyModuleKeys('DENTISTRY').sort()).toEqual([
      'dentistry.evolution',
      'dentistry.odontogram',
      'dentistry.ortho-assessment',
      'dentistry.ortho-cephalometry',
      'dentistry.ortho-control',
      'dentistry.ortho-treatment-plan',
      'dentistry.treatments',
    ]);
  });

  it('defines valid forms that raise no clinical alert and compute nothing', () => {
    expect(ORTHODONTICS_MODULES).toHaveLength(4);
    for (const definition of ORTHODONTICS_MODULES) {
      expect(definition.specialtyCode).toBe('DENTISTRY');
      expect(definition.schemaVersion).toBe(1);
      expect(() => validateFormSchema(definition.schema)).not.toThrow();
      expect(definition.schema.alerts ?? []).toEqual([]);
      const all = definition.schema.sections.flatMap((section) => section.fields);
      expect(all.filter((field) => field.type === 'calculated')).toEqual([]);
    }
  });

  it('requires the reason and the diagnosis of an assessment', () => {
    expect(fields(issuesOf('assessment', {}))).toEqual(['chiefComplaint', 'orthodonticDiagnosis']);
  });

  it('requires what each other module cannot exist without', () => {
    expect(fields(issuesOf('cephalometry', {}))).toEqual(['professionalInterpretation']);
    expect(fields(issuesOf('treatment-plan', {}))).toEqual(['treatmentGoals', 'appliance']);
    expect(fields(issuesOf('control', {}))).toEqual(['visitType', 'procedurePerformed']);
  });

  describe('assessment', () => {
    const base = { chiefComplaint: 'Apiñamiento', orthodonticDiagnosis: 'Clase II división 1' };

    it('keeps a class that could not be assessed and refuses one it does not define', () => {
      const data = { ...base, molarClassRight: 'NO_EVALUABLE', facialProfile: 'NO_EVALUADO' };

      expect(validateModuleData(definitionOf('assessment'), data)).toEqual(data);
      expect(issuesOf('assessment', { ...base, molarClassRight: 'NORMAL' })).toEqual([
        expect.objectContaining({ field: 'molarClassRight' }),
      ]);
    });

    it('accepts a negative overjet and overbite and refuses one out of range', () => {
      const data = { ...base, overjetMm: -2.5, overbiteMm: -1 };

      expect(validateModuleData(definitionOf('assessment'), data)).toEqual(data);
      expect(issuesOf('assessment', { ...base, overjetMm: 25 })).toEqual([
        expect.objectContaining({ field: 'overjetMm' }),
      ]);
    });
  });

  it('accepts primary teeth in mixed dentition and refuses a tooth that does not exist', () => {
    const control = { visitType: 'RECEMENTADO', procedurePerformed: 'Recementado' };
    const debonded = { ...control, debondedBrackets: ['11', '55', '85'] };
    const plan = {
      treatmentGoals: 'Corregir el resalte',
      appliance: 'FIJA_METALICA',
      extractionTeeth: ['14', '24', '75'],
    };

    expect(validateModuleData(definitionOf('control'), debonded)).toEqual(debonded);
    expect(validateModuleData(definitionOf('treatment-plan'), plan)).toEqual(plan);
    expect(issuesOf('control', { ...control, debondedBrackets: ['99'] })).toEqual([
      expect.objectContaining({ field: 'debondedBrackets' }),
    ]);
  });

  it('keeps cephalometric values as transcribed and requires each value', () => {
    const base = { professionalInterpretation: 'Clase II esquelética' };
    const data = { ...base, measurements: [{ measure: 'ANB', value: 5.5, unit: '°' }] };

    expect(validateModuleData(definitionOf('cephalometry'), data)).toEqual(data);
    expect(
      issuesOf('cephalometry', { ...base, measurements: [{ measure: 'SNA', unit: '°' }] }),
    ).toEqual([expect.objectContaining({ field: 'measurements[0].value' })]);
  });

  it('records a routine control and an observation visit', () => {
    for (const visitType of ['CONTROL', 'OBSERVACION']) {
      const data = { visitType, procedurePerformed: 'Revisión del avance' };
      expect(validateModuleData(definitionOf('control'), data)).toEqual(data);
    }
  });

  it('records the terminal plane of a primary dentition', () => {
    const data = {
      chiefComplaint: 'Control de crecimiento',
      orthodonticDiagnosis: 'Dentición temporal en observación',
      dentition: 'TEMPORAL',
      molarClassRight: 'NO_EVALUABLE',
      terminalPlaneRight: 'ESCALON_MESIAL',
      terminalPlaneLeft: 'NO_EVALUABLE',
    };

    expect(validateModuleData(definitionOf('assessment'), data)).toEqual(data);
  });

  it('keeps a class II division that could not be assessed', () => {
    const data = {
      chiefComplaint: 'Resalte',
      orthodonticDiagnosis: 'Clase II',
      classIIDivision: 'NO_EVALUADA',
    };

    expect(validateModuleData(definitionOf('assessment'), data)).toEqual(data);
  });

  it('does not compare the current aligner with the total', () => {
    const data = {
      visitType: 'CONTROL',
      procedurePerformed: 'Entrega de alineadores',
      currentAligner: 30,
      totalAligners: 20,
    };

    expect(validateModuleData(definitionOf('control'), data)).toEqual(data);
  });
});
