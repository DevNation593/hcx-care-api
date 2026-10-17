import { BadRequestException } from '@nestjs/common';
import { DEFAULT_REQUIREMENTS, parseTreatmentRequirements } from './treatment-requirements';

const FULL = {
  medicalForm: { required: true },
  informedConsent: { required: true, validityDays: 365 },
  photos: { minimumBefore: 2, minimumAfter: 3 },
  clinicalNotes: { requiredForCompletion: true },
};

function invalid(raw: unknown) {
  try {
    parseTreatmentRequirements(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as {
      statusCode: number;
      code: string;
      message: string;
      issues: string[];
    };
  }
  throw new Error('expected parseTreatmentRequirements to throw');
}

describe('parseTreatmentRequirements', () => {
  it('returns the defaults for an empty object', () => {
    expect(parseTreatmentRequirements({})).toEqual(DEFAULT_REQUIREMENTS);
    expect(DEFAULT_REQUIREMENTS).toEqual({
      medicalForm: { required: false },
      informedConsent: { required: false, validityDays: null },
      photos: { minimumBefore: 0, minimumAfter: 0 },
      clinicalNotes: { requiredForCompletion: false },
    });
  });

  it('round-trips a full policy', () => {
    expect(parseTreatmentRequirements(FULL)).toEqual(FULL);
  });

  it('fills missing keys with the defaults', () => {
    expect(parseTreatmentRequirements({ photos: { minimumBefore: 1 } })).toEqual({
      ...DEFAULT_REQUIREMENTS,
      photos: { minimumBefore: 1, minimumAfter: 0 },
    });
  });

  it('accepts the boundaries', () => {
    const parsed = parseTreatmentRequirements({
      informedConsent: { validityDays: 3650 },
      photos: { minimumBefore: 0, minimumAfter: 20 },
    });
    expect(parsed.informedConsent.validityDays).toBe(3650);
    expect(parsed.photos).toEqual({ minimumBefore: 0, minimumAfter: 20 });
    expect(
      parseTreatmentRequirements({ informedConsent: { validityDays: 1 } }).informedConsent
        .validityDays,
    ).toBe(1);
  });

  it.each([
    ['an unknown top-level key', { foo: 1 }, 'foo'],
    ['an unknown nested key', { photos: { minimumBefore: 1, extra: 2 } }, 'photos.extra'],
    ['validityDays 0', { informedConsent: { validityDays: 0 } }, 'informedConsent.validityDays'],
    [
      'validityDays 3651',
      { informedConsent: { validityDays: 3651 } },
      'informedConsent.validityDays',
    ],
    ['minimumBefore 21', { photos: { minimumBefore: 21 } }, 'photos.minimumBefore'],
    ['minimumBefore -1', { photos: { minimumBefore: -1 } }, 'photos.minimumBefore'],
    ['minimumBefore 1.5', { photos: { minimumBefore: 1.5 } }, 'photos.minimumBefore'],
    ['minimumAfter 21', { photos: { minimumAfter: 21 } }, 'photos.minimumAfter'],
    ['required as a string', { medicalForm: { required: 'yes' } }, 'medicalForm.required'],
    [
      'requiredForCompletion as a number',
      { clinicalNotes: { requiredForCompletion: 1 } },
      'clinicalNotes.requiredForCompletion',
    ],
    ['a non-object section', { photos: 3 }, 'photos'],
    ['a prototype-named top-level key', { constructor: 1 }, 'constructor'],
    ['a JSON-parsed __proto__ key', JSON.parse('{"__proto__":1}'), '__proto__'],
    ['a prototype-named nested key', { photos: { toString: 1 } }, 'photos.toString'],
  ])('rejects %s', (_name, raw, path) => {
    const body = invalid(raw);
    expect(body.statusCode).toBe(400);
    expect(body.code).toBe('TREATMENT_REQUIREMENTS_INVALID');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i) => i.includes(path))).toBe(true);
  });

  it.each([
    ['a string', 'x'],
    ['null', null],
    ['an array', []],
    ['a number', 5],
    ['undefined', undefined],
  ])('rejects %s as input', (_name, raw) => {
    const body = invalid(raw);
    expect(body.code).toBe('TREATMENT_REQUIREMENTS_INVALID');
    expect(body.issues).toHaveLength(1);
  });

  it('reports every issue at once', () => {
    const body = invalid({ foo: 1, photos: { minimumBefore: 99 } });
    expect(body.issues).toHaveLength(2);
  });
});
