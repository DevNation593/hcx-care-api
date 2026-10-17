import { BadRequestException } from '@nestjs/common';

/** What a treatment demands before a session may start and before it may be completed. */
export interface TreatmentRequirements {
  medicalForm: { required: boolean };
  informedConsent: { required: boolean; validityDays: number | null };
  photos: { minimumBefore: number; minimumAfter: number };
  clinicalNotes: { requiredForCompletion: boolean };
}

export const DEFAULT_REQUIREMENTS: TreatmentRequirements = {
  medicalForm: { required: false },
  informedConsent: { required: false, validityDays: null },
  photos: { minimumBefore: 0, minimumAfter: 0 },
  clinicalNotes: { requiredForCompletion: false },
};

// Own keys only: `in` would also accept prototype names such as `constructor`.
const SECTION_KEYS = Object.keys(DEFAULT_REQUIREMENTS);

const MAX_PHOTOS = 20;
const MAX_VALIDITY_DAYS = 3650;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates a stored or submitted requirements document, filling missing keys with the
 * defaults. Throws 400 TREATMENT_REQUIREMENTS_INVALID listing every issue found.
 */
export function parseTreatmentRequirements(raw: unknown): TreatmentRequirements {
  const issues: string[] = [];

  if (!isPlain(raw)) {
    throw invalid(['Los requisitos deben ser un objeto.']);
  }

  const section = (key: keyof TreatmentRequirements, allowed: string[]): Plain => {
    const value = raw[key];
    if (value === undefined) return {};
    if (!isPlain(value)) {
      issues.push(`${key} debe ser un objeto`);
      return {};
    }
    for (const extra of Object.keys(value).filter((k) => !allowed.includes(k))) {
      issues.push(`${key}.${extra} no es un campo permitido`);
    }
    return value;
  };

  const bool = (value: unknown, path: string, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      issues.push(`${path} debe ser verdadero o falso`);
      return fallback;
    }
    return value;
  };

  const int = (
    value: unknown,
    path: string,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      issues.push(`${path} debe ser un entero entre ${min} y ${max}`);
      return fallback;
    }
    return value;
  };

  for (const unknownKey of Object.keys(raw).filter((k) => !SECTION_KEYS.includes(k))) {
    issues.push(`${unknownKey} no es un campo permitido`);
  }

  const medicalForm = section('medicalForm', ['required']);
  const informedConsent = section('informedConsent', ['required', 'validityDays']);
  const photos = section('photos', ['minimumBefore', 'minimumAfter']);
  const clinicalNotes = section('clinicalNotes', ['requiredForCompletion']);

  const parsed: TreatmentRequirements = {
    medicalForm: {
      required: bool(
        medicalForm.required,
        'medicalForm.required',
        DEFAULT_REQUIREMENTS.medicalForm.required,
      ),
    },
    informedConsent: {
      required: bool(
        informedConsent.required,
        'informedConsent.required',
        DEFAULT_REQUIREMENTS.informedConsent.required,
      ),
      validityDays:
        informedConsent.validityDays === undefined || informedConsent.validityDays === null
          ? null
          : int(
              informedConsent.validityDays,
              'informedConsent.validityDays',
              1,
              MAX_VALIDITY_DAYS,
              1,
            ),
    },
    photos: {
      minimumBefore: int(
        photos.minimumBefore,
        'photos.minimumBefore',
        0,
        MAX_PHOTOS,
        DEFAULT_REQUIREMENTS.photos.minimumBefore,
      ),
      minimumAfter: int(
        photos.minimumAfter,
        'photos.minimumAfter',
        0,
        MAX_PHOTOS,
        DEFAULT_REQUIREMENTS.photos.minimumAfter,
      ),
    },
    clinicalNotes: {
      requiredForCompletion: bool(
        clinicalNotes.requiredForCompletion,
        'clinicalNotes.requiredForCompletion',
        DEFAULT_REQUIREMENTS.clinicalNotes.requiredForCompletion,
      ),
    },
  };

  if (issues.length > 0) throw invalid(issues);
  return parsed;
}

function invalid(issues: string[]): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'TREATMENT_REQUIREMENTS_INVALID',
    message: 'Los requisitos del tratamiento no son válidos.',
    issues,
  });
}
