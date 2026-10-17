import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { isValidTaxId, normalizeTaxId } from '../billing/invoice-customer';

export const IDENTIFICATION_TYPES = ['CEDULA', 'RUC', 'PASSPORT', 'OTHER'] as const;
export type IdentificationType = (typeof IDENTIFICATION_TYPES)[number];

export interface PatientIdentification {
  identificationType: string | null;
  identificationNumber: string | null;
}

const OTHER_PATTERN = /^[A-Z0-9]{3,30}$/;
export const ADULT_AGE = 18;

function invalid(message: string): never {
  throw new BadRequestException({
    statusCode: 400,
    code: 'PATIENT_IDENTIFICATION_INVALID',
    message,
  });
}

/**
 * Applies the identification fields present in `changes` over the stored ones and validates
 * the result. `undefined` keeps the stored value; an empty string or null clears it.
 */
export function mergePatientIdentification(
  current: PatientIdentification | null,
  changes: Partial<Record<keyof PatientIdentification, string | null | undefined>>,
): PatientIdentification {
  const pick = (field: keyof PatientIdentification) =>
    changes[field] === undefined ? (current?.[field] ?? null) : changes[field]?.trim() || null;

  const identificationType = pick('identificationType')?.toUpperCase() ?? null;
  const rawNumber = pick('identificationNumber');
  const identificationNumber = rawNumber ? normalizeTaxId(rawNumber) : null;

  if (!!identificationType !== !!identificationNumber) {
    invalid('Indica el tipo y el número de identificación del paciente.');
  }
  if (identificationType && identificationNumber) {
    if (!(IDENTIFICATION_TYPES as readonly string[]).includes(identificationType)) {
      invalid('El tipo de identificación debe ser CEDULA, RUC, PASSPORT u OTHER.');
    }
    const valid =
      identificationType === 'OTHER'
        ? OTHER_PATTERN.test(identificationNumber)
        : isValidTaxId(identificationType, identificationNumber);
    if (!valid) invalid('El número de identificación no tiene el formato de su tipo.');
  }
  return { identificationType, identificationNumber };
}

/** Whole years between the birth date and `today`, both read as calendar dates in UTC. */
export function ageInYears(dateOfBirth: Date, today: Date = new Date()): number {
  const years = today.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const hadBirthday =
    today.getUTCMonth() > dateOfBirth.getUTCMonth() ||
    (today.getUTCMonth() === dateOfBirth.getUTCMonth() &&
      today.getUTCDate() >= dateOfBirth.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/** A patient under 18 needs a legal guardian on file. */
export function assertGuardianForMinor(
  dateOfBirth: Date | null | undefined,
  guardianName: string | null | undefined,
  today: Date = new Date(),
): void {
  if (!dateOfBirth || guardianName?.trim()) return;
  if (ageInYears(dateOfBirth, today) < ADULT_AGE) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'PATIENT_GUARDIAN_REQUIRED',
      message: 'Un paciente menor de edad necesita un representante legal.',
    });
  }
}
