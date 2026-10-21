import {
  SECTION_CATALOG,
  SECTION_KEYS,
  defaultSections,
  isPlanAllowedForTenantType,
  validateSections,
} from './section-catalog';

describe('section catalog', () => {
  it('gives aesthetic studios their own section without clinical modules', () => {
    const sections = (defaultSections as (...args: any[]) => string[])(
      'CLINIC_PRO',
      'CLINIC',
      'AESTHETIC_STUDIO',
    );
    expect(sections).toEqual(['core.team', 'core.aesthetics']);
  });

  it('rejects medical sections in aesthetic studios and aesthetic sections in clinics', () => {
    const validate = validateSections as (...args: any[]) => string[];
    expect(() => validate(['core.specialties'], 'AESTHETIC_STUDIO')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SECTION_BUSINESS_KIND_MISMATCH' }),
      }),
    );
    expect(() => validate(['core.aesthetics'], 'MEDICAL')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SECTION_BUSINESS_KIND_MISMATCH' }),
      }),
    );
  });
  it('names medical and aesthetic sections', () => {
    expect(SECTION_CATALOG.map((s) => s.name)).toEqual([
      'Calendario',
      'Pacientes',
      'Actividades',
      'Notas clínicas',
      'Módulos clínicos',
      'Facturación',
      'Equipo',
      'Almacenamiento',
      'Estética',
    ]);
  });
  it('preselects everything but tasks and team for a personal trial', () => {
    expect(defaultSections('TRIAL', 'PERSONAL')).toEqual([
      'core.calendar',
      'core.patients',
      'core.clinicalNotes',
      'core.specialties',
      'core.billing',
      'core.storage',
    ]);
  });
  it('adds team for clinics and tasks for paid plans', () => {
    expect(defaultSections('TRIAL', 'CLINIC')).toContain('core.team');
    expect(defaultSections('TRIAL', 'CLINIC')).not.toContain('core.tasks');
    expect(defaultSections('CLINIC_BASIC', 'CLINIC')).toEqual(
      SECTION_KEYS.filter((key) => key !== 'core.aesthetics'),
    );
    expect(defaultSections('PERSONAL_PRO', 'PERSONAL')).not.toContain('core.team');
  });
  it('rejects unknown keys', () => {
    expect(() => validateSections(['core.nope'])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SECTION_UNKNOWN', section: 'core.nope' }),
      }),
    );
  });
  it.each(['core.calendar', 'core.tasks', 'core.clinicalNotes', 'core.specialties'])(
    '%s requires patients',
    (key) => {
      expect(() => validateSections([key])).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'SECTION_DEPENDENCY',
            section: key,
            requires: ['core.patients'],
          }),
        }),
      );
    },
  );
  it('accepts an empty list and removes duplicates', () => {
    expect(validateSections([])).toEqual([]);
    expect(validateSections(['core.billing', 'core.billing'])).toEqual(['core.billing']);
  });
  it('matches plans to tenant types', () => {
    expect(isPlanAllowedForTenantType('TRIAL', 'PERSONAL')).toBe(true);
    expect(isPlanAllowedForTenantType('TRIAL', 'CLINIC')).toBe(true);
    expect(isPlanAllowedForTenantType('PERSONAL_PRO', 'CLINIC')).toBe(false);
    expect(isPlanAllowedForTenantType('CLINIC_ENTERPRISE', 'PERSONAL')).toBe(false);
  });
});
