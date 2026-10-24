import {
  SECTION_CATALOG,
  SECTION_KEYS,
  isSectionInEffect,
  validateSections,
} from './section-catalog';

const MODULES = [
  'core.agenda',
  'core.patients',
  'core.clinical',
  'core.treatments',
  'core.billing',
  'core.admin',
];

describe('section catalog', () => {
  it('names the six modules', () => {
    expect(SECTION_CATALOG.filter((s) => !s.parent).map((s) => s.name)).toEqual([
      'Agenda',
      'Pacientes',
      'Clínico',
      'Tratamientos',
      'Facturación',
      'Administración',
    ]);
  });
  it('hangs every submodule from the module its key starts with', () => {
    for (const section of SECTION_CATALOG) {
      if (MODULES.includes(section.key)) {
        expect(section.parent).toBeUndefined();
      } else {
        expect(section.parent).toBe(section.key.split('.').slice(0, 2).join('.'));
      }
    }
  });
  it('makes every requirement a submodule of the catalog', () => {
    for (const section of SECTION_CATALOG) {
      for (const required of section.requires) {
        expect(SECTION_KEYS).toContain(required);
        expect(MODULES).not.toContain(required);
      }
    }
  });
  it('rejects unknown keys and the retired section keys', () => {
    for (const key of ['core.nope', 'core.calendar', 'core.storage', 'core.aesthetics']) {
      expect(() => validateSections(['core.admin', key])).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SECTION_UNKNOWN', section: key }),
        }),
      );
    }
  });
  it.each([
    ['core.agenda', 'core.agenda.calendar'],
    ['core.agenda', 'core.agenda.tasks'],
    ['core.clinical', 'core.clinical.notes'],
    ['core.clinical', 'core.clinical.specialties'],
    ['core.patients', 'core.patients.files'],
  ])('%s → %s requires patient records', (module, key) => {
    expect(() => validateSections([module, key])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'SECTION_DEPENDENCY',
          section: key,
          requires: ['core.patients.records'],
        }),
      }),
    );
  });
  it('counts a requirement under a module turned off as missing', () => {
    expect(() =>
      validateSections(['core.agenda', 'core.agenda.calendar', 'core.patients.records']),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'SECTION_DEPENDENCY',
          section: 'core.agenda.calendar',
        }),
      }),
    );
  });
  it('keeps submodules of a module turned off without checking them', () => {
    expect(validateSections(['core.billing.cash', 'core.billing.invoicing'])).toEqual([
      'core.billing.cash',
      'core.billing.invoicing',
    ]);
  });
  it('accepts the whole catalog', () => {
    expect(validateSections([...SECTION_KEYS])).toEqual([...SECTION_KEYS]);
  });
  it('accepts an empty list, removes duplicates and keeps catalog order', () => {
    expect(validateSections([])).toEqual([]);
    expect(validateSections(['core.billing', 'core.billing'])).toEqual(['core.billing']);
    expect(validateSections(['core.admin.team', 'core.admin'])).toEqual([
      'core.admin',
      'core.admin.team',
    ]);
  });
  it('puts a submodule in effect only when its module is on too', () => {
    expect(isSectionInEffect('core.billing.cash', new Set(['core.billing.cash']))).toBe(false);
    expect(
      isSectionInEffect('core.billing.cash', new Set(['core.billing', 'core.billing.cash'])),
    ).toBe(true);
    expect(isSectionInEffect('core.billing', new Set(['core.billing']))).toBe(true);
  });
  it('marks notes, next session and timeline as health-only', () => {
    expect(SECTION_CATALOG.filter((s) => s.healthOnly).map((s) => s.key)).toEqual([
      'core.clinical.notes',
      'core.clinical.nextSession',
      'core.clinical.timeline',
    ]);
  });
});
