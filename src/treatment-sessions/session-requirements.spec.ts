import { UnprocessableEntityException } from '@nestjs/common';
import { ConsentDocumentStatus } from '@prisma/client';
import { DEFAULT_REQUIREMENTS, TreatmentRequirements } from '../treatments/treatment-requirements';
import {
  evaluateSession,
  isConsentApplicable,
  requirementsMissing,
  SessionFacts,
} from './session-requirements';

const ALL_REQUIRED: TreatmentRequirements = {
  medicalForm: { required: true },
  informedConsent: { required: true, validityDays: 30 },
  photos: { minimumBefore: 2, minimumAfter: 1 },
  clinicalNotes: { requiredForCompletion: true },
};
const SATISFIED: SessionFacts = {
  hasForm: true,
  hasApplicableConsent: true,
  beforePhotos: 2,
  afterPhotos: 1,
  hasNotes: true,
};

describe('evaluateSession', () => {
  it('reports nothing when every requirement is satisfied', () => {
    expect(evaluateSession(ALL_REQUIRED, SATISFIED)).toEqual({ start: [], complete: [] });
  });

  it.each([
    ['hasForm', { hasForm: false }, 'start', 'FINALIZED_MEDICAL_FORM'],
    ['hasApplicableConsent', { hasApplicableConsent: false }, 'start', 'SIGNED_APPLICABLE_CONSENT'],
    ['beforePhotos', { beforePhotos: 1 }, 'start', 'BEFORE_PHOTOS'],
    ['hasNotes', { hasNotes: false }, 'complete', 'CLINICAL_NOTES'],
    ['afterPhotos', { afterPhotos: 0 }, 'complete', 'AFTER_PHOTOS'],
  ] as const)('a missing %s yields only its code', (_name, patch, list, code) => {
    const result = evaluateSession(ALL_REQUIRED, { ...SATISFIED, ...patch });
    expect(result[list]).toEqual([code]);
    expect(result[list === 'start' ? 'complete' : 'start']).toEqual([]);
  });

  it('lists everything in the documented order when nothing is satisfied', () => {
    const none: SessionFacts = {
      hasForm: false,
      hasApplicableConsent: false,
      beforePhotos: 0,
      afterPhotos: 0,
      hasNotes: false,
    };
    expect(evaluateSession(ALL_REQUIRED, none)).toEqual({
      start: ['FINALIZED_MEDICAL_FORM', 'SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS'],
      complete: ['CLINICAL_NOTES', 'AFTER_PHOTOS'],
    });
  });

  it('reports nothing when nothing is required, even with zero facts', () => {
    const none: SessionFacts = {
      hasForm: false,
      hasApplicableConsent: false,
      beforePhotos: 0,
      afterPhotos: 0,
      hasNotes: false,
    };
    expect(evaluateSession(DEFAULT_REQUIREMENTS, none)).toEqual({ start: [], complete: [] });
  });
});

describe('isConsentApplicable', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-15T12:00:00.000Z');
  const signedAt = new Date(now.getTime() - 30 * DAY);
  const doc = (
    over: Partial<{
      status: ConsentDocumentStatus;
      signedAt: Date | null;
      templateVersionId: string;
    }> = {},
  ) => ({
    status: 'SIGNED' as ConsentDocumentStatus,
    signedAt,
    templateVersionId: 'v1',
    ...over,
  });
  const required = { templateVersionId: 'v1', validityDays: 30 as number | null };

  it('is true for a signed document of the same session regardless of age', () => {
    const old = doc({ signedAt: new Date(now.getTime() - 5000 * DAY) });
    expect(isConsentApplicable(old, { ...required, validityDays: null }, now, true)).toBe(true);
  });

  it('is true at exactly validityDays days', () => {
    expect(isConsentApplicable(doc(), required, now, false)).toBe(true);
  });

  it('is false one millisecond past validityDays', () => {
    const late = doc({ signedAt: new Date(signedAt.getTime() - 1) });
    expect(isConsentApplicable(late, required, now, false)).toBe(false);
  });

  it('is false on another session when validityDays is null', () => {
    expect(isConsentApplicable(doc(), { ...required, validityDays: null }, now, false)).toBe(false);
  });

  it.each(['REVOKED', 'REFUSED', 'PRESENTED'] as ConsentDocumentStatus[])(
    'is false for a %s document',
    (status) => {
      expect(isConsentApplicable(doc({ status }), required, now, true)).toBe(false);
      expect(isConsentApplicable(doc({ status }), required, now, false)).toBe(false);
    },
  );

  it('is false for another template version', () => {
    expect(isConsentApplicable(doc({ templateVersionId: 'v2' }), required, now, true)).toBe(false);
  });

  it('is false for a signed document without a signedAt on another session', () => {
    expect(isConsentApplicable(doc({ signedAt: null }), required, now, false)).toBe(false);
  });
});

describe('requirementsMissing', () => {
  it('builds a 422 with the missing codes', () => {
    const error = requirementsMissing(['BEFORE_PHOTOS']);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      statusCode: 422,
      code: 'TREATMENT_REQUIREMENTS_MISSING',
      message: 'La atención no cumple los requisitos del tratamiento.',
      missing: ['BEFORE_PHOTOS'],
    });
  });
});
